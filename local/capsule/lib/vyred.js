// @ts-check
// vyred — how the Capsule's main process reaches vyred: one request over the unix socket, and
// the live event stream.
//
// The same shape as core/daemon/client.js ({ data } or { error }, never a throw), written again
// here rather than imported because a packaged app carries only local/capsule/: an import that
// reaches up into core/ works from source and dies inside app.asar, silently, before a window
// exists. The prototype lost twelve days to exactly that. The socket path comes from the CLI
// (VYRE_SOCKET), which is the one place that knows how config resolves it.

import http from "node:http";
import os from "node:os";
import path from "node:path";

/** Where vyred listens. `vyre capsule` and the capsule module always pass VYRE_SOCKET. */
export function socketPath(env = process.env) {
  if (env.VYRE_SOCKET) return env.VYRE_SOCKET;
  const home = env.VYRE_HOME || path.join(os.homedir(), ".vyre");
  return path.join(home, "vyred.sock");
}

/**
 * One request. Resolves to { data } or { error: { code, message } }; `unreachable` when vyred is
 * not running, so every caller degrades instead of throwing.
 * @param {string} socket @param {string} method @param {string} route @param {any} [payload]
 * @returns {Promise<{ data?: any, error?: { code: string, message: string } }>}
 */
export function request(socket, method, route, payload, { timeout = 10_000 } = {}) {
  return new Promise(resolve => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request({ socketPath: socket, path: route, method, timeout,
      headers: { "content-type": "application/json", "x-vyre-caller": "capsule", ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({ error: { code: "bad_response", message: raw.slice(0, 200) } }); } });
    });
    req.on("error", () => resolve({ error: { code: "unreachable", message: "vyred is not running" } }));
    req.on("timeout", () => { req.destroy(); resolve({ error: { code: "timeout", message: `vyred did not answer within ${timeout}ms` } }); });
    if (body) req.write(body);
    req.end();
  });
}

/** A client bound to one socket. */
export function client(socket = socketPath()) {
  return {
    socket,
    call: (tool, input = {}, opts) => request(socket, "POST", "/v1/tools/" + encodeURIComponent(tool), input, opts),
    get: (route, opts) => request(socket, "GET", route, undefined, opts),
    stream: (opts) => stream(socket, opts),
  };
}

/**
 * Follow /v1/events/stream. Calls onEvent for each event, onState with "open" or "down", and
 * reconnects on its own, resuming from the last event id so nothing is missed or repeated.
 *
 * It lives in the main process on purpose: the Capsule is hidden most of the time, Chromium
 * throttles a hidden window's timers, and the events that must always arrive (a held approval,
 * a request to show the Capsule) are exactly the ones that arrive while it is hidden.
 * @param {string} socket
 * @param {{ since?: number, type?: string, onEvent: (e: any) => void, onState?: (s: "open"|"down") => void, retryMs?: number }} opts
 */
export function stream(socket, { since = 0, type = "*", onEvent, onState = () => {}, retryMs = 1500 }) {
  let cursor = since, stopped = false, req = null, timer = null, state = "";
  const say = s => { if (s !== state) { state = s; onState(s); } };
  const retry = () => { if (stopped) return; say("down"); clearTimeout(timer); timer = setTimeout(connect, retryMs); };
  function connect() {
    if (stopped) return;
    req = http.get({ socketPath: socket, path: `/v1/events/stream?type=${encodeURIComponent(type)}&since=${cursor}`,
      headers: { accept: "text/event-stream", "x-vyre-caller": "capsule" } }, res => {
      if (res.statusCode !== 200) { res.resume(); return retry(); }
      say("open");
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n");
          if (!data) continue;               // a ": beat" comment keeps the socket warm, nothing more
          let e; try { e = JSON.parse(data); } catch { continue; }
          if (typeof e.id === "number" && e.id <= cursor) continue;
          if (typeof e.id === "number") cursor = e.id;
          try { onEvent(e); } catch {}
        }
        if (buf.length > 1 << 20) buf = "";  // a stream that never frames is not a stream
      });
      res.on("end", retry);
      res.on("error", retry);
    });
    req.on("error", retry);
  }
  connect();
  return {
    get cursor() { return cursor; },
    stop() { stopped = true; clearTimeout(timer); try { req && req.destroy(); } catch {} },
  };
}
