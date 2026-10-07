// @ts-check
// A live draft goes to the connection that asked for it (Accept: application/x-ndjson) and nowhere
// else: not the events bus, not a caller that didn't ask, not a module's ctx.call.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { start } from "./index.js";
import { call, request } from "./client.js";
import * as config from "../config/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

function raw(root, accept) {
  return new Promise(resolve => {
    const req = http.request({ socketPath: config.paths(root).socket, path: "/v1/tools/say.it", method: "POST", agent: false,
      headers: { "content-type": "application/json", "x-vyre-caller": "cli", ...(accept ? { accept } : {}) } }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", c => { body += c; }); res.on("end", () => resolve({ type: res.headers["content-type"], body }));
    });
    req.end("{}");
  });
}

test("draft stream: only a caller that asked gets draft lines, then the result; the events bus never sees the text", async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "say", { vyre: "1", description: "Says things.", does: { tools: [{ name: "say.it", reach: "anyone" }, { name: "say.via", reach: "anyone" }] }, watches: { emits: ["say.done"] } }, `export default { async start(ctx) {
    ctx.tool("say.it", { input: { type: "object" }, run: async (i, meta) => { if (typeof meta.draft === "function") { meta.draft({ id: "d1", text: "Half an answ" }); meta.draft({ id: "d1", text: "Half an answer" }); } ctx.events.emit("say.done", { asked: typeof meta.draft === "function" }); return { ok: true, asked: typeof meta.draft === "function" }; } });
    ctx.tool("say.via", { input: { type: "object" }, run: async () => (await ctx.call("say.it", {})).data });
    return {};
  } };`);
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  const live = /** @type {any} */ (await raw(root, "application/x-ndjson"));
  assert.match(live.type, /x-ndjson/, live.body);
  const lines = live.body.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(lines.slice(0, 2), [{ draft: { id: "d1", text: "Half an answ" } }, { draft: { id: "d1", text: "Half an answer" } }]);
  assert.deepEqual(lines[2], { result: { data: { ok: true, asked: true } } });
  // No Accept: a plain JSON answer, and the tool was given no draft function.
  const plain = /** @type {any} */ (await raw(root, undefined));
  assert.match(plain.type, /application\/json/);
  assert.deepEqual(JSON.parse(plain.body), { data: { ok: true, asked: false } });
  // A module calling the tool through ctx.call never has one either.
  assert.equal((await call("say.via", {}, { root })).data.asked, false);
  // The bus: the events say only whether it was asked, never the text.
  const ev = JSON.stringify((await request("GET", "/v1/events?type=say.done", undefined, { root })).data);
  assert.doesNotMatch(ev, /Half an answ/);
});
