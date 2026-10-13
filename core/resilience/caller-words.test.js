// @ts-check
// What a person can read when the box answers with something that is not a tool answer (a web server's page, an empty body): plain words and a next step, never a status code or "JSON".
// The technical detail rides beside it as `detail`, for the console.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { over } from "./web.js";
import { caller } from "./node.js";

const PLAIN = /^Vyre could not read your server's answer\. Try again\.$/;

test("web caller: an answer that is not JSON reads as plain words, with the detail kept apart", async () => {
  const call = over(async () => ({ status: 200, ok: true, text: async () => "<html>app shell</html>" })).caller();
  const r = /** @type {any} */ (await call("connectors.list", {}, "k1"));
  assert.equal(r.error.code, "unreachable");
  assert.match(r.error.message, PLAIN);
  assert.doesNotMatch(r.error.message, /JSON|200|box answered/i);
  assert.match(String(r.error.detail), /200/);
});

test("node caller: the same, over a real socket", async t => {
  const srv = http.createServer((_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end("<html></html>"); });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => srv.close());
  const r = /** @type {any} */ (await caller(`http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`)("connectors.list", {}));
  assert.equal(r.error.code, "unreachable");
  assert.match(r.error.message, PLAIN);
  assert.match(String(r.error.detail), /200/);
});
