// @ts-check
// The module through the real Registry, with the fake helper binary in place of sight: the tools
// register under the names the manifest declares, tailnet callers are refused, and nothing read
// from the screen reaches the log or an event.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, Registry, validate } from "../../core/modules/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../../core/events/index.js";
import { tempHome } from "../../test/helpers.js";
import { makeHelper } from "./runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-sight.js");
const SECRET = "hunter2-test-only";
const scenario = state => ({
  state,
  where: { app: { name: "Notes", bundle: "com.apple.Notes", pid: 4242 }, window: { title: "Northwind Bakery order" }, url: null },
  context: {
    app: { name: "Notes", bundle: "com.apple.Notes", pid: 4242 }, window: { title: "Northwind Bakery order" },
    focused: { role: "AXTextField", subrole: "AXSecureTextField", value: SECRET }, secure: true,
    text: "Northwind Bakery opens at seven", truncated: false,
  },
});

async function registry(t, screen) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  /** @type {string[]} */
  const logged = [];
  const log = (m, x) => { logged.push(JSON.stringify([m, x ?? null])); };
  const reg = new Registry({ db, events: new Events(db), log, config: { role: "local", screen: screen(home) } });
  t.after(() => reg.stop());
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  return { reg, logged };
}

test("module: the manifest is valid under the loader's rules", () => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8"))), []);
});

test("module: starts in the Registry, registers both tools, and answers redacted", async t => {
  const { reg, logged } = await registry(t, home => ({ helper: makeHelper({ bin: FAKE, platform: "darwin", env: { ...process.env, FAKE_SIGHT: JSON.stringify(scenario(home)) } }) }));
  assert.equal(reg.status().find(m => m.name === "screen")?.state, "running");
  assert.deepEqual(reg.listTools("mcp").map(x => x.name).sort(), ["screen.context", "screen.shot"]);

  const r = await reg.call("screen.context", {}, "mcp");
  assert.equal(r.data.text, "Northwind Bakery opens at seven");
  assert.equal(r.data.secure, true);
  assert.equal(JSON.stringify(r).includes(SECRET), false);

  // Privacy: nothing screen-derived in the log, and no events at all.
  await reg.call("screen.shot", {}, "cli");
  const all = logged.join("\n");
  for (const bit of ["Northwind", "Notes", SECRET]) assert.equal(all.includes(bit), false, `the log carried ${bit}`);
  assert.deepEqual(reg.deps.events.since(0).filter(e => String(e.type).startsWith("screen")), []);
  assert.equal(JSON.stringify(reg.deps.events.since(0)).includes("Northwind"), false);
});

test("module: refuses tailnet callers and callers outside its list", async t => {
  const { reg } = await registry(t, home => ({ helper: makeHelper({ bin: FAKE, platform: "darwin", env: { ...process.env, FAKE_SIGHT: JSON.stringify(scenario(home)) } }) }));
  for (const tool of ["screen.context", "screen.shot"]) {
    const r = await reg.call(tool, {}, "mcp", { peer: { node: "juno", user: "alex" } });
    assert.equal(r.error?.code, "local_only", JSON.stringify(r));
    assert.match(r.error.message, /stays on this Mac/);
  }
  assert.equal((await reg.call("screen.context", {}, "hook")).error?.code, "no_such_tool");
  assert.equal((await reg.call("screen.context", {}, "surface")).error?.code, "denied");
});

test("module: a helper path in config or VYRE_SCREEN_BIN is used, and a missing one says how to build it", async t => {
  const prev = process.env.VYRE_SCREEN_BIN;
  process.env.VYRE_SCREEN_BIN = path.join(HERE, "no-such-helper");
  t.after(() => { if (prev === undefined) delete process.env.VYRE_SCREEN_BIN; else process.env.VYRE_SCREEN_BIN = prev; });
  const { reg } = await registry(t, () => ({}));
  const r = await reg.call("screen.context", {}, "cli");
  assert.equal(r.error?.code, process.platform === "darwin" ? "not_built" : "unsupported");
  if (process.platform === "darwin") assert.match(r.error.message, /build\.sh/);
  assert.equal((await reg.call("screen.context", { textMax: "lots" }, "cli")).error?.code, "bad_input");
});
