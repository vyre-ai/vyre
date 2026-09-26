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
// it cannot gate.

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
    /** @type {import("node:net").Socket|null} */
    let xvnc = null;
    const closeAll = (/** @type {string} */ why) => {
      if (closed) return;
      closed = true;
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
    const forwardClient = (/** @type {Buffer} */ bytes) => {
      if (!bytes.length || closed) return;
      let msgs;
      try { msgs = clientParser.push(bytes); }
      catch (e) { closeAll(/** @type {Error} */ (e).message); return; }
      for (const m of msgs) {
        if (INPUT.has(m.type) && !this.keyboard.canType(agent, surface)) continue;
        try { /** @type {import("node:net").Socket} */ (xvnc).write(m.bytes); }
        catch (e) { closeAll(/** @type {Error} */ (e).message); return; }
      }
    };
    forwardClient(browserBytes.rest());

    xvnc.removeAllListeners("data");
    xvnc.on("data", b => { if (!closed) try { socket.write(encodeFrame(b)); } catch (e) { closeAll(/** @type {Error} */ (e).message); } });
    const early = xvncBytes.rest();
    if (early.length && !closed) try { socket.write(encodeFrame(early)); } catch (e) { closeAll(/** @type {Error} */ (e).message); }

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
