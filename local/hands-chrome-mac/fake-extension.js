// @ts-check
// A fake extension for tests: connects to the bridge's socket the way the native host does, says
// hello, and answers requests from a handler, so bridge and module are tested with no Chrome, no
// host process and no extension code. Frames are the real ones (stdio.js).

import net from "node:net";
import { encode, reader } from "./native-host/stdio.js";
import { PROTOCOL } from "./shared/proto.js";

/**
 * @param {string} sockPath
 * @param {{ hello?: boolean|object, handler?: (op: string, args: any, frame: any) => any }} [o]
 *   handler returns a result, or throws {code, message}; return a never-settling promise to stay silent.
 */
export async function fakeExtension(sockPath, { hello = true, handler = () => ({ ok: true }) } = {}) {
  const sock = net.connect(sockPath);
  await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
  /** @type {any[]} every frame the module sent */
  const got = [];
  const rd = reader();
  sock.on("data", async d => {
    for (const m of rd.push(d)) {
      got.push(m);
      if (m.id === undefined || typeof m.op !== "string") continue;
      try {
        const result = await handler(m.op, m.args, m);
        send({ id: m.id, ok: true, result });
      } catch (e) {
        const x = /** @type {any} */ (e);
        send({ id: m.id, ok: false, error: { code: x.code || "error", message: x.message || String(e) } });
      }
    }
  });
  sock.on("error", () => {});
  const send = (/** @type {any} */ f) => new Promise(r => { if (sock.destroyed) return r(false); sock.write(encode(f), () => r(true)); });
  const self = {
    sock, got, send,
    /** Frames of one kind the module has sent so far. @param {string} op */
    ops: op => got.filter(m => m.op === op),
    events: () => got.filter(m => typeof m.event === "string"),
    hello: (/** @type {object} */ extra = {}) => send({ event: "hello", protocol: PROTOCOL, version: "0.2.0", ...extra }),
    closed: () => new Promise(r => { if (sock.destroyed) r(true); else sock.once("close", () => r(true)); }),
    close: () => new Promise(r => { sock.once("close", () => r(true)); sock.destroy(); }),
  };
  if (hello) await self.hello(typeof hello === "object" ? hello : {});
  return self;
}

/** Wait until a condition holds (polling briefly), for events that cross a socket. @param {() => any} fn @param {number} [ms] */
export async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("timed out waiting for the condition");
}
