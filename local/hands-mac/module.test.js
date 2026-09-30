// @ts-check
// The module through the real Registry, with a fake app in place of the helper: the tools
// register under the names the manifest declares, act re-observes, and the event is recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, Registry, validate } from "../../core/modules/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../../core/events/index.js";
import { tempHome } from "../../test/helpers.js";
import { fakeApp } from "./fake.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("module: the manifest is valid under the loader's rules", () => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8"))), []);
});

test("module: starts in the Registry, registers its tools, and act observes again", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp({ texts: ["0"], elements: [{ path: "/0/0/7", role: "AXButton", name: "7", enabled: true }] },
    (req, s) => { s.texts = ["7"]; return { acted: true }; });
  const reg = new Registry({ db, events: new Events(db), log: () => {},
    config: { role: "local", hands: { runner: f.run, sleep: async () => {} } } });
  const found = discover([path.dirname(HERE)]).filter(m => m.dir === HERE);
  await reg.start(found, { role: "local" });
  assert.equal(reg.status().find(m => m.name === "hands")?.state, "running");
  assert.deepEqual(reg.listTools().map(x => x.name).sort(), ["hands.act", "hands.commit", "hands.find", "hands.grant.add", "hands.grant.list", "hands.grant.remove", "hands.observe", "hands.stop"]);

  const seen = await reg.call("hands.observe", {}, "mcp");
  assert.deepEqual(seen.data.elements[0].selector, { role: "AXButton", name: "7", path: "/0/0/7" });

  const r = await reg.call("hands.act", { selector: seen.data.elements[0].selector, kind: "press" }, "mcp");
  assert.equal(r.data.verified, true, JSON.stringify(r));
  const cmds = f.calls.map(c => c.cmd);
  assert.deepEqual(cmds.slice(cmds.indexOf("act")), ["act", "snap"], "act did not re-observe");
  const ev = reg.deps.events.since(0).filter(e => e.type === "hands.acted");
  assert.equal(ev.length, 1);
});

test("module: bad input is refused by the Registry's schema check", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp({ elements: [] });
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "local", hands: { runner: f.run } } });
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  assert.equal((await reg.call("hands.act", { selector: { role: "AXButton" }, kind: "drag" })).error.code, "bad_input");
  assert.equal(f.calls.length, 0);
});
