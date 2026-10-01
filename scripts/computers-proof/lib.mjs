// Small test-side clients for the proof: HTTP to vyred's unix socket, a WebSocket client over that
// socket (masked frames, as a browser sends them), an RFB client that speaks what Glass offers a
// browser (RFB 3.8, security None), and a PNG writer. No dependencies. Nothing here is Vyre's
// own code on purpose: it stands in for the Deck's noVNC, so the relay is judged from outside.

import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";

/** One tool call over vyred's socket, as `caller` (a person's label such as "cli"). */
export function callSocket(socketPath, tool, input = {}, caller = "cli") {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(input));
    const req = http.request({ socketPath, method: "POST", path: `/v1/tools/${encodeURIComponent(tool)}`,
      headers: { "content-type": "application/json", "content-length": body.length, "x-vyre-caller": caller } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => { let j; try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { j = { error: { message: "not json" } }; } resolve({ status: res.statusCode, ...j }); });
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** A byte queue with async exact reads. */
class Queue {
  constructor() { this.buf = Buffer.alloc(0); this.waiters = []; this.closed = false; }
  push(b) { this.buf = Buffer.concat([this.buf, b]); this.wake(); }
  close() { this.closed = true; this.wake(); }
  wake() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  async read(n) {
    while (this.buf.length < n) {
      if (this.closed) throw new Error("stream closed");
      await new Promise(r => this.waiters.push(r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

/** A WebSocket over a unix socket path. Binary messages go to `.queue`; `.closeCode` is set on a close frame. */
export function wsConnect(socketPath, path) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const queue = new Queue();
    const state = { sock, queue, closeCode: null, status: 0, pings: 0 };
    let head = Buffer.alloc(0), upgraded = false, frames = Buffer.alloc(0);
    const send = (payload, opcode = 2) => {
      const mask = crypto.randomBytes(4);
      const n = payload.length;
      const hdr = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 255]) : null;
      if (!hdr) throw new Error("frame too large for this test client");
      const body = Buffer.alloc(n);
      for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i % 4];
      sock.write(Buffer.concat([hdr, mask, body]));
    };
    state.send = send;
    state.close = () => { try { send(Buffer.alloc(0), 8); } catch {} try { sock.end(); } catch {} };
    const parse = () => {
      for (;;) {
        if (frames.length < 2) return;
        const op = frames[0] & 15;
        let len = frames[1] & 127, off = 2;
        if (len === 126) { if (frames.length < 4) return; len = frames.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (frames.length < 10) return; len = Number(frames.readBigUInt64BE(2)); off = 10; }
        if (frames.length < off + len) return;
        const payload = frames.subarray(off, off + len);
        frames = frames.subarray(off + len);
        if (op === 2 || op === 0) queue.push(Buffer.from(payload));
        else if (op === 8) { state.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; state.closeReason = payload.subarray(2).toString(); }
        else if (op === 9) { state.pings++; send(Buffer.from(payload), 10); }
      }
    };
    sock.on("data", d => {
      if (upgraded) { frames = Buffer.concat([frames, d]); parse(); return; }
      head = Buffer.concat([head, d]);
      const at = head.indexOf("\r\n\r\n");
      if (at < 0) return;
      const line = head.subarray(0, head.indexOf("\r\n")).toString();
      state.status = Number(line.split(" ")[1]);
      if (state.status !== 101) { sock.destroy(); reject(new Error(`upgrade refused: ${line}`)); return; }
      upgraded = true;
      frames = head.subarray(at + 4);
      resolve(state);
      parse();
    });
    sock.on("close", () => { queue.close(); if (!upgraded) reject(new Error("closed before the upgrade")); });
    sock.on("error", e => { if (!upgraded) reject(e); });
    sock.write(`GET ${path} HTTP/1.1\r\nHost: vyred\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\nx-vyre-caller: cli\r\n\r\n`);
  });
}

/** An RFB client over a wsConnect state: the noVNC role. */
export class RfbClient {
  constructor(ws) { this.ws = ws; this.q = ws.queue; this.w = 0; this.h = 0; this.fb = null; this.updates = 0; this.name = ""; this.pump = null; }
  async handshake() {
    const ver = (await this.q.read(12)).toString();
    if (!/^RFB 003\.00[3-8]\n$/.test(ver)) throw new Error(`not RFB: ${JSON.stringify(ver)}`);
    this.ws.send(Buffer.from("RFB 003.008\n"));
    const n = (await this.q.read(1))[0];
    if (n === 0) { const l = (await this.q.read(4)).readUInt32BE(0); throw new Error("server refused: " + (await this.q.read(l)).toString()); }
    const types = [...(await this.q.read(n))];
    if (!types.includes(1)) throw new Error(`security type None not offered: ${types}`);
    this.securityTypes = types;
    this.ws.send(Buffer.from([1]));
    const res = (await this.q.read(4)).readUInt32BE(0);
    if (res !== 0) throw new Error("security result " + res);
    this.ws.send(Buffer.from([1])); // ClientInit: shared
    const init = await this.q.read(24);
    this.w = init.readUInt16BE(0); this.h = init.readUInt16BE(2);
    this.serverFormat = { bpp: init[4], depth: init[5], bigEndian: init[6], trueColour: init[7] };
    this.name = (await this.q.read(init.readUInt32BE(20))).toString();
    // 32 bpp, little endian, true colour, R<<16 G<<8 B: bytes are B G R X.
    const pf = Buffer.alloc(20); pf[0] = 0;
    pf[4] = 32; pf[5] = 24; pf[6] = 0; pf[7] = 1; pf.writeUInt16BE(255, 8); pf.writeUInt16BE(255, 10); pf.writeUInt16BE(255, 12); pf[14] = 16; pf[15] = 8; pf[16] = 0;
    this.ws.send(pf);
    const enc = Buffer.alloc(8); enc[0] = 2; enc.writeUInt16BE(1, 2); enc.writeInt32BE(0, 4); // Raw only
    this.ws.send(enc);
    this.fb = Buffer.alloc(this.w * this.h * 4);
    this.pump = this.run().catch(() => {});
    this.waiting = [];
  }
  async run() {
    for (;;) {
      const t = (await this.q.read(1))[0];
      if (t === 0) {
        const hd = await this.q.read(3);
        const n = hd.readUInt16BE(1);
        for (let i = 0; i < n; i++) {
          const r = await this.q.read(12);
          const x = r.readUInt16BE(0), y = r.readUInt16BE(2), w = r.readUInt16BE(4), h = r.readUInt16BE(6), e = r.readInt32BE(8);
          if (e !== 0) throw new Error(`unexpected encoding ${e}`);
          const data = await this.q.read(w * h * 4);
          for (let row = 0; row < h; row++) data.copy(this.fb, ((y + row) * this.w + x) * 4, row * w * 4, (row + 1) * w * 4);
        }
        this.updates++;
        const ws = this.waiting; this.waiting = []; for (const f of ws) f();
      } else if (t === 1) { const hd = await this.q.read(5); const c = hd.readUInt16BE(3); await this.q.read(c * 6); }
      else if (t === 2) { /* bell */ }
      else if (t === 3) { await this.q.read(3); const l = (await this.q.read(4)).readUInt32BE(0); await this.q.read(l); }
      else throw new Error(`unknown server message ${t}`);
    }
  }
  /** Ask for a frame and wait for it (up to ms). Returns whether one arrived. */
  async refresh(incremental = false, ms = 15000) {
    const before = this.updates;
    const m = Buffer.alloc(10); m[0] = 3; m[1] = incremental ? 1 : 0; m.writeUInt16BE(this.w, 6); m.writeUInt16BE(this.h, 8);
    this.ws.send(m);
    const t0 = Date.now();
    while (this.updates === before && Date.now() - t0 < ms) await new Promise(r => { this.waiting.push(r); setTimeout(r, 200); });
    return this.updates > before;
  }
  key(sym, down) { const m = Buffer.alloc(8); m[0] = 4; m[1] = down ? 1 : 0; m.writeUInt32BE(sym, 4); this.ws.send(m); }
  pointer(x, y, mask = 0) { const m = Buffer.alloc(6); m[0] = 5; m[1] = mask; m.writeUInt16BE(x, 2); m.writeUInt16BE(y, 4); this.ws.send(m); }
  click(x, y) { this.pointer(x, y, 0); this.pointer(x, y, 1); this.pointer(x, y, 0); }
  /** Type text as keysyms; "\n" is Return. */
  async type(text, gapMs = 25) {
    for (const ch of text) {
      const sym = ch === "\n" ? 0xff0d : ch.codePointAt(0);
      const shift = /[A-Z!@#$%^&*()_+{}|:"<>?~]/.test(ch);
      if (shift) this.key(0xffe1, true);
      this.key(sym, true); this.key(sym, false);
      if (shift) this.key(0xffe1, false);
      await new Promise(r => setTimeout(r, gapMs));
    }
  }
  nonZeroPixels() { let n = 0; for (let i = 0; i < this.fb.length; i += 4) if (this.fb[i] | this.fb[i + 1] | this.fb[i + 2]) n++; return n; }
  distinctColours() { const s = new Set(); for (let i = 0; i < this.fb.length; i += 4 * 97) s.add(this.fb.readUInt32LE(i) & 0xffffff); return s.size; }
  png() { return encodePng(this.w, this.h, this.fb); }
}

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** BGRX framebuffer to an RGB PNG. */
export function encodePng(w, h, bgrx) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = y * (w * 3 + 1) + 1 + x * 3; raw[d] = bgrx[s + 2]; raw[d + 1] = bgrx[s + 1]; raw[d + 2] = bgrx[s]; }
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 3 })), chunk("IEND", Buffer.alloc(0))]);
}
