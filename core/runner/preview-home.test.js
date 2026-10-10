// @ts-check
// The home's preview bridge (preview-home.js) answers only the front (trust row 32), speaks as no one (row 31) and holds a browser back when the computer is slow to collect (row 30).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createPreviews, PREVIEW } from "./preview-home.js";

const ask = (/** @type {number} */ port, /** @type {Record<string, string>} */ headers = {}) => new Promise(resolve => {
  const r = http.request({ host: "127.0.0.1", port, path: "/x", headers }, res => { let b = ""; res.on("data", d => { b += d; }); res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers })); });
  r.on("error", () => resolve({ status: 0, body: "", headers: {} })); r.end();
});
const serve = (/** @type {ReturnType<typeof createPreviews>} */ pv, /** @type {(job: any) => any} */ answer) => {
  let on = true;
  (async () => { /** @type {any[]} */ let replies = []; while (on) { const r = /** @type {any} */ (await pv.poll("s1", { replies, wait_ms: 100 })); replies = []; for (const j of r.reqs || []) replies.push({ id: j.id, ...answer(j) }); } })();
  return () => { on = false; };
};

test("with a viewer check, a request without the front's signed header gets a 401 and reaches nothing, and the dev server never sees an x-vyre header nor can it send one back (rows 31, 32)", async t => {
  const pv = createPreviews();
  const { port } = await pv.open("s1", 4311, async h => h === "signed-by-the-front");
  /** @type {any[]} */ const seen = [];
  const stop = serve(pv, j => { seen.push(j); return { status: 200, headers: { "x-vyre-viewer": "owner", "x-vyre-extra": "1", "x-fine": "yes" }, body: Buffer.from("hello").toString("base64") }; });
  t.after(() => { stop(); pv.close("s1"); });
  const no = /** @type {any} */ (await ask(port));
  assert.equal(no.status, 401);
  assert.equal(seen.length, 0, "nothing was asked of the computer");
  assert.equal(/** @type {any} */ (await ask(port, { "x-vyre-viewer": "forged" })).status, 401);
  const yes = /** @type {any} */ (await ask(port, { "x-vyre-viewer": "signed-by-the-front", "x-vyre-other": "z", "x-app": "1" }));
  assert.equal(yes.status, 200);
  assert.deepEqual(Object.keys(seen[0].headers).filter(k => /^x-/.test(k)), ["x-app"], "no x-vyre header goes on to the dev server");
  assert.equal(yes.headers["x-fine"], "yes");
  assert.equal(yes.headers["x-vyre-viewer"], undefined, "the dev server cannot speak as the front");
  assert.equal(yes.headers["x-vyre-extra"], undefined);
  // a tunnel needs the header too
  const got = await new Promise(resolve => { const c = net.connect(port, "127.0.0.1"); let b = ""; c.on("data", d => { b += d; }); c.on("close", () => resolve(b)); c.on("connect", () => c.write("GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")); setTimeout(() => { c.destroy(); resolve(b); }, 1500); });
  assert.match(String(got), /^HTTP\/1\.1 401/);
});

test("a tunnel's queue toward the computer is bounded: a browser that sends fast is paused until the computer collects (row 30)", async t => {
  const pv = createPreviews();
  const { port } = await pv.open("s1", 4311);
  t.after(() => pv.close("s1"));
  const c = net.connect(port, "127.0.0.1"); t.after(() => c.destroy());
  await new Promise(r => c.on("connect", () => r(undefined)));
  c.write("GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  const chunk = Buffer.alloc(64 * 1024, 1);
  let sent = 0;
  for (let k = 0; k < 400; k++) { const ok = c.write(chunk); sent += chunk.length; if (!ok) await new Promise(r => setTimeout(r, 20)); if (k > 50 && sent > 8 * PREVIEW.TUNNEL_QUEUE_BYTES) break; }
  await new Promise(r => setTimeout(r, 300));
  const r = /** @type {any} */ (await pv.poll("s1", { wait_ms: 0 }));
  const first = (r.tun || []).length;
  assert.ok(first > 0, "the computer is handed bytes");
  // everything the queue held after that one pull is bounded; the rest of what the browser sent is still held back in the kernel's buffers
  let taken = (r.tun || []).reduce((/** @type {number} */ n, /** @type {any} */ x) => n + (x.b64 ? x.b64.length : 0), 0);
  for (let k = 0; k < 60; k++) { const q = /** @type {any} */ (await pv.poll("s1", { wait_ms: 0 })); taken += (q.tun || []).reduce((/** @type {number} */ n, /** @type {any} */ x) => n + (x.b64 ? x.b64.length : 0), 0); }
  assert.ok(taken < sent * 1.4 + 1024, "nothing is lost");
  assert.ok(taken <= sent * 4 / 3 + 4096);
});
