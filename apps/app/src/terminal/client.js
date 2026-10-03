// client: the term socket protocol with byte offsets, and reconnecting from the last offset (core/term/index.js is the spec).
//
// Binary frames are what the terminal prints; every byte moves `offset` on. Text frames from the box:
//   {"t":"at","offset":n}     the box's count after the last byte sent; adopted
//   {"t":"cut","from","asked"} bytes after our offset left the box's ring: the replay starts at `from`; onCut() clears the screen
//   {"t":"size","cols","rows","owner"}  the pty's size and whether this socket owns it
// Sent: {"t":"in","d"}, {"t":"size","cols","rows"}, {"t":"take"}. Keys typed while away are held (4 KB) and sent after reattaching.
//
// Same shape as the resumable client core/stream gives the session stream (a `last` the client holds, a replay from it,
// nothing acked); this one is local until that one lands, and the term protocol is not the stream's frames.
//
// new TermClient({ getTicket, WebSocket, onBytes, onState, onSize, onCut })
//   getTicket(from) -> Promise<{ url }>  a fresh one-use ticket as a ws(s) URL that already carries from=<from>
//   WebSocket: the constructor (global in browsers and Node 22)

export const HOLD_MAX = 4096;
const BACKOFF = [250, 500, 1000, 2000, 4000, 8000];

export class TermClient {
  /** @param {any} o */
  constructor(o) {
    this.o = o;
    this.WS = o.WebSocket || globalThis.WebSocket;
    this.offset = 0;
    this.ws = null;
    this.stopped = false;
    this.tries = 0;
    this.held = "";
    this.size = null;
    this.owner = false;
    this.state = "idle";
    this.timer = null;
    this.timers = o.timers || { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) };
  }

  setState(s, extra = {}) {
    this.state = s;
    this.o.onState && this.o.onState({ state: s, offset: this.offset, owner: this.owner, ...extra });
  }

  /** Open the socket from the current offset. Safe to call again after a drop; one socket at a time. */
  async connect() {
    if (this.stopped || this.ws) return;
    this.setState(this.tries ? "reconnecting" : "connecting");
    let url;
    try { url = (await this.o.getTicket(this.offset)).url; }
    catch (e) { this.retry(); return; }
    if (this.stopped) return;
    const ws = new this.WS(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    // A frame we meet is about the socket that sent it; a stale socket's frames are dropped.
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.tries = 0;
      this.setState("live");
      if (this.size) this.sendRaw({ t: "size", cols: this.size.cols, rows: this.size.rows });
      if (this.held) { const h = this.held; this.held = ""; this.sendRaw({ t: "in", d: h }); }
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this.frame(ev.data); };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      // 1000 is the box saying the terminal ended (exited, closed, or kept too long): reconnecting would find nothing.
      if (ev && ev.code === 1000) { this.setState("ended", { reason: ev.reason || "" }); this.stopped = true; return; }
      this.retry();
    };
    ws.onerror = () => {};
  }

  retry() {
    if (this.stopped) return;
    this.setState("reconnecting");
    const ms = BACKOFF[Math.min(this.tries, BACKOFF.length - 1)];
    this.tries++;
    this.timer = this.timers.set(() => { this.timer = null; this.connect(); }, ms);
  }

  /** One message from the box. @param {ArrayBuffer|string|Uint8Array} data */
  frame(data) {
    if (typeof data === "string") {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.t === "at" && Number.isSafeInteger(m.offset)) {
        this.offset = m.offset;
        this.o.onState && this.o.onState({ state: this.state, offset: this.offset, owner: this.owner });
      } else if (m.t === "cut") {
        // What we had after `asked` is gone; the replay that follows starts at m.from.
        this.offset = m.from;
        this.o.onCut && this.o.onCut(m);
      } else if (m.t === "size") {
        this.owner = Boolean(m.owner);
        this.o.onSize && this.o.onSize({ cols: m.cols, rows: m.rows, owner: this.owner });
        this.setState(this.state);
      }
      return;
    }
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.offset += u8.length;
    this.o.onBytes && this.o.onBytes(u8);
  }

  sendRaw(m) { try { this.ws.send(JSON.stringify(m)); } catch {} }

  get open() { return Boolean(this.ws && this.ws.readyState === 1); }

  /** Keys. While the socket is away they are held, up to 4 KB, and sent after reattaching. @param {string} d */
  input(d) {
    if (this.open) this.sendRaw({ t: "in", d });
    else this.held = (this.held + d).slice(-HOLD_MAX);
  }

  /** The terminal's size on this screen (cols and rows). Only the owner's resizes the pty; the box remembers ours either way. */
  resize(cols, rows) {
    this.size = { cols, rows };
    if (this.open) this.sendRaw({ t: "size", cols, rows });
  }

  /** Make this screen the one that sizes the terminal. */
  take() {
    if (this.open) this.sendRaw({ t: "take", ...(this.size || {}) });
  }

  /** Reconnect now (the app came to the front, the network came back): skips the wait. */
  nudge() {
    if (this.stopped || this.ws) return;
    if (this.timer) { this.timers.clear(this.timer); this.timer = null; }
    this.connect();
  }

  close() {
    this.stopped = true;
    if (this.timer) { this.timers.clear(this.timer); this.timer = null; }
    const ws = this.ws; this.ws = null;
    try { ws && ws.close(); } catch {}
    this.setState("closed");
  }
}
