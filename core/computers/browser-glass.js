// @ts-check
// browser-glass: headless screencast relay for /v1/streams/computers/browser-glass (agent-browsers.md).
//
// Same ticket shape as the VNC glass relay, but frames come from Page.startScreencast on the
// agent's tab inside its browser context, and take-over input goes through CDP Input.* when the
// surface holds the keyboard.

import { STOPPED, UNKNOWN } from "./pool.js";
import { encodeFrame, FrameParser, upgradeHead } from "../../lib/ws.js";
import { scrub as scrubText } from "../../lib/scrub.js";

/** @param {import("node:net").Socket} socket @param {number} status @param {string} reason */
function reject(socket, status, reason) {
  try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); } catch {}
}

/** @param {import("node:net").Socket} socket @param {number} code @param {string} reason */
export function closeWith(socket, code, reason) {
  let r = Buffer.from(String(reason || ""), "utf8");
  if (r.length > 123) r = Buffer.from(r.subarray(0, 123).toString("utf8").replace(/\uFFFD+$/, ""), "utf8");
  const payload = Buffer.alloc(2 + r.length);
  payload.writeUInt16BE(code, 0);
  r.copy(payload, 2);
  try { socket.write(encodeFrame(payload, 0x8)); } catch {}
}

function scrub(msg, ...secrets) { return scrubText(msg == null ? "an error" : msg, secrets.filter(Boolean).map(String), { marker: "[redacted]", min: 1 }); }

export class BrowserGlass {
  /**
   * @param {{ pool: import("./pool.js").Pool, agentBrowser: import("./agent-browser.js").AgentBrowser,
   *   keyboard: import("./keyboard.js").Keyboard, log?: (m: string) => void }} deps
   */
  constructor({ pool, agentBrowser, keyboard, log }) {
    this.pool = pool;
    this.agentBrowser = agentBrowser;
    this.keyboard = keyboard;
    this.log = log || (() => {});
    /** @type {Set<import("node:net").Socket>} */
    this.sockets = new Set();
  }

  handle(req, socket, head, info) {
    this.connect(req, socket, head, info).catch(e => {
      this.log(`browser-glass: ${scrub(e && e.message)}`);
      try { socket.destroy(); } catch {}
    });
  }

  /** @param {any} req @param {import("node:net").Socket} socket @param {Buffer} head @param {{ url?: URL }} [info] */
  async connect(req, socket, head, info) {
    const url = (info && info.url) || new URL(req.url || "/", "http://vyred");
    const redeemed = this.pool.redeem(url.searchParams.get("ticket"));
    if (!redeemed) { reject(socket, 403, "Forbidden"); return; }
    const { agent, surface } = redeemed;
    this.log(`browser-glass: ${agent}/${surface} opening`);

    const key = req.headers && req.headers["sec-websocket-key"];
    const upgrade = req.headers && String(req.headers["upgrade"] || "").toLowerCase();
    if (upgrade !== "websocket" || !key) { reject(socket, 400, "Bad Request"); return; }

    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));

    const offered = req.headers && req.headers["sec-websocket-protocol"];
    const protoLine = offered && String(offered).split(",").map(s => s.trim()).includes("binary")
      ? "Sec-WebSocket-Protocol: binary\r\n" : "";
    socket.write(upgradeHead(key, protoLine));

    let closed = false;
    let viewerHeld = false;
    /** @type {import("../../lib/cdp.js").Cdp|null} */
    let cdp = null;
    /** @type {string|null} */
    let sessionId = null;
    let screencastOn = false;

    const sendJson = (/** @type {any} */ obj) => {
      if (closed) return;
      try { socket.write(encodeFrame(Buffer.from(JSON.stringify(obj), "utf8"), 0x1)); } catch {}
    };

    const closeAll = (/** @type {string} */ why, flush = false) => {
      if (closed) return;
      closed = true;
      if (viewerHeld) {
        viewerHeld = false;
        try { this.agentBrowser.viewer(agent, -1); } catch {}
      }
      if (screencastOn && cdp && sessionId) {
        cdp.send("Page.stopScreencast", {}, sessionId).catch(() => {});
        screencastOn = false;
      }
      if (cdp) cdp.close().catch(() => {});
      cdp = null;
      try { if (flush) socket.end(); else socket.destroy(); } catch {}
      if (why) this.log(`browser-glass: ${agent}/${surface} ended (${scrub(why)})`);
    };

    const parser = new FrameParser();
    const onBrowserData = (/** @type {Buffer} */ chunk) => {
      if (closed) return;
      let frames;
      try { frames = parser.push(chunk); }
      catch (e) { closeAll(/** @type {Error} */ (e).message); return; }
      for (const f of frames) {
        if ("control" in f) {
          if (f.control === "close") { closeAll("the browser closed the stream"); return; }
          continue;
        }
        let msg;
        try { msg = JSON.parse(f.message.toString("utf8")); } catch { continue; }
        if (msg.t === "input" && this.keyboard.canType(agent, surface)) {
          if (!cdp || !sessionId) continue;
          const kind = String(msg.kind || "");
          if (kind === "mouse") {
            const { type, x, y, button = "left", clickCount = 1 } = msg;
            cdp.send("Input.dispatchMouseEvent", { type, x: Number(x), y: Number(y), button, clickCount: Number(clickCount) }, sessionId).catch(() => {});
          } else if (kind === "key") {
            const { type, key, code, text } = msg;
            cdp.send("Input.dispatchKeyEvent", { type, key, code, text }, sessionId).catch(() => {});
            this.keyboard.renew(agent, surface, true);
          }
        }
      }
    };
    socket.on("data", onBrowserData);
    socket.on("close", () => closeAll("the browser's connection closed"));
    socket.on("error", e => closeAll(e.message));
    if (head && head.length) onBrowserData(head);

    try {
      await this.agentBrowser.viewer(agent, 1);
      viewerHeld = true;
    } catch (e) {
      const err = /** @type {any} */ (e);
      closeWith(socket, err && err.boot ? 4001 : 1011, err && err.boot ? String(err.short || err.message) : "");
      closeAll(err && err.message, true);
      return;
    }
    if (closed) return;

    const computerRow = this.agentBrowser.computerRow(agent);
    if (this.pool.died.has(agent) && (this.pool.row(computerRow) || {}).state !== "running") {
      closeWith(socket, 4001, STOPPED);
      closeAll(STOPPED, true);
      return;
    }

    try {
      const opened = await this.agentBrowser.openCdp(agent, { why: "watch" });
      cdp = opened.cdp;
      sessionId = opened.sessionId;
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 }, sessionId);
      screencastOn = true;
    } catch (e) {
      closeWith(socket, 1011, "could not start screencast");
      closeAll(/** @type {Error} */ (e).message, true);
      return;
    }

    const off = cdp.on(m => {
      if (closed || m.method !== "Page.screencastFrame" || m.sessionId !== sessionId) return;
      const p = m.params || {};
      sendJson({ t: "frame", format: "jpeg", data: p.data, metadata: p.metadata || {} });
      cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sessionId).catch(() => {});
    });

    sendJson({ t: "live", width: 1280, height: 800 });
    socket.on("close", () => { off(); });
  }
}
