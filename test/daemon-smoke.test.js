// A real vyred answers a call over its socket (a deleted line in route() once made EVERY socket call answer 500 "crossOrigin is not defined", and nothing in the suite noticed). One start, one
// call over the socket as the CLI makes it, one health read: a 200 with data, not a 500. A test box, never a Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";

const over = (/** @type {string} */ socket, /** @type {string} */ method, /** @type {string} */ path, /** @type {any} */ body) => new Promise(resolve => {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = http.request({ socketPath: socket, path, method, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw), "x-vyre-caller": "cli" } }, res => { let t = ""; res.on("data", c => { t += c; }); res.on("end", () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null })); });
  req.end(raw);
});

test("a real daemon answers a health read and a tool call over its socket with a 200 and data, never a 500", { timeout: 60_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {} });
  t.after(() => d.stop());
  const health = /** @type {any} */ (await over(d.paths.socket, "GET", "/v1/health"));
  assert.equal(health.status, 200, JSON.stringify(health.body));
  assert.ok(health.body.data && health.body.data.version);
  const call = /** @type {any} */ (await over(d.paths.socket, "POST", "/v1/tools/system.info", {}));
  assert.equal(call.status, 200, JSON.stringify(call.body));
  assert.ok(call.body.data && !call.body.error, JSON.stringify(call.body));
  for (const withKernel of [true]) {
    const k = await start({ root: tempHome(t), log: () => {}, kernel: withKernel });
    t.after(() => k.stop());
    const r = /** @type {any} */ (await over(k.paths.socket, "POST", "/v1/tools/system.info", {}));
    assert.equal(r.status, 200, "with the kernel on: " + JSON.stringify(r.body));
  }
});
