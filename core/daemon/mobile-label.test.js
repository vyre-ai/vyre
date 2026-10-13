// @ts-check
// The old bare `mobile` caller label is refused at the daemon's door with words that say what to do: nothing assigns it any more (the phone arrives as its paired device:<id>), so a call that carries it
// is an old app or a claim. A person's surface and a model's label are not affected.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "./index.js";
import { request } from "./client.js";
import { tempHome } from "../../test/helpers.js";

test("a call labelled bare mobile is refused with a plain message; cli and mcp are not", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [] }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const r = await request("GET", "/v1/tools", undefined, { root, caller: "mobile" });
  assert.equal(r.error && r.error.code, "denied", JSON.stringify(r).slice(0, 200));
  assert.match(String(r.error.message), /Update the Vyre app on this phone/);
  const ok = await request("GET", "/v1/tools", undefined, { root, caller: "mcp" });
  assert.ok(Array.isArray(ok.data), "a model label still lists tools");
});
