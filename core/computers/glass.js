// @ts-check
// glass: the RFB relay behind /v1/streams/computers/glass (ADR 0003).
//
// To the agent's container Glass is a VNC client that knows the password; to the browser it is
// a VNC server that asks for none, because the ticket already said who the viewer is. Between
// the two handshakes it is a plain byte relay, except that the client-to-server stream (the
// browser's keystrokes and clicks) is parsed message by message so input can be dropped from
// any surface that does not hold the keyboard (keyboard.canType). Nothing here draws a pixel:
// that is rfb.js's job for RFB and ws.js's for the WebSocket framing browsers speak instead of
// raw TCP.
//
// Ordering, per ADR 0003 "How it works": the ticket is spent before the WebSocket handshake
// completes ("a used or expired ticket gets a 403 before any byte of RFB"); an open connection
// counts as needing to look, so it holds the checkout (pool.viewer) for as long as it lasts; an
// unparseable client message closes the connection, because a stream Glass cannot follow is one
// it cannot gate. A ticket marked slow (the viewer is relayed or far away, per link.health) has
// its incremental update requests paced to 5 a second (Pacer); nothing else is held back.

import net from "node:net";
import { Bytes, ClientParser, INPUT, clientHandshake, serverHandshake } from "./rfb.js";
import { acceptKey, encodeFrame, FrameParser } from "./ws.js";

/** @param {import("node:net").Socket} socket @param {number} status @param {string} reason */
function reject(socket, status, reason) {
  try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); } catch {}
}

/** Never let a password or token ride an error message up to a log line. */
function scrub(msg, ...secrets) {
  let s = String(msg == null ? "an error" : msg);
  for (const secret of secrets) if (secret) s = s.split(String(secret)).join("[redacted]");
  return s;
}

/** How often a viewer on a slow link may ask for an incremental update: every 200 ms, 5 fps. */
export const SLOW_EVERY = 200;

/** A FramebufferUpdateRequest (message type 3) with its incremental flag set. */
const isIncremental = (/** @type {{ type: number, bytes: Buffer }} */ m) => m.type === 3 && m.bytes.length >= 2 && m.bytes[1] !== 0;

/**
 * Paces a slow viewer's incremental FramebufferUpdateRequests. Xvnc answers each request with
 * whatever changed, so a request held back is fewer frames on the wire. Only the latest pending
 * request is kept (a newer one says the same thing), and it goes out when the window opens, from
 * one timer at a time that close() clears.
 */
export class Pacer {
  /**
   * @param {(bytes: Buffer) => void} send
   * @param {{ every?: number, now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [opts]
   */
  constructor(send, { every = SLOW_EVERY, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.send = send;
    this.every = every;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.last = -Infinity;
    /** @type {Buffer|null} */
    this.pending = null;
    /** @type {any} */
    this.timer = null;
    this.closed = false;
  }

  /** @param {Buffer} bytes one incremental FramebufferUpdateRequest */
  push(bytes) {
    if (this.closed) return;
    const t = this.now();
    if (!this.timer && t - this.last >= this.every) { this.last = t; this.send(bytes); return; }
    this.pending = bytes;
    if (!this.timer) {
      this.timer = this.setTimer(() => this.fire(), Math.max(0, this.every - (t - this.last)));
      this.timer?.unref?.();
    }
  }

  fire() {
    this.timer = null;
    if (this.closed || !this.pending) return;
    const b = this.pending;
    this.pending = null;
    this.last = this.now();
    this.send(b);
  }

  close() {
    this.closed = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

export class Glass {
  /**
   * @param {{ pool: import("./pool.js").Pool, keyboard: import("./keyboard.js").Keyboard, log?: (m: string) => void }} deps
   */
  constructor({ pool, keyboard, log }) {
    this.pool = pool;
    this.keyboard = keyboard;
    this.log = log || (() => {});
    /** @type {Set<import("node:net").Socket>} */
    this.sockets = new Set();
  }

  /** The upgrade handler index.js registers at ctx.upgrade("glass", ...). Never throws. */
  handle(req, socket, head, info) {
    this.connect(req, socket, head, info).catch(e => {
      this.log(`glass: ${scrub(e && e.message)}`);
      try { socket.destroy(); } catch {}
    });
  }

  /** @param {any} req @param {import("node:net").Socket} socket @param {Buffer} head @param {{ url?: URL }} [info] */
  async connect(req, socket, head, info) {
    const url = (info && info.url) || new URL(req.url || "/", "http://vyred");
    const redeemed = this.pool.redeem(url.searchParams.get("ticket"));
    if (!redeemed) { reject(socket, 403, "Forbidden"); return; }
    const { agent, surface } = redeemed;
    // The viewer's link is relayed or slow (glass.open asked link.health): pace its frames.
    const slow = Boolean(/** @type {any} */ (redeemed).slow);

    const key = req.headers && req.headers["sec-websocket-key"];
    const upgrade = req.headers && String(req.headers["upgrade"] || "").toLowerCase();
    if (upgrade !== "websocket" || !key) { reject(socket, 400, "Bad Request"); return; }

    // Past this point the ticket is spent either way: accept the WebSocket so the browser gets
    // a clean close instead of a hung connection if anything after here fails.
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));

    const offered = req.headers && req.headers["sec-websocket-protocol"];
    const protoLine = offered && String(offered).split(",").map(s => s.trim()).includes("binary")
      ? "Sec-WebSocket-Protocol: binary\r\n" : "";
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n${protoLine}\r\n`);

    let closed = false;
    let viewerHeld = false;
    /** The keepalive: a ping every 30 s, closed after two missed pongs (ADR 0005, decision 1). */
    let pinger = /** @type {ReturnType<typeof setInterval>|null} */ (null);
    let missed = 0;
    /** @type {import("node:net").Socket|null} */
    let xvnc = null;
    /** @type {Pacer|null} */
    let pacer = null;
    const closeAll = (/** @type {string} */ why) => {
      if (closed) return;
      closed = true;
      if (pinger) { clearInterval(pinger); pinger = null; }
      if (pacer) { pacer.close(); pacer = null; }
      if (viewerHeld) { viewerHeld = false; try { this.pool.viewer(agent, -1); } catch {} }
      try { socket.destroy(); } catch {}
      if (xvnc) try { xvnc.destroy(); } catch {}
      if (why) this.log(`glass: ${agent}/${surface} ended (${scrub(why)})`);
    };

    // Frame the browser's bytes into WebSocket messages as they arrive, from the very first
    // chunk (the `head` bytes the HTTP parser had already read past the headers). This queue
    // feeds the RFB handshake reads below; whatever is left over after the handshake is not
    // lost (Bytes.rest()), so nothing typed while we were still dialling the container drops.
    const parser = new FrameParser();
    const browserBytes = new Bytes();
    const onBrowserData = (/** @type {Buffer} */ chunk) => {
      if (closed) return;
      let frames;
      try { frames = parser.push(chunk); }
      catch (e) { closeAll(/** @type {Error} */ (e).message); return; }
      for (const f of frames) {
        if ("control" in f) {
          if (f.control === "close") { closeAll("the browser closed the stream"); return; }
          if (f.control === "ping") { try { socket.write(encodeFrame(f.payload, 0xa)); } catch {} }
          continue;
        }
        browserBytes.push(f.message);
      }
    };
    socket.on("data", onBrowserData);
    socket.on("close", () => closeAll("the browser's connection closed"));
    socket.on("error", e => closeAll(e.message));
    if (head && head.length) onBrowserData(head);

    // The computer has to be running before Xvnc can be dialled; this checkout is what "an open
    // Glass viewer holds the screen" means (pool.viewer), and it lasts until this connection ends.
    try { await this.pool.viewer(agent, 1); viewerHeld = true; }
    catch (e) { closeAll(/** @type {Error} */ (e).message); return; }
    if (closed) return;

    const vnc = this.pool.vnc(agent);
    if (!vnc) { closeAll(`${agent}'s computer is not running`); return; }

    xvnc = net.connect(vnc.port, vnc.host);
    this.sockets.add(xvnc);
    const xvncBytes = new Bytes();
    xvnc.on("data", b => xvncBytes.push(b));
    xvnc.on("close", () => closeAll("the computer's screen closed"));
    xvnc.on("error", e => closeAll(scrub(e.message, vnc.password)));

    /** @type {{ bytes: Buffer }} */
    let init;
    try {
      init = await clientHandshake(xvncBytes, b => /** @type {import("node:net").Socket} */ (xvnc).write(b), vnc.password);
      await serverHandshake(browserBytes, b => socket.write(encodeFrame(b)), init.bytes);
    } catch (e) {
      closeAll(scrub(/** @type {Error} */ (e).message, vnc.password));
      return;
    }
    if (closed) return;

    // The handshakes are done; from here the streams are a relay, gated one way only. Whatever
    // each side already sent beyond the handshake (Bytes.rest()) goes first, so nothing that
    // arrived early is skipped.
    const clientParser = new ClientParser();
    const toXvnc = (/** @type {Buffer} */ b) => {
      if (closed) return;
      try { /** @type {import("node:net").Socket} */ (xvnc).write(b); }
      catch (e) { closeAll(/** @type {Error} */ (e).message); }
    };
    if (slow) pacer = new Pacer(toXvnc);
    const forwardClient = (/** @type {Buffer} */ bytes) => {
      if (!bytes.length || closed) return;
      let msgs;
      try { msgs = clientParser.push(bytes); }
      catch (e) { closeAll(/** @type {Error} */ (e).message); return; }
      for (const m of msgs) {
        if (INPUT.has(m.type)) {
          if (!this.keyboard.canType(agent, surface)) continue;
          // The holder is at the keyboard: that keeps the take-over alive.
          this.keyboard.renew?.(agent, surface);
        }
        // On a slow link only incremental update requests wait; input and a full-frame request
        // (the viewer has lost its picture) always go straight through.
        if (pacer && isIncremental(m)) { pacer.push(m.bytes); continue; }
        try { /** @type {import("node:net").Socket} */ (xvnc).write(m.bytes); }
        catch (e) { closeAll(/** @type {Error} */ (e).message); return; }
      }
    };
    forwardClient(browserBytes.rest());

    xvnc.removeAllListeners("data");
    xvnc.on("data", b => { if (!closed) try { socket.write(encodeFrame(b)); } catch (e) { closeAll(/** @type {Error} */ (e).message); } });
    const early = xvncBytes.rest();
    if (early.length && !closed) try { socket.write(encodeFrame(early)); } catch (e) { closeAll(/** @type {Error} */ (e).message); }

    // Browsers answer pings on their own; a half-open socket (a phone that lost its signal) does
    // not, and would otherwise hold the viewer, and the take-over, forever.
    pinger = setInterval(() => {
      if (closed) return;
      if (missed >= 2) { closeAll("two pings went unanswered"); return; }
      missed += 1;
      try { socket.write(encodeFrame(Buffer.alloc(0), 0x9)); } catch (e) { closeAll(/** @type {Error} */ (e).message); }
    }, 30_000);
    pinger.unref();

    // From here on a decoded WebSocket message is client input, not more handshake: route it
    // to the gate instead of the Bytes queue the handshake read from.
    socket.removeAllListeners("data");
    socket.on("data", (/** @type {Buffer} */ chunk) => {
      if (closed) return;
      let frames;
      try { frames = parser.push(chunk); }
      catch (e) { closeAll(/** @type {Error} */ (e).message); return; }
      for (const f of frames) {
        if ("control" in f) {
          if (f.control === "close") { closeAll("the browser closed the stream"); return; }
          if (f.control === "ping") { try { socket.write(encodeFrame(f.payload, 0xa)); } catch {} }
          if (f.control === "pong") { missed = 0; this.keyboard.renew?.(agent, surface); }
          continue;
        }
        forwardClient(f.message);
      }
    });
  }

  /** Ends every open connection. index.js calls this on shutdown so nothing outlives vyred. */
  async stop() {
    for (const s of [...this.sockets]) { try { s.destroy(); } catch {} }
    this.sockets.clear();
  }
}
