// @ts-check
// Who may call each watchers tool (ADR 0047 reach), against the real Registry and the real manifest:
// every tool names its reach, a model cannot turn a watcher on unless the person's own words asked
// for it, and only the person deletes, runs or resumes one. No daemon, no children: a temp home and stubs.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate, discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
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
    // watchers.test and watchers.pause are writes by declaration (kernel-declare, RG-1), so a write open to anyone is the person's surfaces and modules unless the tool names its callers: the real module
    // does (core/watchers/index.js: people, module, mcp, harness), and a stub that left it out would test the default, not the module.
    const OPEN = ["watchers.test", "watchers.pause"];
    for (const name of ${JSON.stringify(names)}) ctx.tool(name, { input: { type: "object" }, ...(OPEN.includes(name) ? { callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module", "mcp", "harness"] } : {}), run: async (input, meta) => ({ ran: name, caller: meta.caller }) });
    return { async stop() {} };
  } };`);
  writeModule(root, "projects", { name: "projects", version: "0.1.0", does: { tools: [{ name: "projects.reach", reach: "modules" }] } },
    `export default { async start(ctx) { ctx.tool("projects.reach", { input: { type: "object" }, run: async () => ({ all: true }) }); return {}; } };`);
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
    // the owner's device is the person only with the person's own session (reach person needs it, the sign-in the registry asks of a device)
    assert.equal(await code(tool, "tailnet:alex"), "person_session_required", tool);
    assert.equal((await reg.call(tool, { name: "w" }, "tailnet:alex", { person: { id: "ps1" } })).error, undefined, `${tool} with the person's session`);
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
  writeModule(root, "projects", { name: "projects", version: "0.1.0", does: { tools: [{ name: "projects.reach", reach: "modules" }] } },
    `export default { async start(ctx) { ctx.tool("projects.reach", { input: { type: "object" }, run: async () => ({ all: true }) }); return {}; } };`);
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

test("through the real module and the real registry: an agent with a grant sees only its project's watchers, by name and in lists", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  // The real watchers code and manifest, loaded by the real registry (nothing runs until a watcher does).
  const real = new URL("./index.js", import.meta.url).href;
  writeModule(root, "watchers", { ...manifest, requires: [], needs: {}, teaches: {} }, `export { default } from ${JSON.stringify(real)};`);
  writeModule(root, "projects", { name: "projects", version: "0.1.0", does: { tools: [{ name: "projects.reach", reach: "modules" }, { name: "projects.list", reach: "modules" }, { name: "projects.of", reach: "modules" }] } },
    `export default { async start(ctx) {
      ctx.tool("projects.of", { input: { type: "object" }, run: async i => ({ slug: String(i.cwd).startsWith("/work/h") ? "harlow-legal" : String(i.cwd).startsWith("/work/n") ? "northwind" : null }) });
      ctx.tool("projects.reach", { input: { type: "object" }, run: async i => /juno/.test(String(i.caller)) ? { all: true } : /kit/.test(String(i.caller)) ? { all: false, projects: [{ slug: "harlow-legal", name: "Harlow Legal" }] } : { all: false, projects: [] } });
      ctx.tool("projects.list", { input: { type: "object" }, run: async () => ({ projects: [{ slug: "harlow-legal", name: "Harlow Legal", home: "/work/h", workspaces: ["/work/h"] }, { slug: "northwind", name: "Northwind", home: "/work/n", workspaces: ["/work/n"] }] }) });
      return {}; } };`);
  writeModule(root, "threads", { name: "threads", version: "0.1.0", does: { tools: [{ name: "threads.get", reach: "modules" }] } },
    `export default { async start(ctx) { ctx.tool("threads.get", { input: { type: "object" }, run: async i => {
      if (i.thread === "t-harlow") return { thread: { id: i.thread, project: "harlow-legal" } };
      if (i.thread === "t-none") return { thread: { id: i.thread, project: null } };
      throw new Error("no such thread"); } }); return {}; } };`);
  const wdir = path.join(home, "watchers");
  const mk = (name, project) => {
    fs.mkdirSync(path.join(wdir, name), { recursive: true });
    fs.writeFileSync(path.join(wdir, name, "watcher.json"), JSON.stringify({ name, project, schedule: "*/15 * * * *" }));
    fs.writeFileSync(path.join(wdir, name, "watch.js"), "export default async function watch() {}");
  };
  mk("mail-harlow-legal", "harlow-legal"); mk("feed-northwind", "northwind");
  const db = open(path.join(home, "vyre.db")); t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, paths: { watchers: wdir, modules: path.join(home, "none") }, firstPartyRoots: [root] });
  await reg.start(discover([root], { firstPartyRoots: [root] }).map(f => ({ ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] })), { role: "local" });
  t.after(() => reg.stop && reg.stop());
  assert.equal(reg.modules.get("watchers").state, "running", reg.modules.get("watchers").error);

  const names = r => (r.data?.watchers || []).map(w => w.name).sort();
  const kit = "mcp:agent:kit", juno = "mcp:agent:juno", nobody = "mcp:agent:ghost";
  assert.deepEqual(names(await reg.call("watchers.list", {}, kit)), ["mail-harlow-legal"], "kit is granted harlow-legal only");
  assert.deepEqual(names(await reg.call("watchers.list", {}, juno)), ["feed-northwind", "mail-harlow-legal"], "juno is granted everything");
  assert.deepEqual(names(await reg.call("watchers.list", {}, nobody)), [], "an agent whose grant is empty sees none");
  assert.deepEqual(names(await reg.call("watchers.list", {}, "cli")), ["feed-northwind", "mail-harlow-legal"], "the person sees all");

  const code = async (tool, name, caller) => { const r = await reg.call(tool, { name }, caller); return r.error ? r.error.code : "ok"; };
  for (const tool of ["watchers.card", "watchers.logs", "watchers.items"]) {
    assert.equal(await code(tool, "feed-northwind", kit), "not_found", `${tool}: another project's watcher`);
    assert.equal(await code(tool, "mail-harlow-legal", kit), "ok", `${tool}: its own project's watcher`);
    assert.equal(await code(tool, "feed-northwind", juno), "ok", tool);
    assert.equal(await code(tool, "feed-northwind", "cli"), "ok", tool);
  }
  assert.equal(await code("watchers.pause", "feed-northwind", kit), "not_found", "an agent cannot stop another project's watcher");
  const card = await reg.call("watchers.card", { name: "mail-harlow-legal" }, kit);
  assert.equal(card.data.project, "harlow-legal");

  // A plain model session (the person's own Claude Code through MCP): vyred sets meta.peerSession and meta.peerCwd for it;
  // it sees its folder's project's watchers, and none where the folder is unknown. (A call without those keys is not one.)
  const plain = async (peerCwd, tool = "watchers.list", input = {}) => reg.call(tool, input, "mcp", { peerSession: "4242:1790000000", peerCwd });
  assert.deepEqual(names(await plain("/work/h/site")), ["mail-harlow-legal"], "a session in a harlow-legal folder");
  assert.deepEqual(names(await plain("/work/n")), ["feed-northwind"], "a session in a northwind folder");
  assert.deepEqual(names(await plain(null)), [], "where the OS will not say who or where, it reads nothing");
  assert.deepEqual(names(await plain("/elsewhere")), [], "a folder in no project");
  assert.equal((await plain("/work/h", "watchers.card", { name: "feed-northwind" })).error.code, "not_found");
  assert.equal((await plain("/work/n", "watchers.card", { name: "feed-northwind" })).data.name, "feed-northwind");
  assert.deepEqual(names(await reg.call("watchers.list", {}, "mcp")), ["feed-northwind", "mail-harlow-legal"], "a build that does not set the peer leaves it as before");

  // A verified Vyre thread session (meta.thread, no peer keys, no stored-grant agent): its own thread's project, and nothing otherwise.
  const thread = async (id, tool = "watchers.list", input = {}) => reg.call(tool, input, "mcp:thread:" + id, { thread: id });
  assert.deepEqual(names(await thread("t-harlow")), ["mail-harlow-legal"], "a chat in a harlow-legal project");
  assert.deepEqual(names(await thread("t-none")), [], "a thread with no project");
  assert.deepEqual(names(await thread("t-gone")), [], "a thread that cannot be looked up");
  assert.equal((await thread("t-harlow", "watchers.card", { name: "feed-northwind" })).error.code, "not_found");
  assert.equal((await thread("t-harlow", "watchers.card", { name: "mail-harlow-legal" })).data.name, "mail-harlow-legal");

  // A dry run on a real event is the person's own: every kind of model caller is refused, thread claims included
  // (nothing runs: the refusal comes before any child).
  const dry = (caller, meta = {}) => reg.call("watchers.test", { name: "mail-harlow-legal", event: { route: "r", id: "d1" } }, caller, meta);
  for (const [caller, meta] of [[kit, {}], [juno, {}], ["cli:agent:kit", {}], ["mcp", {}], ["harness", {}], ["mcp:thread:t-harlow", { thread: "t-harlow" }], ["mcp", { thread: "t-harlow" }], ["mcp", { peerSession: "1:2", peerCwd: "/work/h" }]]) {
    const r = await dry(caller, meta);
    assert.ok(r.error && /owner's/.test(r.error.message), `${caller} ${JSON.stringify(meta)} was not refused: ${JSON.stringify(r)}`);
  }
});
