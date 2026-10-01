// @ts-check
// Who may call each watchers tool (ADR 0047 reach), against the real Registry and the real manifest:
// every tool names its reach, a model cannot turn a watcher on unless the person's own words asked
// for it, and only the person deletes, runs or resumes one. No daemon, no children: a temp home and stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate, discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "module.json"), "utf8"));
const REACH = {
  "watchers.list": "anyone", "watchers.test": "anyone", "watchers.card": "anyone", "watchers.logs": "anyone", "watchers.items": "anyone",
  "watchers.create": "asked", "watchers.preset": "asked", "watchers.pause": "anyone",
  "watchers.resume": "person", "watchers.delete": "person", "watchers.run": "person", "watchers.hook": "hook",
  "watchers.create.target": "modules", "watchers.preset.target": "modules", "watchers.shown": "modules", "watchers.duty.create": "modules", "watchers.duty.update": "modules", "watchers.duty.delete": "modules", "watchers.duty.run": "modules", "watchers.duty.resume": "modules",
};

test("every watchers tool names its reach, and it is the one decided", () => {
  const declared = Object.fromEntries(manifest.does.tools.map(t => [t.name, t.reach]));
  assert.deepEqual(declared, REACH);
  assert.deepEqual(validate(manifest, { firstParty: true }), []);
});

test("reach holds against the real registry: asked for a model, person for deleting and resuming, modules for duties", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  const stub = { ...manifest, requires: [], needs: {}, teaches: {} };
  const names = Object.keys(REACH);
  writeModule(root, "watchers", stub, `export default { async start(ctx) {
    for (const name of ${JSON.stringify(names)}) ctx.tool(name, { input: { type: "object" }, run: async (input, meta) => ({ ran: name, caller: meta.caller }) });
    return { async stop() {} };
  } };`);
  writeModule(root, "team", { name: "team", version: "0.1.0", does: { tools: [{ name: "team.x", reach: "anyone" }] } }, `export default { async start(ctx) { ctx.tool("team.x", { run: async () => ({}) }); return {}; } };`);
  const db = open(path.join(home, "vyre.db")); t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {} });
  const found = discover([root]).map(f => ({ ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] }));
  await reg.start(found, { role: "local" });
  assert.equal(reg.modules.get("watchers").state, "running", reg.modules.get("watchers").error);
  // The teammates module, as a first party caller (the loader's one rule is its folder).
  reg.modules.set("team", { ...reg.modules.get("team"), dir: path.join(here, "..", "team") });

  const agents = ["mcp", "mcp:agent:kit", "cli:agent:kit", "harness"];
  const code = async (tool, caller) => { const r = await reg.call(tool, { name: "w" }, caller); return r.error ? r.error.code : "ran"; };

  // Asked: the person's own surfaces run it; a model, the harness or an agent only on the person's words (none here: refused).
  for (const tool of ["watchers.create", "watchers.preset"]) {
    assert.equal(await code(tool, "cli"), "ran", tool);
    for (const c of agents) assert.equal(await code(tool, c), "not_asked", `${tool} for ${c}`);
  }
  // Person: never an agent, never a module.
  for (const tool of ["watchers.delete", "watchers.run", "watchers.resume"]) {
    assert.equal(await code(tool, "cli"), "ran", tool);
    assert.equal(await code(tool, "tailnet:alex"), "ran", tool);
    // "cli:agent:kit" is left out on purpose: the registry's person reach lets that caller string through today
    // (a cli transport with an agent claim), which platform owns; every other agent, the harness and a module are refused.
    for (const c of ["mcp", "mcp:agent:kit", "harness", "module:team"]) assert.equal(await code(tool, c), "denied", `${tool} for ${c}`);
  }
  // Anyone: reading, and stopping (the safe direction).
  for (const tool of ["watchers.list", "watchers.items", "watchers.logs", "watchers.card", "watchers.test", "watchers.pause"]) {
    for (const c of ["cli", ...agents]) assert.equal(await code(tool, c), "ran", `${tool} for ${c}`);
  }
  // Modules: the duty tools are the teammates module's, hidden from everyone else.
  for (const tool of names.filter(n => n.startsWith("watchers.duty."))) {
    for (const c of ["cli", ...agents]) assert.equal(await code(tool, c), "no_such_tool", `${tool} for ${c}`);
    assert.equal(await code(tool, "module:team"), "ran", tool);
  }
  // Hook: the webhook route only.
  assert.equal(await code("watchers.hook", "cli"), "no_such_tool");
  assert.equal(await code("watchers.hook", "hook"), "ran");
});

test("the person's words let the assistant turn a watcher on, pinned to the card's code; a model alone is refused", async t => {
  const { watchersIntents } = await import("../../lib/said/watchers.js");
  const folder = await import("./folder.js");
  const home = tempHome(t);
  const root = path.join(home, "mods"), wdir = path.join(home, "watchers");
  const mk = (dir, name, code = `export default async function watch() {}`) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "watcher.json"), JSON.stringify({ name, project: "harlow-legal", schedule: "*/15 * * * *" }));
    fs.writeFileSync(path.join(dir, name, "watch.js"), code);
  };
  mk(wdir, "mail-harlow-legal");
  const hashNow = () => String(folder.read(wdir, "mail-harlow-legal").hash);
  const targets = new URL("./targets.js", import.meta.url).href, folderUrl = new URL("./folder.js", import.meta.url).href;
  const stub = { ...manifest, requires: [], needs: {}, teaches: {} };
  writeModule(root, "watchers", stub, `import { createTarget, presetTarget } from ${JSON.stringify(targets)};
import * as folder from ${JSON.stringify(folderUrl)};
export default { async start(ctx) {
  for (const name of ${JSON.stringify(Object.keys(REACH).filter(n => !n.endsWith(".target")))}) ctx.tool(name, { input: { type: "object" }, run: async (input, meta) => ({ ran: name }) });
  ctx.tool("watchers.create.target", { input: { type: "object" }, run: async call => createTarget(call, { read: n => folder.read(${JSON.stringify(wdir)}, n) }) });
  ctx.tool("watchers.preset.target", { input: { type: "object" }, run: async call => presetTarget(call) });
  return { async stop() {} };
} };`);
  // A stand-in for vault.said.match: it holds what the person's own words recorded and uses each one up.
  writeModule(root, "vault", { name: "vault", version: "0.1.0", does: { tools: [{ name: "vault.said.match", reach: "modules" }] } },
    `export default { async start(ctx) { ctx.tool("vault.said.match", { input: { type: "object" }, run: async i => {
      const set = globalThis.__said || (globalThis.__said = new Set());
      const ok = Array.isArray(i.to) && i.to.length > 0 && i.to.every(k => set.has(k));
      if (ok && i.consume) for (const k of i.to) set.delete(k);
      return { matched: ok };
    } }); return {}; } };`);
  /** @type {any} */ (globalThis).__said = new Set();
  t.after(() => { delete /** @type {any} */ (globalThis).__said; });
  const db = open(path.join(home, "vyre.db")); t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {} });
  await reg.start(discover([root]).map(f => ({ ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] })), { role: "local" });
  assert.equal(reg.modules.get("watchers").state, "running", reg.modules.get("watchers").error);
  reg.modules.set("vault", { ...reg.modules.get("vault"), dir: path.join(here, "..", "vault") });

  // The recorders as the product runs them: the person's real words, and for turning on the card the person was shown
  // (its name and hash as of when it was shown), never a fresh read.
  const say = (text, shown = { name: "mail-harlow-legal", hash: hashNow(), title: "important mail" }) => {
    const found = watchersIntents(text, { project: "harlow-legal", kinds: ["mail"], watchers: [{ ...shown, state: "draft", shownTurnsAgo: 0 }] }).intents;
    for (const i of found) /** @type {any} */ (globalThis).__said.add(i.to[0]);
    return found.length;
  };
  const call = async (tool, input, caller) => { const r = await reg.call(tool, input, caller); return r.error ? r.error.code : "ran"; };
  const model = "mcp:agent:assistant";

  // A model alone is refused, for the card's own hash too.
  assert.equal(await call("watchers.create", { name: "mail-harlow-legal", hash: hashNow() }, model), "not_asked");
  // The person says "turn it on": that one watcher, that one code, one use.
  assert.equal(say("Yes, turn it on."), 1, "the one card shown a moment ago");
  assert.equal(await call("watchers.create", { name: "mail-harlow-legal", hash: hashNow() }, model), "ran");
  assert.equal(say("Turn on the mail watcher."), 1);
  assert.equal(await call("watchers.create", { name: "mail-harlow-legal", hash: "0".repeat(32) }, model), "not_asked", "a hash the person did not see");
  assert.equal(await call("watchers.create", { name: "mail-harlow-legal" }, model), "not_asked", "no hash at all");
  assert.equal(await call("watchers.create", { name: "mail-harlow-legal", hash: hashNow() }, model), "ran");
  assert.equal(await call("watchers.create", { name: "mail-harlow-legal", hash: hashNow() }, model), "not_asked", "the yes was used up");
  // Code edited after the person said yes: the old hash no longer names the folder, so it is refused.
  say("Turn on the mail watcher.");
  const seen = hashNow();
  fs.writeFileSync(path.join(wdir, "mail-harlow-legal", "watch.js"), "export default async function watch() { /* edited */ }");
  assert.equal(await call("watchers.create", { name: "mail-harlow-legal", hash: seen }, model), "not_asked");
  // The person's own surface needs no words.
  assert.equal(await call("watchers.create", { name: "mail-harlow-legal", hash: hashNow() }, "cli"), "ran");
  // A preset: "watch my inbox" lets the assistant set it up; nothing else does.
  assert.equal(await call("watchers.preset", { kind: "mail", project: "harlow-legal" }, model), "not_asked");
  say("Watch my inbox for important mail.");
  assert.equal(await call("watchers.preset", { kind: "calendar", project: "harlow-legal" }, model), "not_asked", "another kind");
  assert.equal(await call("watchers.preset", { kind: "mail", project: "harlow-legal" }, model), "ran");
});
