// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setCardRedeemer } from "../../lib/one-yes.js";
import path from "node:path";
import fs from "node:fs";
import { validate, discover, order, checkInput, Registry, callerKind, callerAllowed, agentClaim, roleBuckets, firstParty, satisfies } from "./index.js";
import { fileURLToPath } from "node:url";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const good = { name: "notes", version: "0.1.0", does: { tools: ["notes.add"] }, watches: { emits: ["note.added"] } };
/** The same, with notes.add's reach declared (module API 1), so a module in a home may call it. */
const goodDeclared = { ...good, does: { tools: [{ name: "notes.add", reach: "anyone" }] } };

test("modules: a good manifest has no problems", () => {
  assert.deepEqual(validate(good), []);
});

// ADR 0039: config.machine (solo/server/device) is what start() is actually called with now;
// manifests keep saying "box"/"local", so this is the seam between the two.
test("modules: roleBuckets maps config.machine onto the manifests' box/local vocabulary", () => {
  assert.deepEqual(roleBuckets("server", "linux"), ["box"]);
  assert.deepEqual(roleBuckets("device", "linux"), ["local"]);
  // Reviewer's HOLD on 80fd866e, 28 Sep: solo is the full local core and none of the eight
  // box-only modules -- it is a device, never a server, until the person chooses otherwise.
  assert.deepEqual(roleBuckets("solo", "linux"), ["local"]);
  // A raw legacy value (existing tests, or a caller not yet updated) passes straight through.
  assert.deepEqual(roleBuckets("box", "linux"), ["box"]);
  assert.deepEqual(roleBuckets("local", "linux"), ["local"]);
});

// team-lead, 28 Sep: a Mac chosen as the server is still, often, someone's own desk -- Capsule,
// voice and the rest of the local core stay. A Linux box never had those modules to begin with.
test("modules: roleBuckets gives a darwin server the local bucket too, but not a Linux one", () => {
  assert.deepEqual(roleBuckets("server", "darwin").sort(), ["box", "local"]);
  assert.deepEqual(roleBuckets("server", "linux"), ["box"]);
  // device and solo are unaffected by platform: a device is never also a server.
  assert.deepEqual(roleBuckets("device", "darwin"), ["local"]);
  assert.deepEqual(roleBuckets("solo", "darwin"), ["local"]);
});

test("modules: tools must carry the module's own name", () => {
  assert.match(validate({ ...good, does: { tools: ["vault.fetch"] } }).join(), /must start with "notes\."/);
});

test("modules: the five verbs must be objects", () => {
  assert.match(validate({ ...good, needs: ["x"] }).join(), /needs must be an object/);
  // sync.* makes memory forget a device's history: only federation's first-party module declares it.
  assert.match(validate({ ...good, watches: { emits: ["sync.deleted"] } }).join(), /event "sync.deleted" is reserved for sync/);
  assert.match(validate({ ...good, name: "sync", does: {}, watches: { emits: ["sync.deleted"] } }).join(), /reserved/, "a home module named sync is not first-party");
  assert.deepEqual(validate({ ...good, name: "sync", does: {}, watches: { emits: ["sync.deleted"] } }, { firstParty: true }), []);
  assert.match(validate({ ...good, name: "link", does: {}, watches: { emits: ["sync.deleted"] } }, { firstParty: true }).join(), /reserved for sync/, "only core/sync");
  for (const e of ["push.proactive", "gate.held", "presence.proved", "said.aloud", "memory.updated", "artifact-links.changed", "thread.deleted"]) {
    assert.match(validate({ ...good, watches: { emits: [e] } }).join(), new RegExp(`event "${e}" is reserved`), `added module refused ${e}`);
  }
});

test("modules: dependencies start first; cycles and missing ones are named", () => {
  const m = (name, requires = []) => ({ manifest: { name, requires } });
  const { ordered, problems } = order([m("c", ["b"]), m("b", ["a"]), m("a"), m("x", ["nope"]), m("p", ["q"]), m("q", ["p"])]);
  assert.deepEqual(ordered.map(o => o.manifest.name).slice(0, 3), ["a", "b", "c"]);
  assert.match(problems.get("x"), /"nope"/);
  assert.ok(problems.get("p") || problems.get("q"), "a cycle was not reported");
});

test("modules: tool input is checked before a tool runs", () => {
  const schema = { type: "object", required: ["text"], properties: { text: { type: "string" }, n: { type: "integer" } } };
  assert.deepEqual(checkInput(schema, { text: "hi" }), []);
  assert.match(checkInput(schema, {}).join(), /text is required/);
  assert.match(checkInput(schema, { text: "hi", n: 1.5 }).join(), /n must be integer/);
});

/**
 * A real Registry over a temp home. builtIn: the fixtures stand in for modules shipped with Vyre
 * (core/, local/, modules/), so they are checked as first party: a test of a built in only member
 * (ctx.vault.fetch, needs.vault) can't sit in the home as an added module (reviews/platform.md CR-H3).
 */
async function registry(t, mods, { rules, builtIn = false } = {}) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  for (const [name, manifest, src] of mods) writeModule(root, name, manifest, src);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, rules });
  const found = discover([root]).map(f => (builtIn ? { ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] } : f));
  await reg.start(found, { role: "local" });
  t.after(() => db.close());
  return reg;
}

const echo = `export default { async start(ctx) {
  ctx.tool("notes.add", { effect: "read", input: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    run: async ({ text }) => { ctx.events.emit("note.added", { text }); return { saved: text }; } });
  return { async stop() {} };
} };`;

test("modules: a module's tool runs through the registry and its event is recorded", async t => {
  const reg = await registry(t, [["notes", good, echo]]);
  assert.deepEqual(await reg.call("notes.add", { text: "hi" }), { data: { saved: "hi" } });
  assert.equal(reg.deps.events.since(0).at(-1).type, "note.added");
});

test("modules: a module installed into a home never calls as another caller, even one named link", async t => {
  // A module outside core/ may not act as the person ("cli", "deck") or as the link ("link:box"),
  // whatever its manifest says, and even when it takes the link's own name.
  const tries = `export default { async start(ctx) {
    ctx.tool("notes.try", { effect: "read", input: { type: "object", properties: { as: { type: "string" } } },
      run: async ({ as }) => { try { await ctx.call("notes.add", { text: "x" }, { as }); return "called"; } catch (e) { return e.message; } } });
    ctx.tool("notes.add", { effect: "read", input: { type: "object", properties: { text: { type: "string" } } }, run: async () => "ok" });
    return { async stop() {} };
  } };`;
  for (const name of ["notes", "link"]) {
    const reg = await registry(t, [[name, { version: "0.1.0", does: { tools: [`${name}.try`, `${name}.add`] }, needs: { callAs: ["cli", "link:box"] } }, tries.replaceAll("notes.", `${name}.`)]]);
    for (const as of ["cli", "deck", "link:box", "module:link"]) {
      assert.match((await reg.call(`${name}.try`, { as })).data, /may not call/, `${name} as ${as}`);
    }
  }
});

test("modules: meta.firstParty is set by the registry, from the loader's firstParty rule", async t => {
  // A module in a home asks another tool what it was told; a claimed firstParty is overwritten.
  const src = `export default { async start(ctx) {
    ctx.tool("notes.seen", { effect: "read", input: { type: "object" }, run: async (_, meta) => ({ firstParty: meta.firstParty, caller: meta.caller }) });
    ctx.tool("notes.ask", { effect: "read", input: { type: "object" }, run: async () => (await ctx.call("notes.seen", {})).data });
    return { async stop() {} };
  } };`;
  const reg = await registry(t, [["notes", { version: "0.1.0", does: { tools: ["notes.seen", "notes.ask"] } }, src]]);
  assert.deepEqual((await reg.call("notes.ask", {})).data, { firstParty: false, caller: "module:notes" });
  assert.equal((await reg.call("notes.seen", {}, "module:notes", { firstParty: true })).data.firstParty, false, "a claim is overwritten");
  assert.equal((await reg.call("notes.seen", {}, "cli", { firstParty: true })).data.firstParty, false);
  assert.equal((await reg.call("notes.seen", {}, "module:nobody", {})).data.firstParty, false);
  // A module shipped in the repo's core/ is first party, by the same rule the loader uses.
  const shipped = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mail");
  assert.equal(firstParty(shipped), true);
  reg.modules.set("mail", { ...reg.modules.get("notes"), dir: shipped });
  assert.equal((await reg.call("notes.seen", {}, "module:mail", {})).data.firstParty, true);
});

test("modules: a module that throws on start is failed, and the rest still run", async t => {
  const reg = await registry(t, [
    ["notes", good, echo],
    ["broken", { version: "0.1.0" }, `export default { async start() { throw new Error("no database") } };`],
  ]);
  const s = Object.fromEntries(reg.status().map(m => [m.name, m.state]));
  assert.equal(s.notes, "running");
  assert.equal(s.broken, "failed");
});

test("modules: a module cannot register a tool or emit an event it did not declare", async t => {
  const sneaky = `export default { async start(ctx) { ctx.tool("notes.delete-all", { effect: "read", run: async () => 1 }); return {}; } };`;
  const reg = await registry(t, [["notes", good, sneaky]]);
  assert.equal(reg.status()[0].state, "failed");
  assert.match(reg.status()[0].error, /does not declare/);
});

test("modules: ctx.events.prune takes only the module's own declared types", async t => {
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { effect: "read", run: async ({ type }) => ctx.events.prune(type, { before: 1e9 }) });
    return { async stop() {} };
  } };`;
  const reg = await registry(t, [["notes", good, src]]);
  const ev = reg.deps.events;
  ev.emit("notes", "note.added", { text: "mine" });
  ev.emit("other", "note.added", { text: "not mine" });
  ev.emit("other", "thing.happened", {});
  assert.match((await reg.call("notes.add", { type: "thing.happened" })).error.message, /pruned thing.happened, which its manifest does not declare/);
  assert.deepEqual(await reg.call("notes.add", { type: "note.added" }), { data: 1 });
  assert.deepEqual(ev.since(0).map(e => e.source + ":" + e.type), ["other:note.added", "other:thing.happened"], "a module prunes only rows it emitted");
});

test("modules: every call passes through the rules, whoever makes it", async t => {
  const seen = [];
  const reg = await registry(t, [["notes", good, echo]], {
    rules: async call => { seen.push(call.caller); return call.input.text === "rm -rf" ? { allow: false, reason: "held" } : { allow: true }; },
  });
  assert.equal((await reg.call("notes.add", { text: "ok" }, "mcp")).data.saved, "ok");
  assert.deepEqual(await reg.call("notes.add", { text: "rm -rf" }, "cli"), { error: { code: "denied", message: "held" } });
  assert.deepEqual(seen, ["mcp", "cli"]);
});

test("modules: bad input is refused before the tool runs", async t => {
  const reg = await registry(t, [["notes", good, echo]]);
  assert.equal((await reg.call("notes.add", {})).error.code, "bad_input");
  assert.equal(reg.deps.events.since(0).filter(e => e.type === "note.added").length, 0);
});

test("modules: ctx.store migrations are bound to the module's own name", async t => {
  const src = `export default { async start(ctx) {
    ctx.store.migrate(["CREATE TABLE notes_items (id INTEGER PRIMARY KEY, body TEXT)"]);
    ctx.tool("notes.add", { effect: "read", run: async ({ text }) => { ctx.store.db.prepare("INSERT INTO notes_items (body) VALUES (?)").run(text); return { saved: true }; } });
    return {};
  } };`;
  const thief = `export default { async start(ctx) { ctx.store.migrate(["CREATE TABLE notes_stolen (x)"]); return {}; } };`;
  const reg = await registry(t, [["notes", good, src], ["other", { version: "0.1.0" }, thief]]);
  assert.deepEqual(await reg.call("notes.add", { text: "hi" }), { data: { saved: true } });
  assert.equal(reg.deps.db.prepare("SELECT body FROM notes_items").get().body, "hi");
  const other = reg.status().find(m => m.name === "other");
  assert.equal(other.state, "failed");
  assert.match(other.error, /must start with "other_"/);
});

test("modules: one module calls another's tool through ctx.call, and the rules see who asked", async t => {
  const seen = [];
  const caller = `export default { async start(ctx) {
    ctx.tool("brief.make", { effect: "read", run: async () => (await ctx.call("notes.add", { text: "from brief" })).data });
    return {};
  } };`;
  // notes.add declares its reach: a module in a home reaches only a declared tool (ADR 0047 H4).
  const reg = await registry(t, [["notes", goodDeclared, echo], ["brief", { version: "0.1.0", requires: ["notes"], does: { tools: ["brief.make"] }, needs: { tools: ["notes.add"] } }, caller]],
    { rules: async c => { seen.push(`${c.caller}>${c.tool}`); return { allow: true }; } });
  assert.deepEqual(await reg.call("brief.make", {}, "cli"), { data: { saved: "from brief" } });
  assert.deepEqual(seen, ["cli>brief.make", "module:brief>notes.add"]);
});

test("modules: ctx.vault.fetch releases only declared items, through an internal tool no surface can reach", async t => {
  const vault = `export default { async start(ctx) {
    ctx.tool("vault.release", { internal: true, run: async ({ name }, { caller }) => ({ value: "value-of-" + name + "-for-" + caller }) });
    return {};
  } };`;
  const user = `export default { async start(ctx) {
    ctx.tool("mailer.check", { effect: "read", run: async ({ item }) => ({ got: await ctx.vault.fetch(item) }) });
    return {};
  } };`;
  const reg = await registry(t, [
    ["vault", { version: "0.1.0", does: { tools: ["vault.release"] } }, vault],
    ["mailer", { version: "0.1.0", does: { tools: ["mailer.check"] }, needs: { vault: ["inbox"] } }, user],
  ], { builtIn: true });
  assert.deepEqual(await reg.call("mailer.check", { item: "inbox" }, "cli"), { data: { got: "value-of-inbox-for-module:mailer" } });
  assert.match((await reg.call("mailer.check", { item: "bank" }, "cli")).error.message, /does not declare/);
  assert.equal((await reg.call("vault.release", { name: "inbox" }, "mcp")).error.code, "no_such_tool", "Claude reached the vault directly");
  assert.ok(!reg.listTools().some(x => x.name === "vault.release"), "an internal tool was listed");
});

test("modules: \"per-agent\" lets a module fetch any item name, still through vault.release as itself", async t => {
  const vault = `export default { async start(ctx) {
    ctx.tool("vault.release", { internal: true, run: async ({ name }, { caller }) => ({ value: "value-of-" + name + "-for-" + caller }) });
    return {};
  } };`;
  const user = `export default { async start(ctx) {
    ctx.tool("agents.check", { effect: "read", run: async ({ item }) => ({ got: await ctx.vault.fetch(item) }) });
    return {};
  } };`;
  const reg = await registry(t, [
    ["vault", { version: "0.1.0", does: { tools: ["vault.release"] } }, vault],
    ["agents", { version: "0.1.0", does: { tools: ["agents.check"] }, needs: { vault: ["per-agent"] } }, user],
  ], { builtIn: true });
  assert.deepEqual(await reg.call("agents.check", { item: "scout-token" }, "cli"), { data: { got: "value-of-scout-token-for-module:agents" } });
  assert.deepEqual(await reg.call("agents.check", { item: "juno-key" }, "cli"), { data: { got: "value-of-juno-key-for-module:agents" } });
});

test("modules: ctx.memory.teach checks the declared kinds and is a no-op without Memory", async t => {
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { effect: "read", run: async ({ kind }) => ({ taught: await ctx.memory.teach(kind, { text: "x" }) }) });
    return {};
  } };`;
  const reg = await registry(t, [["notes", { ...good, teaches: { memory: ["note.item"] } }, src]]);
  assert.deepEqual(await reg.call("notes.add", { kind: "note.item" }), { data: { taught: false } });
  assert.match((await reg.call("notes.add", { kind: "secret.item" })).error.message, /does not declare under teaches.memory/);
});

test("modules: a second module with a name already loaded is reported, and the first keeps running", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"), b = path.join(home, "b");
  writeModule(a, "notes", good, echo);
  writeModule(b, "notes", { ...good, does: { tools: ["notes.other"] } }, `export default { async start(ctx) { ctx.tool("notes.other", { effect: "read", run: async () => 1 }); return {}; } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {} });
  await reg.start(discover([a, b]), { role: "local" });
  const st = reg.status();
  assert.equal(st.find(m => m.name === "notes").state, "running");
  const dup = st.find(m => m.name.startsWith("notes@"));
  assert.equal(dup.state, "invalid");
  assert.match(dup.error, /already loaded/);
  assert.equal((await reg.call("notes.add", { text: "x" })).data.saved, "x");
  assert.equal((await reg.call("notes.other", {})).error.code, "no_such_tool");
});

test("modules: two modules that share a name for different machines: the one that is on for this machine runs, whichever folder is found first", async t => {
  for (const order of [["a", "b"], ["b", "a"]]) {
    const home = tempHome(t);
    const dirs = { a: path.join(home, "a"), b: path.join(home, "b") };
    // a is the Mac's copy (local), b is the box's copy.
    writeModule(dirs.a, "notes", { ...good, roles: ["local"] }, echo);
    writeModule(dirs.b, "notes", { ...good, roles: ["box"], does: { tools: ["notes.add"] } }, `export default { async start(ctx) { ctx.tool("notes.add", { effect: "read", run: async () => ({ from: "box" }) }); return {}; } };`);
    const db = open(path.join(home, `vyre-${order.join("")}.db`));
    t.after(() => db.close());
    const reg = new Registry({ db, events: new Events(db), config: { role: "box" }, log: () => {}, firstPartyRoots: [dirs.a, dirs.b] });
    await reg.start(discover(order.map(k => dirs[/** @type {"a"|"b"} */ (k)]), { firstPartyRoots: [dirs.a, dirs.b] }), { role: "box" });
    const st = reg.status();
    assert.equal(st.find(m => m.name === "notes").state, "running", order.join());
    assert.equal(path.dirname(reg.modules.get("notes").dir), dirs.b, "the box copy is the one that runs");
    assert.equal((await reg.call("notes.add", {})).data.from, "box");
    assert.ok(st.filter(m => m.name.startsWith("notes@")).every(m => m.state === "off"), "the other stays listed as off, not invalid");
  }
});

test("modules: an added module never takes the name of a core module that is only off on this machine", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"), b = path.join(home, "b");
  writeModule(a, "notes", { ...good, roles: ["box"] }, echo);
  writeModule(b, "notes", { ...good, roles: ["local"], does: { tools: ["notes.add"] } }, `export default { async start(ctx) { ctx.tool("notes.add", { effect: "read", run: async () => ({ from: "added" }) }); return {}; } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {} });
  await reg.start(discover([a, b]), { role: "local" });
  // Neither folder is one of Vyre's own here, so the old rule holds: the first found keeps the name, the other is reported.
  assert.equal(reg.modules.get("notes").state, "off");
  assert.equal(path.dirname(reg.modules.get("notes").dir), a);
  assert.equal(reg.status().find(m => m.name.startsWith("notes@")).state, "invalid");
});

test("modules: an added module with a first-party name that is off here stays invalid, in either folder order", async t => {
  for (const order of [["core", "added"], ["added", "core"]]) {
    const home = tempHome(t);
    const dirs = { core: path.join(home, "core"), added: path.join(home, "added") };
    writeModule(dirs.core, "names", { ...good, name: "names", does: { tools: ["names.add"] }, roles: ["box"] }, echo);
    writeModule(dirs.added, "names", { ...good, name: "names", does: { tools: [{ name: "names.add", reach: "anyone" }] }, roles: ["local"] }, `export default { async start(ctx) { ctx.tool("names.add", { effect: "read", run: async () => ({ from: "added" }) }); return {}; } };`);
    const db = open(path.join(home, `vyre-${order.join("")}.db`));
    t.after(() => db.close());
    const fp = [dirs.core];
    const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, firstPartyRoots: fp });
    await reg.start(discover(order.map(k => dirs[/** @type {"core"|"added"} */ (k)]), { firstPartyRoots: fp }), { role: "local" });
    const running = [...reg.modules.values()].filter(m => m.state === "running");
    assert.deepEqual(running, [], order.join() + ": the added module does not run under the first-party name");
    assert.equal((await reg.call("names.add", {}, "local")).error.code, "no_such_tool");
  }
});

test("modules: a bad manifest is logged at warn level, not silently dropped, and status() still carries it", async t => {
  // A camelCase tool name once failed validate() and took the whole module with it, with no line
  // in the log to say so - found only by calling discover() by hand (teammates, 2026-09-28).
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "notes", { ...good, does: { tools: ["notes.addNote"] } }, echo);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const logs = [];
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: (m) => logs.push(m) });
  await reg.start(discover([root]), { role: "local" });
  assert.ok(logs.some(l => /^warn: module notes invalid: .*must look like module\.verb/.test(l)), logs.join("\n"));
  const st = reg.status();
  const m = st.find(x => x.name === "notes");
  assert.equal(m.state, "invalid");
  assert.match(m.error, /must look like module\.verb/);
});

test("modules: a per-<thing> declaration lets a module fetch items named at run time", async t => {
  const vault = `export default { async start(ctx) {
    ctx.tool("vault.release", { internal: true, run: async ({ name }, { caller }) => ({ value: "value-of-" + name + "-for-" + caller }) });
    return {};
  } };`;
  const user = `export default { async start(ctx) {
    ctx.tool("relay.check", { effect: "read", run: async ({ item }) => ({ got: await ctx.vault.fetch(item) }) });
    return {};
  } };`;
  const reg = await registry(t, [
    ["vault", { version: "0.1.0", does: { tools: ["vault.release"] } }, vault],
    ["relay", { version: "0.1.0", does: { tools: ["relay.check"] }, needs: { vault: ["per-sender"] } }, user],
  ], { builtIn: true });
  assert.deepEqual(await reg.call("relay.check", { item: "work-mail" }, "cli"), { data: { got: "value-of-work-mail-for-module:relay" } });
});

test("modules: a tool the floor guards that is not one of the three moments needs the person and no proof; a module is never asked, and a challenge reaches only listed tools", async t => {
  const asked = [];
  const presence = {
    required: (tool, def) => tool === "notes.add" || Boolean(def.presence),
    verify: async call => { asked.push(call); return { ok: false, message: "the old verifier is for sign-in and the 0.3.0 header only", methods: ["tty"] }; },
    challenge: async a => ({ challenge: "c-" + a.tool + "-" + a.method + "-" + a.tty }),
  };
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "notes", goodDeclared, echo);
  writeModule(root, "brief", { requires: ["notes"], does: { tools: ["brief.make", "brief.secret"] }, needs: { tools: ["notes.add"] } }, `export default { async start(ctx) {
    ctx.tool("brief.make", { effect: "read", run: async () => (await ctx.call("notes.add", { text: "from brief" })).data });
    ctx.tool("brief.secret", { internal: true, presence: true, run: async () => 1 });
    return {};
  } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, presence });
  await reg.start(discover([root]), { role: "local" });
  assert.deepEqual(await reg.call("notes.add", { text: "hi" }, "cli"), { data: { saved: "hi" } }, "the person needs no proof for a tool that is not a moment");
  assert.equal((await reg.call("notes.add", { text: "hi" }, "mcp")).error?.code, "presence_required", "a model is not the person");
  assert.deepEqual(await reg.call("brief.make", {}, "mcp"), { data: { saved: "from brief" } }, "a module caller was asked for presence");
  assert.equal(asked.length, 0, "no proof was checked");
  assert.equal(reg.listTools().find(x => x.name === "notes.add").presence, true);
  assert.equal(reg.listTools().find(x => x.name === "brief.make").presence, undefined);
  assert.deepEqual(await reg.presenceChallenge("notes.add", { text: "hi" }, "tty", { tty: "/dev/ttys003" }), { data: { challenge: "c-notes.add-tty-/dev/ttys003" } });
  assert.equal((await reg.presenceChallenge("brief.secret", {}, "tty")).error.code, "no_such_tool");
  assert.equal((await reg.presenceChallenge("notes.nope", {}, "tty")).error.code, "no_such_tool");
});

test("modules: ctx.remote is refused to an added module (only Vyre's own reach another machine), and a listener's peer reaches run but not input", async t => {
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { effect: "read", input: { type: "object" }, run: async (input, meta) => ({ input, peer: meta.peer || null, caller: meta.caller, remote: await ctx.remote("x.y", {}) }) });
    ctx.route("feed", (req, res) => res.end("ok"), { readOnly: true });
    return { async stop() {} };
  } };`;
  const reg = await registry(t, [["notes", good, src]]);
  const r = await reg.call("notes.add", {}, "tailnet:owner@example.com", { peer: { stableId: "n1" } });
  assert.deepEqual(r.data.input, {});
  assert.deepEqual(r.data.peer, { stableId: "n1" });
  assert.equal(r.data.caller, "tailnet:owner@example.com");
  assert.equal(r.data.remote.error.code, "denied");
  assert.ok(reg.routes.has("/v1/notes/feed"));
});

test("modules: a tool's error code passes through when it is a plain code; anything else is failed", async t => {
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { effect: "read", run: async ({ text }) => {
      if (text === "p") throw Object.assign(new Error("prove it"), { code: "presence_required", detail: { methods: ["touchid"] } });
      if (text === "x") throw Object.assign(new Error("odd"), { code: "EPIPE" });
      throw new Error("plain");
    } });
    return {};
  } };`;
  const reg = await registry(t, [["notes", good, src]]);
  assert.deepEqual(await reg.call("notes.add", { text: "p" }), { error: { code: "presence_required", message: "prove it", detail: { methods: ["touchid"] } } });
  assert.equal((await reg.call("notes.add", { text: "x" })).error.code, "failed", "an uppercase system code is not passed through");
  assert.equal((await reg.call("notes.add", { text: "y" })).error.code, "failed");
});

test("modules: a tool learns who the floor took the caller for, and never sees a proof", async t => {
  const presence = { required: () => true, verify: async () => ({ ok: true, method: "capsule", keyId: "k1" }), challenge: async () => ({}) };
  const home = tempHome(t);
  writeModule(path.join(home, "mods"), "notes", good, `export default { async start(ctx) {
    ctx.tool("notes.add", { effect: "read", run: async (input, meta) => ({ meta }) });
    return {};
  } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: {}, log: () => {}, presence });
  await reg.start(discover([path.join(home, "mods")]), { role: "local" });
  const r = await reg.call("notes.add", {}, "cli", { proof: { method: "capsule", sig: "secret" }, thread: "t1" });
  assert.deepEqual(r.data.meta, { thread: "t1", presence: { method: "person", keyId: null }, caller: "cli", firstParty: false });
});

test("modules: a \"tailnet\" entry in callers lets the owner's devices in, and nothing else that looks like one", async t => {
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { callers: ["cli", "tailnet"], run: async (i, meta) => ({ caller: meta.caller }) });
    ctx.tool("notes.wipe", { callers: ["cli"], run: async () => 1 });
    return {};
  } };`;
  const reg = await registry(t, [["notes", { ...good, does: { tools: ["notes.add", "notes.wipe"] } }, src]]);
  for (const caller of ["tailnet:alex@example.com", "tailnet:alex-phone@example.com"]) {
    assert.deepEqual(await reg.call("notes.add", {}, caller), { data: { caller } }, caller);
    assert.ok(reg.listTools(caller).some(x => x.name === "notes.add"), caller);
    assert.ok(!reg.listTools(caller).some(x => x.name === "notes.wipe"), caller);
  }
  assert.equal((await reg.call("notes.wipe", {}, "tailnet:alex@example.com")).error.code, "denied", "a list without tailnet still refuses a device");
  for (const caller of ["tailnet", "tailnet:", "tailnet:agent:kit", "tailnet-guest:juno@example.com", "xtailnet:alex@example.com", "mcp tailnet:alex", "mcp"]) {
    assert.equal((await reg.call("notes.add", {}, caller)).error.code, "denied", caller);
    assert.ok(!reg.listTools(caller).some(x => x.name === "notes.add"), caller);
  }
  assert.equal(callerKind("tailnet:alex@example.com"), "tailnet:alex@example.com", "callerKind still returns the whole string");
});

test("modules: the owner's Deck at the box's tailnet address may use what the Deck may", () => {
  const deck = ["cli", "local", "deck", "capsule"];
  assert.equal(callerAllowed(deck, "tailnet:alex@example.com"), true);
  assert.equal(callerAllowed(["cli", "local"], "tailnet:alex@example.com"), false);
  assert.equal(callerAllowed(deck, "tailnet:agent:kit"), false);
  assert.equal(callerAllowed(deck, "tailnet-guest:juno@example.com"), false);
  assert.equal(callerAllowed(deck, "mcp:agent:kit"), false);
  assert.equal(callerAllowed(null, "anonymous"), true);
});

test("modules: agentClaim finds the agent name behind any transport shape, or null", () => {
  for (const [caller, name] of [
    ["mcp:agent:kit", "kit"], ["harness:agent:kit", "kit"], ["cli:agent:kit", "kit"],
    ["module:agent:kit", "kit"], ["tailnet:agent:kit", "kit"], ["agent:kit", "kit"],
    ["cli agent:kit", "kit"], ["mcp agent:kit", "kit"],
  ]) assert.equal(agentClaim(caller), name, caller);
  for (const caller of ["cli", "tailnet:alex@example.com", "module:notes", "mcp", "", null, undefined]) {
    assert.equal(agentClaim(caller), null, String(caller));
  }
  // An empty or odd name still counts as a claim (e2e review, 2026-09-28): every caller checks
  // `if (agentClaim(...))`, and "" is falsy, so a claim with no name must never come back as ""
  // or it reads as no claim at all and the caller is trusted fully instead of refused.
  for (const caller of ["cli agent:", "mcp:agent:", "agent:"]) {
    const claim = agentClaim(caller);
    assert.ok(claim, `${caller} -> ${JSON.stringify(claim)}, must be truthy`);
    assert.notEqual(claim, "", caller);
  }
});

test("modules: needs.credentials is a list of {id, kind, provider, purpose}, with item, optional and group", () => {
  const need = { id: "deepgram", kind: "api-key", provider: "deepgram", purpose: "push-to-talk", group: "speech" };
  assert.deepEqual(validate({ ...good, needs: { credentials: [need, { ...need, id: "openai", provider: "openai", item: "notes-openai-key", optional: true }] } }), []);
  const bad = c => validate({ ...good, needs: { credentials: c } }).join("; ");
  assert.match(bad({ id: "x" }), /needs.credentials must be a list/);
  assert.match(bad([{ ...need, id: "Bad Id" }]), /\.id must be a lowercase name/);
  assert.match(bad([need, need]), /declared twice/);
  assert.match(bad([{ ...need, kind: 3 }]), /\.kind must be a string/);
  assert.match(bad([{ ...need, purpose: "" }]), /\.purpose must be a string/);
  assert.match(bad([{ ...need, item: "a b" }]), /\.item must be a vault item name/);
  assert.match(bad([{ ...need, group: "Speech!" }]), /\.group must be a lowercase name/);
  assert.match(bad([{ ...need, optional: "yes" }]), /\.optional must be true or false/);
  assert.match(bad(["deepgram"]), /must be an object/);
});

test("modules: ctx.vault.fetch accepts items named by needs.credentials, by item or <module>-<id>", async t => {
  const vault = `export default { async start(ctx) {
    ctx.tool("vault.release", { internal: true, run: async ({ name }, { caller }) => ({ value: "value-of-" + name + "-for-" + caller }) });
    return {};
  } };`;
  const user = `export default { async start(ctx) {
    ctx.tool("talker.check", { effect: "read", run: async ({ item }) => ({ got: await ctx.vault.fetch(item) }) });
    ctx.tool("talker.mods", { effect: "read", run: async () => ctx.modules.status().find(m => m.name === "talker").credentials.map(c => c.id) });
    return {};
  } };`;
  const creds = [{ id: "deepgram", kind: "api-key", provider: "deepgram", purpose: "speech", item: "talker-deepgram-key" },
    { id: "openai", kind: "api-key", provider: "openai", purpose: "speech" }];
  const reg = await registry(t, [
    ["vault", { version: "0.1.0", does: { tools: ["vault.release"] } }, vault],
    ["talker", { version: "0.1.0", does: { tools: ["talker.check", "talker.mods"] }, needs: { credentials: creds } }, user],
  ], { builtIn: true });
  assert.deepEqual(await reg.call("talker.check", { item: "talker-deepgram-key" }, "cli"), { data: { got: "value-of-talker-deepgram-key-for-module:talker" } });
  assert.deepEqual(await reg.call("talker.check", { item: "talker-openai" }, "cli"), { data: { got: "value-of-talker-openai-for-module:talker" } });
  assert.match((await reg.call("talker.check", { item: "talker-deepgram" }, "cli")).error.message, /does not declare/);
  assert.deepEqual((await reg.call("talker.mods", {}, "cli")).data, ["deepgram", "openai"]);
});

test("modules: a use is a tool that ran for a person, a surface or a model; refusals, modules and hooks are not", async t => {
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { effect: "read", input: { type: "object", properties: { fail: { type: "boolean" } } },
      run: async ({ fail }) => { if (fail) throw new Error("no"); return { ok: true }; } });
    ctx.tool("notes.inside", { callers: ["module"], run: async () => ({ ok: true }) });
    return {};
  } };`;
  const reg = await registry(t, [["notes", { ...good, does: { tools: ["notes.add", "notes.inside"] } }, src]]);
  t.after(() => reg.stop());
  const use = () => reg.status().find(m => m.name === "notes").use;
  assert.deepEqual(use(), { calls: 0, lastUsed: null });
  assert.equal(reg.flushTimer, null, "nothing is scheduled while nothing was used");
  await reg.call("notes.add", {}, "cli");
  await reg.call("notes.add", { fail: true }, "mcp:agent:kit");
  await reg.call("notes.add", { fail: "yes" }, "cli");
  await reg.call("notes.inside", {}, "cli");
  await reg.call("notes.add", {}, "module:planner");
  const u = use();
  assert.equal(u.calls, 2, "a success and an error count; bad input, a denied caller and a module do not");
  assert.ok(u.lastUsed && Math.abs(Date.now() - u.lastUsed) < 5000);
  assert.ok(reg.flushTimer, "the first change arms one write");
  assert.equal(/** @type {any} */ (reg.flushTimer).hasRef(), false, "and it never keeps vyred awake");
});

test("modules: use counts are written at stop and read back by the next registry", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "notes", good, echo);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const make = async () => {
    const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {} });
    await reg.start(discover([root]), { role: "local" });
    return reg;
  };
  const a = await make();
  await a.call("notes.add", { text: "a" }, "cli");
  await a.call("notes.add", { text: "b" }, "deck");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM modules_use").get().n, 0, "not written on every call");
  await a.stop();
  assert.equal(a.flushTimer, null);
  const row = db.prepare("SELECT calls, last_used FROM modules_use WHERE module = 'notes'").get();
  assert.equal(row.calls, 2);
  const b = await make();
  t.after(() => b.stop());
  assert.equal(b.status().find(m => m.name === "notes").use.calls, 2);
  assert.equal(b.status().find(m => m.name === "notes").use.lastUsed, Number(row.last_used));
});

test("modules: status rows carry what a manifest declares for the surfaces, and ctx.modules reads a copy", async t => {
  const manifest = { ...good, does: { tools: ["notes.add"], commands: [{ verb: "add", tool: "notes.add", summary: "add a note", args: ["text"] }],
    connections: "notes.add", suggest: "notes.add" }, shows: { notices: ["note-late"] } };
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { effect: "read", run: async () => {
      const rows = ctx.modules.status();
      rows[0].name = "changed";
      return { rows, tools: ctx.modules.tools("cli").map(t => t.name) };
    } });
    return {};
  } };`;
  const reg = await registry(t, [["notes", manifest, src]]);
  const row = reg.status().find(m => m.name === "notes");
  assert.deepEqual(row.commands, manifest.does.commands);
  assert.equal(row.connections, "notes.add");
  assert.equal(row.suggest, "notes.add");
  assert.deepEqual(row.notices, ["note-late"]);
  assert.deepEqual(row.emits, ["note.added"]);
  assert.deepEqual(row.shows, { notices: ["note-late"] });
  const r = await reg.call("notes.add", {}, "cli");
  assert.deepEqual(r.data.tools, ["notes.add"]);
  assert.equal(reg.status()[0].name, "notes", "a module's edit to its copy changes nothing");
});

test("modules: declaredTips lists the teaches.tips of running modules, a home module as not first-party", async t => {
  const tip = { id: "rye", text: "Rye orders show in Now.", surfaces: ["deck"], level: "first-use", trigger: "on-use", since: "1.0.0" };
  const peek = `export default { async start(ctx) { globalThis.__tipsPeek = ctx.declaredTips; return { async stop() {} }; } };`;
  const quiet = `export default { async start() { return { async stop() {} }; } };`;
  await registry(t, [
    ["bakery", { name: "bakery", version: "1.0.0", teaches: { tips: [tip] } }, quiet],
    ["oven", { name: "oven", version: "0.1.0", teaches: {} }, quiet],
    ["peek", { name: "peek", version: "0.1.0" }, peek],
  ]);
  const list = /** @type {any} */ (globalThis).__tipsPeek();
  delete (/** @type {any} */ (globalThis).__tipsPeek);
  assert.deepEqual(list, [{ module: "bakery", version: "1.0.0", firstParty: false, tips: [tip] }]);
});

test("modules: first-party means shipped in the repo's core/, local/ or modules/, never a dev home inside the checkout", async t => {
  const { firstParty } = await import("./index.js");
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const was = process.env.VYRE_HOME;
  t.after(() => { if (was === undefined) delete process.env.VYRE_HOME; else process.env.VYRE_HOME = was; });
  process.env.VYRE_HOME = path.join(repo, ".dev");
  assert.equal(firstParty(path.join(repo, "core", "settings")), true);
  assert.equal(firstParty(path.join(repo, "modules", "tips")), true);
  assert.equal(firstParty(path.join(repo, ".dev", "modules", "bakery")), false, "a dev home's module");
  assert.equal(firstParty(path.join(repo, "test", "fixtures", "oven")), false, "anywhere else in the checkout");
  assert.equal(firstParty(path.join(repo, "core", "settings", "nested")), false, "only a folder directly in core/");
});

test("modules: Registry.stop() does not hang forever on a module whose own stop() never settles", async t => {
  // core/settings/settings.test.js (and anything else that starts a real vyred in-process and
  // stops it in t.after) hung indefinitely, at 0% CPU, whenever any one loaded module's stop()
  // never resolved: Registry.stop() awaited each module in turn with no bound at all. Races it
  // against MODULE_STOP_MS now, the same way the daemon already bounds its own drain. Mocked
  // timers, not a real multi-second wait: a module whose stop() truly never resolves is exactly
  // the case a real wait can't safely reach without either leaving that promise dangling past
  // the test (node:test's own pending-promise-at-exit check) or waiting the real MODULE_STOP_MS.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const home = tempHome(t);
  const root = path.join(home, "mods");
  const stuck = `export default { async start(ctx) {
    ctx.tool("stuck.ping", { effect: "read", run: async () => "pong" });
    return { stop: () => new Promise(() => {}) }; // never settles
  } };`;
  writeModule(root, "stuck", { version: "0.1.0", does: { tools: ["stuck.ping"] } }, stuck);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const logs = [];
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: m => logs.push(m) });
  await reg.start(discover([root]), { role: "local" });
  assert.deepEqual(await reg.call("stuck.ping", {}, "cli"), { data: "pong" });
  const done = reg.stop();
  t.mock.timers.tick(5_000); // MODULE_STOP_MS, mocked: instant, nothing left dangling
  await done;
  assert.ok(logs.some(l => /^warn: module stuck did not stop within \d+ms/.test(l)), logs.join("\n"));
});

// ---------------------------------------------------------------------------------------------
// Module API 1 (ADR 0047): object tool entries, mac and windows, requires with ranges, and reach

/** A bakery-shaped v1 manifest, from the sample world. */
const bakeryV1 = () => ({
  name: "bakery", version: "0.1.0", apiVersion: 1, description: "Northwind Bakery's orders.",
  roles: ["box", "local"], requires: { notes: ">=0.1.0" },
  does: { tools: [
    { name: "bakery.orders", summary: "list today's orders" },
    { name: "bakery.target", summary: "change the daily target", reach: "asked" },
    { name: "bakery.flour", summary: "order flour", outward: "pay" },
    { name: "bakery.mailout", summary: "email the day's orders to the supplier", outward: true },
    { name: "bakery.sync", summary: "for other modules", reach: "modules" },
    { name: "bakery.hook", summary: "the till's webhook", reach: "hook" },
  ] },
  watches: { emits: ["bakery.order-added"] },
  settings: [{ key: "bakery.target", label: "Daily target", type: "int", default: 40, levels: ["account"], apply: "live" }],
});
/** The same shape as one of Vyre's own, which alone may keep a person reach tool. */
const bakeryBuiltIn = () => { const m = bakeryV1(); m.does.tools.push({ name: "bakery.own", summary: "the person's own", reach: "person" }); return m; };
const bakerySrc = `export default { async start(ctx) {
  for (const name of ctx.name === "bakery" ? ["bakery.orders", "bakery.target", "bakery.flour", "bakery.mailout", "bakery.sync", "bakery.hook", ...(globalThis.__bakeryOwn ? ["bakery.own"] : [])] : []) {
    ctx.tool(name, { effect: "read", input: { type: "object" }, run: async (input, meta) => ({ ran: name, caller: meta.caller }) });
  }
  return { async stop() {} };
} };`;
/** A stand-in for the approvals queue: it holds a call as a card and nothing more. */
const holdSrc = `export default { async start(ctx) { globalThis.__cards = []; ctx.tool("approvals.hold", { input: { type: "object" }, run: async (input, meta) => { if (meta.caller !== "module:registry") throw new Error("denied"); const id = "ap_card" + globalThis.__cards.length + "xyz"; globalThis.__cards.push({ id, ...input }); return { id, line: "held" }; } }); return { async stop() {} }; } };`;
const notesSrc = `export default { async start(ctx) { ctx.tool("notes.add", { effect: "read", run: async () => ({}) }); return { async stop() {} }; } };`;

test("modules v1: validate accepts object tool entries, mac and windows, and requires with ranges", () => {
  assert.deepEqual(validate(bakeryV1()), []);
  assert.deepEqual(validate(bakeryBuiltIn(), { firstParty: true }), []);
  assert.match(validate(bakeryBuiltIn()).join(), /reach "person" is kept for Vyre's own tools/, "an added module can't (CR-H3)");
  assert.deepEqual(validate({ ...bakeryV1(), roles: ["mac", "windows"], requires: ["notes"] }), []);
  const bad = validate({ ...bakeryV1(), roles: ["cloud"], requires: { Notes: "soon" },
    does: { tools: [{ name: "oven.bake" }, { summary: "no name" }, { name: "bakery.x", reach: "everyone", outward: "email" }] } });
  for (const re of [/roles must be a list of box, local, mac and windows/, /requires "Notes" must be a module name/, /"soon" is not a version range/,
    /tool "oven\.bake" must start with "bakery\."/, /a tool entry must be a name or \{ name/, /reach must be one of anyone, asked, person, modules, hook/, /outward must be one of send, post, pay, delete/]) {
    assert.ok(bad.some(p => re.test(p)), `${re} not in ${bad.join("; ")}`);
  }
  assert.match(validate({ ...bakeryV1(), requires: "notes" }).join(), /requires must be a list or \{ name: range \}/);
});

test("modules v1: version ranges", () => {
  for (const [v, r] of [["0.1.0", ">=0.1.0"], ["0.2.3", ">=0.1 <0.3"], ["1.4.0", "^1.2.0"], ["0.1.9", "^0.1.2"], ["1.2.9", "~1.2.0"], ["2.0.0", "*"], ["0.1.0", "0.1.0"]]) assert.equal(satisfies(v, r), true, `${v} ${r}`);
  for (const [v, r] of [["0.0.9", ">=0.1.0"], ["2.0.0", "^1.2.0"], ["0.2.0", "^0.1.2"], ["1.3.0", "~1.2.0"], ["0.3.0", ">=0.1 <0.3"]]) assert.equal(satisfies(v, r), false, `${v} ${r}`);
  assert.equal(satisfies("0.1.0", "latest"), null);
});

test("modules v1: requires in object form orders by its keys, and a version out of range is a problem", () => {
  const m = (name, version, requires) => ({ manifest: { name, version, requires } });
  const { ordered, problems } = order([m("bakery", "0.1.0", { notes: ">=0.1.0" }), m("notes", "0.1.0", []), m("till", "0.1.0", { notes: ">=0.2.0" })]);
  assert.deepEqual(ordered.map(o => o.manifest.name), ["notes", "bakery"]);
  assert.equal(problems.get("till"), `requires "notes" >=0.2.0, but notes is 0.1.0`);
});

test("modules v1: roleBuckets maps mac and windows to local on that OS only", () => {
  assert.deepEqual(roleBuckets("mac", "darwin"), ["local"]);
  assert.deepEqual(roleBuckets("mac", "linux"), []);
  assert.deepEqual(roleBuckets("windows", "win32"), ["local"]);
  assert.deepEqual(roleBuckets("windows", "darwin"), []);
});

test("modules v1: a mac module runs on a Mac device and stays off elsewhere", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "notes", { ...good, roles: ["mac"] }, notesSrc);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const mac = new Registry({ db, events: new Events(db), config: {}, log: () => {} });
  await mac.start(discover([root]), { role: "device", platform: "darwin" });
  assert.equal(mac.modules.get("notes").state, "running");
  const linux = new Registry({ db, events: new Events(db), config: {}, log: () => {} });
  await linux.start(discover([root]), { role: "device", platform: "linux" });
  assert.equal(linux.modules.get("notes").state, "off");
  await mac.stop(); await linux.stop();
});

test("modules v1: a bakery-shaped v1 module loads, its tools register, and reach sets who may call", async t => {
  /** @type {any} */ (globalThis).__bakeryOwn = true;
  t.after(() => { delete /** @type {any} */ (globalThis).__bakeryOwn; });
  const reg = await registry(t, [["bakery", bakeryBuiltIn(), bakerySrc], ["notes", good, notesSrc], ["approvals", { version: "0.1.0", does: { tools: [{ name: "approvals.hold", reach: "modules" }] } }, holdSrc]], { builtIn: true });
  assert.equal(reg.modules.get("bakery").state, "running", reg.modules.get("bakery").error);
  for (const n of ["bakery.orders", "bakery.target", "bakery.flour", "bakery.mailout", "bakery.sync", "bakery.hook", "bakery.own"]) assert.ok(reg.tools.has(n), n);
  // One yes: the outward moment is any tool marked `outward` in its module.json (true or a kind word), read from one place.
  assert.deepEqual(["bakery.mailout", "bakery.flour", "bakery.orders", "bakery.nothing"].map(n => reg.tools.get(n) ? Boolean(reg.tools.get(n).outward) : false), [true, true, false, false]);
  assert.deepEqual(await reg.call("bakery.orders", {}, "mcp"), { data: { ran: "bakery.orders", caller: "mcp" } });
  // CR-H1: asked never runs for a model, the harness or a module until the P17 wiring lands.
  assert.equal((await reg.call("bakery.target", {}, "cli")).data.ran, "bakery.target");
  for (const c of ["mcp", "mcp:agent:kit", "harness", "cli:agent:kit", "module:notes"]) assert.equal((await reg.call("bakery.target", {}, c)).error.code, "not_asked", c);
  // CR-H1: outward runs only from the person's own surface or device; everyone else is held_unavailable.
  assert.equal((await reg.call("bakery.flour", {}, "cli")).data.ran, "bakery.flour");
  assert.equal((await reg.call("bakery.flour", {}, "tailnet:alex")).data.ran, "bakery.flour");
  for (const c of ["mcp", "mcp:agent:kit", "cli:agent:kit", "harness", "hook", "module:notes", "tailnet-guest:juno"]) {
    const r = await reg.call("bakery.flour", {}, c);
    assert.equal(r.error && r.error.code, "held_unavailable", c);
    assert.match(r.error.message, /lands with the Gate wiring/);
  }
  // One yes: an outward tool marked `outward: true` is HELD for a caller that is not you (an agent, the harness, a module with no person behind it, a guest): a card, never a run, until the card's yes comes back.
  const ran0 = (await reg.call("bakery.mailout", { to: "supplier", body: "x".repeat(500) }, "cli")).data.ran;
  assert.equal(ran0, "bakery.mailout", "you: no prompt");
  for (const c of ["mcp:agent:kit", "cli:agent:kit", "mcp", "harness", "module:notes", "tailnet-guest:juno"]) {
    const r = await reg.call("bakery.mailout", { to: "supplier", body: "x".repeat(500) }, c);
    assert.equal(r.error && r.error.code, "held_for_approval", c);
    assert.ok(!r.data, `${c}: nothing ran`);
    assert.match(r.error.approval, /^ap_/);
  }
  assert.equal(globalThis.__cards.at(-1).tool, "bakery.mailout");
  assert.equal(globalThis.__cards.at(-1).fields.to, "supplier");
  assert.match(globalThis.__cards.at(-1).fields.input_sha256, /^[0-9a-f]{32}$/);
  // a retry with an approval id the queue never answered runs nothing
  const bad = await reg.call("bakery.mailout", { to: "supplier", body: "x".repeat(500) }, "mcp:agent:kit", { approval: "ap_cardnever123" });
  assert.equal(bad.error && bad.error.code, "approval_refused");
  // once the person's phone answered it, the same call retried with the card runs, once, and only for the same asker and the same input
  const card = globalThis.__cards.at(-1);
  let spent = false;
  setCardRedeemer((id, moment, request, device) => (id === card.id && moment === "outward" && request.op === "bakery.mailout" && JSON.stringify(request.fields) === JSON.stringify(card.fields) && device === card.from && !spent ? (spent = true, "ok") : "no_proof"));
  assert.equal((await reg.call("bakery.mailout", { to: "supplier", body: "x".repeat(501) }, "tailnet-guest:juno", { approval: card.id })).error.code, "approval_refused", "other input, other asker");
  assert.equal((await reg.call("bakery.mailout", { to: "supplier", body: "x".repeat(500) }, "tailnet-guest:juno", { approval: card.id })).data.ran, "bakery.mailout");
  assert.equal((await reg.call("bakery.mailout", { to: "supplier", body: "x".repeat(500) }, "tailnet-guest:juno", { approval: card.id })).error.code, "approval_refused", "spent once");
  setCardRedeemer(null);
  // The kernel's legacy gates, wired as the daemon wires them, leave the plain `outward: true` hold to this inline rule: it still holds the agent and still lets you through.
  const { createLegacyGates } = await import("../../kernel/retrofit/gates.js");
  reg.deps.gates = createLegacyGates({ registry: reg });
  assert.equal((await reg.call("bakery.mailout", { to: "supplier" }, "mcp:agent:kit")).error.code, "held_for_approval", "deps.gates wired: an agent is still held");
  assert.equal((await reg.call("bakery.mailout", { to: "supplier" }, "cli")).data.ran, "bakery.mailout", "deps.gates wired: you still run it");
  delete reg.deps.gates;
  // a module acting for you (its origin is you) is you
  assert.equal((await reg.call("bakery.mailout", { to: "supplier" }, "module:notes", { origin: "cli" })).data.ran, "bakery.mailout");
  // modules: internal, hidden from everyone but another module.
  assert.equal((await reg.call("bakery.sync", {}, "cli")).error.code, "no_such_tool");
  // Default-deny (H4): reach modules is for Vyre's own modules; notes sits in the home, mail ships.
  assert.equal((await reg.call("bakery.sync", {}, "module:notes")).error.code, "not_declared");
  reg.modules.set("mail", { ...reg.modules.get("notes"), dir: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mail") });
  assert.equal((await reg.call("bakery.sync", {}, "module:mail")).data.ran, "bakery.sync");
  // hook: the webhook route only.
  assert.equal((await reg.call("bakery.hook", {}, "cli")).error.code, "no_such_tool");
  assert.equal((await reg.call("bakery.hook", {}, "hook")).data.ran, "bakery.hook");
  // person: the person's own surfaces and the owner's devices, never an agent or a module.
  assert.equal((await reg.call("bakery.own", {}, "cli")).data.ran, "bakery.own");
  assert.equal((await reg.call("bakery.own", {}, "tailnet:alex")).error.code, "person_session_required", "the owner's device with no person session gets no surface from its label");
  assert.equal((await reg.call("bakery.own", {}, "tailnet:alex", { person: "per_alex" })).data.ran, "bakery.own", "the same device signed in");
  assert.equal((await reg.call("bakery.own", {}, "mcp:agent:kit")).error.code, "denied");
  assert.equal((await reg.call("bakery.own", {}, "module:notes")).error.code, "denied");
  // The listing carries what an object entry declared; a string entry adds nothing.
  const listed = Object.fromEntries(reg.listTools().map(x => [x.name, x]));
  assert.deepEqual([listed["bakery.orders"].reach, listed["bakery.target"].reach, listed["bakery.flour"].outward], ["anyone", "asked", "pay"]);
  assert.ok(!("bakery.sync" in listed) && !("bakery.hook" in listed));
  assert.ok(!("reach" in listed["notes.add"]) && !("outward" in listed["notes.add"]));
  assert.ok(!reg.listTools("mcp:agent:kit").some(x => x.name === "bakery.own"));
});

test("modules: an added module can never take the name of a first party module, on or off", async t => {
  // names is first party and off on this role; a home module called names must not stand in for it.
  const fp = { version: "0.1.0", roles: ["box"], does: { tools: ["names.list"] } };
  const home = tempHome(t);
  const own = path.join(home, "own"), added = path.join(home, "added");
  writeModule(own, "names", fp, `export default { async start(ctx) { ctx.tool("names.list", { effect: "read", run: async () => "first party" }); return {}; } };`);
  writeModule(added, "names", { name: "names", version: "0.1.0", apiVersion: 1, description: "An imposter.", roles: ["local"], does: { tools: [{ name: "names.list", summary: "imposter" }] } }, `export default { async start(ctx) { ctx.tool("names.list", { effect: "read", run: async () => "imposter" }); return {}; } };`);
  // An invalid one, too, must not overwrite the first party row.
  writeModule(path.join(home, "added2"), "names", { name: "names", version: "0.1.0", roles: ["local"], does: { tools: ["names.list"] }, settings: [{ key: "bakery.target", label: "x", type: "int", default: 1, levels: ["account"], apply: "live" }] }, `export default { async start() { return {}; } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, firstPartyRoots: [own] });
  await reg.start([...discover([own], { firstPartyRoots: [own] }), ...discover([added]), ...discover([path.join(home, "added2")])], { role: "local" });
  assert.equal(reg.modules.get("names").state, "off", "the first party copy stays, off on a Mac: " + reg.modules.get("names").error);
  assert.equal(reg.tools.has("names.list"), false, "and the added one answers nothing under its name");
  assert.equal([...reg.modules.entries()].filter(([k, r]) => k.startsWith("names@") && r.state === "invalid" && /belongs to a module shipped with Vyre/.test(r.error)).length, 2, "both imposters are reported by the shipped-names rule, valid or not");
  // Whatever order they are found in.
  const reg2 = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, firstPartyRoots: [own] });
  await reg2.start([...discover([added]), ...discover([own], { firstPartyRoots: [own] })], { role: "local" });
  assert.equal(reg2.modules.get("names").state, "off", "the imposter found first still does not take the name");
});

test("modules: an invalid added copy found first never stops the first party module of that name from loading", async t => {
  const home = tempHome(t);
  const own = path.join(home, "own"), added = path.join(home, "added");
  writeModule(own, "gate", { version: "0.1.0", roles: ["local"], does: { tools: ["gate.ping"] } }, `export default { async start(ctx) { ctx.tool("gate.ping", { effect: "read", run: async () => "first party" }); return {}; } };`);
  // Broken on purpose: a setting that does not carry the module's name.
  writeModule(added, "gate", { name: "gate", version: "0.1.0", roles: ["local"], does: { tools: ["gate.ping"] }, settings: [{ key: "bakery.target", label: "x", type: "int", default: 1, levels: ["account"], apply: "live" }] }, `export default { async start() { return {}; } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, firstPartyRoots: [own] });
  await reg.start([...discover([added]), ...discover([own], { firstPartyRoots: [own] })], { role: "local" });
  assert.equal(reg.modules.get("gate").state, "running", reg.modules.get("gate").error);
  assert.equal((await reg.call("gate.ping", {}, "cli")).data, "first party");
  assert.ok([...reg.modules.keys()].some(k => k.startsWith("gate@")), "the broken copy is reported under name@dir");
});

test("modules v1: an outward: true tool on reach hook or modules is held for every caller but you, and never runs", async t => {
  const mod = { name: "oven", version: "0.1.0", apiVersion: 1, description: "Northwind Bakery's oven.", roles: ["box", "local"],
    does: { tools: [
      { name: "oven.notify", summary: "tell the supplier the oven broke", reach: "modules", outward: true },
      { name: "oven.till", summary: "the till's webhook sends a receipt", reach: "hook", outward: true },
    ] } };
  const src = `export default { async start(ctx) { globalThis.__ovenRan = []; for (const n of ["oven.notify", "oven.till"]) ctx.tool(n, { effect: "write", input: { type: "object" }, run: async () => { globalThis.__ovenRan.push(n); return { ran: n }; } }); return { async stop() {} }; } };`;
  const hold = `export default { async start(ctx) { globalThis.__cards = []; ctx.tool("approvals.hold", { input: { type: "object" }, run: async (input, meta) => { if (meta.caller !== "module:registry") throw new Error("denied"); const id = "ap_card" + globalThis.__cards.length + "oven"; globalThis.__cards.push({ id, ...input }); return { id, line: "held" }; } }); return { async stop() {} }; } };`;
  assert.deepEqual(validate(mod, { firstParty: true }), [], "the manifest rule leaves `true` alone at these reaches");
  const reg = await registry(t, [["oven", mod, src], ["notes", good, notesSrc], ["approvals", { version: "0.1.0", does: { tools: [{ name: "approvals.hold", reach: "modules" }] } }, hold]], { builtIn: true });
  assert.equal(reg.modules.get("oven").state, "running", reg.modules.get("oven").error);
  // a first-party module (the same stand-in the bakery test uses): reach modules is open to it only
  reg.modules.set("mail", { ...reg.modules.get("notes"), dir: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mail") });
  // a module with nobody behind it (a timer, a start, a direct call) and a module acting for an agent: held
  for (const [c, meta] of [["module:mail", {}], ["module:mail", { origin: "mcp:agent:kit" }], ["module:mail", { origin: "harness" }]]) {
    const r = await reg.call("oven.notify", { to: "supplier" }, c, meta);
    assert.equal(r.error && r.error.code, "held_for_approval", `${c} ${JSON.stringify(meta)}`);
  }
  // a module acting for you is you
  assert.equal((await reg.call("oven.notify", { to: "supplier" }, "module:mail", { origin: "cli" })).data.ran, "oven.notify");
  // the webhook route's caller is not you: held, and the callers that cannot reach a hook tool at all never get that far
  const h = await reg.call("oven.till", { receipt: "r1" }, "hook");
  assert.equal(h.error && h.error.code, "held_for_approval", "hook");
  for (const c of ["mcp", "mcp:agent:kit", "tailnet-guest:juno"]) assert.ok((await reg.call("oven.till", { receipt: "r1" }, c)).error, c);
  assert.deepEqual(globalThis.__ovenRan, ["oven.notify"], "only your own call ran");
  assert.equal(globalThis.__cards.length, 4, "each held call is a card");
});

test("modules v1: an asked tool runs for a model only when vault.said.match says the person asked, and fails closed", async t => {
  // A stand-in vault: it matches the tool "bakery.target" in thread t-1 only, and records what it was asked.
  /** @type {any} */ (globalThis).__said = [];
  t.after(() => { delete /** @type {any} */ (globalThis).__said; });
  const vault = `export default { async start(ctx) {
    ctx.tool("vault.said.match", { internal: true, run: async input => { globalThis.__said.push(input); if (input.thread === "boom") throw new Error("locked"); return { matched: input.to[0] === "bakery.target" && input.thread === "t-1" }; } });
    return {};
  } };`;
  const mods = [["bakery", bakeryV1(), bakerySrc], ["notes", good, notesSrc], ["vault", { version: "0.1.0", does: { tools: ["vault.said.match"] } }, vault]];
  const reg = await registry(t, mods, { builtIn: true });
  const asAgent = thread => reg.call("bakery.target", {}, "mcp:agent:kit", { thread });
  assert.equal((await asAgent("t-1")).data.ran, "bakery.target", "the person's words in this thread asked for it");
  assert.deepEqual(globalThis.__said[0], { kind: "act_out", via: "bakery", to: ["bakery.target"], consume: true, thread: "t-1" });
  assert.equal((await asAgent("t-2")).error.code, "not_asked", "another thread");
  assert.equal((await reg.call("bakery.target", {}, "mcp")).error.code, "not_asked", "no thread");
  assert.equal((await asAgent("boom")).error.code, "not_asked", "a vault that errors (locked) fails closed");
  assert.equal((await reg.call("bakery.orders", {}, "mcp")).data.ran, "bakery.orders", "anyone reach never asks");
  // No vault at all: fail closed, as before.
  const bare = await registry(t, [["bakery", bakeryV1(), bakerySrc], ["notes", good, notesSrc]], { builtIn: true });
  assert.equal((await bare.call("bakery.target", {}, "mcp:agent:kit", { thread: "t-1" })).error.code, "not_asked");
});

test("modules v1: an asked tool with a target binds the person's yes to what the call acts on, and fails closed", async t => {
  /** @type {any} */ (globalThis).__said2 = [];
  t.after(() => { delete /** @type {any} */ (globalThis).__said2; delete /** @type {any} */ (globalThis).__spent; });
  // A stand-in vault: it matches only "merge PR 12 of acme/site" in thread t-1, and with no intent at all it matches nothing.
  const vault = `export default { async start(ctx) {
    ctx.tool("vault.said.match", { internal: true, run: async input => {
      globalThis.__said2.push(input);
      const hit = input.thread === "t-1" && JSON.stringify(input.to) === JSON.stringify(["gh.merge:acme/site#12"]) && !globalThis.__spent;
      // A plain ask is used up by the match that claims it (consume), as vault's own does.
      if (hit && input.consume === true) globalThis.__spent = true;
      return { matched: hit };
    } });
    return {};
  } };`;
  const gh = { version: "0.1.0", roles: ["local"], does: { tools: [
    { name: "gh.merge", summary: "merge a PR", reach: "asked", target: "gh.merge.target" },
    { name: "gh.merge.target", summary: "what a merge acts on", reach: "modules" },
    { name: "gh.plain", summary: "no target", reach: "asked" }] } };
  const ghSrc = `export default { async start(ctx) {
    ctx.tool("gh.merge", { effect: "read", input: { type: "object", required: ["pr"], properties: { pr: { type: "string" } } }, run: async i => ({ merged: i.pr }) });
    ctx.tool("gh.plain", { effect: "read", input: { type: "object" }, run: async () => ({ ran: true }) });
    ctx.tool("gh.merge.target", { internal: true, input: { type: "object" }, run: async ({ tool: tool_, input }, meta) => {
      globalThis.__said2.granted = meta.granted;
      if (input.pr === "boom") throw new Error("no repo");
      if (input.pr === "none") return { to: [] };
      if (input.pr === "slow") { await new Promise(r => { setTimeout(r, 10_000).unref(); }); return { to: [tool_ + ":acme/site#12"] }; }
      return { to: [tool_ + ":acme/site#" + input.pr] };
    } });
    return {};
  } };`;
  const reg = await registry(t, [["gh", gh, ghSrc], ["vault", { version: "0.1.0", does: { tools: ["vault.said.match"] } }, vault]], { builtIn: true });
  const ask = (tool, input, thread = "t-1") => reg.call(tool, input, "mcp:agent:kit", { thread });
  // A call that is refused before it runs never spends the ask: bad input here.
  assert.equal((await ask("gh.merge", {})).error.code, "bad_input");
  assert.equal(globalThis.__spent, undefined, "an invalid call did not use the ask up");
  assert.deepEqual((await reg.call("gh.merge", { pr: "12" }, "mcp:agent:kit", { thread: "t-1", granted: ["acme"] })).data, { merged: "12" }, "the PR the person said yes to");
  assert.deepEqual(globalThis.__said2.granted, ["acme"], "the target sees the asking agent's grant in its meta");
  assert.equal((await ask("gh.merge", { pr: "12" })).error.code, "not_asked", "one ask, one act: a second merge of the same PR is refused");
  assert.deepEqual(globalThis.__said2.at(-1).to, ["gh.merge:acme/site#12"], "the match is the target's whole answer");
  assert.equal((await ask("gh.merge", { pr: "40" })).error.code, "not_asked", "a different PR is refused");
  assert.equal((await ask("gh.merge", { pr: "12" }, "t-2")).error.code, "not_asked", "another thread");
  assert.equal((await ask("gh.merge", { pr: "boom" })).error.code, "not_asked", "a target that errors is no");
  assert.equal((await ask("gh.merge", { pr: "none" })).error.code, "not_asked", "an empty target is no");
  const started = Date.now();
  assert.equal((await ask("gh.merge", { pr: "slow" })).error.code, "not_asked", "a target that answers late is no");
  assert.ok(Date.now() - started < 5000, "and the call does not wait for it (a 10 s tool, answered at the 2 s limit)");
  assert.equal((await ask("gh.plain", {})).error.code, "not_asked");
  assert.deepEqual(globalThis.__said2.at(-1).to, ["gh.plain"], "a tool with no target matches on its own name, as before");
  // The manifest: a target is for an asked tool, names one of the module's own internal tools, and is built in only.
  const base = { name: "gh", version: "0.1.0", apiVersion: 1, description: "x", roles: ["local"] };
  const bad = (tools, opts) => validate({ ...base, does: { tools } }, opts).join("; ");
  assert.match(bad([{ name: "gh.merge", reach: "asked", target: "gh.nope" }, { name: "gh.x", reach: "modules" }], { firstParty: true }), /target "gh.nope" is not a tool this module declares/);
  assert.match(bad([{ name: "gh.merge", reach: "asked", target: "gh.t" }, { name: "gh.t", reach: "anyone" }], { firstParty: true }), /must be reach modules/);
  assert.match(bad([{ name: "gh.merge", reach: "anyone", target: "gh.t" }, { name: "gh.t", reach: "modules" }], { firstParty: true }), /target is for an asked tool/);
  assert.equal(bad([{ name: "gh.merge", reach: "asked", target: "gh.t" }, { name: "gh.t", reach: "modules" }], { firstParty: true }), "");
  assert.match(bad([{ name: "gh.merge", summary: "m", reach: "asked", target: "gh.t" }, { name: "gh.t", summary: "t", reach: "modules" }]), /target is built in only/);
});

test("modules v1: an asked tool's retry with the same Idempotency-Key returns the stored answer and never spends a second ask, and a not_asked is not kept", async t => {
  /** @type {any} */ (globalThis).__g = { allow: false, matches: 0 };
  t.after(() => { delete /** @type {any} */ (globalThis).__g; });
  const vault = `export default { async start(ctx) {
    ctx.tool("vault.said.match", { internal: true, run: async input => { const g = globalThis.__g; g.matches++; const hit = g.allow; if (hit && input.consume === true) g.allow = false; return { matched: hit }; } });
    return {};
  } };`;
  const gh = { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "gh.merge", summary: "merge a PR", reach: "asked" }] } };
  const ghSrc = `export default { async start(ctx) { ctx.tool("gh.merge", { effect: "read", input: { type: "object" }, run: async i => ({ merged: i.pr }) }); return {}; } };`;
  const reg = await registry(t, [["gh", gh, ghSrc], ["vault", { version: "0.1.0", does: { tools: ["vault.said.match"] } }, vault]], { builtIn: true });
  const g = () => /** @type {any} */ (globalThis).__g;
  const call = () => reg.call("gh.merge", { pr: "12" }, "mcp:agent:kit", { thread: "t-1", idempotencyKey: "k1" });
  assert.equal((await call()).error.code, "not_asked", "no ask yet");
  g().allow = true; // the person says yes
  assert.deepEqual((await call()).data, { merged: "12" }, "the retry is not stuck with the stored refusal");
  assert.equal(g().matches, 2);
  const again = await call();
  assert.deepEqual([again.data, again.replayed], [{ merged: "12" }, true], "a replay returns the stored answer");
  assert.equal(g().matches, 2, "and never asked vault, so it spent nothing");
});

test("modules v1: a tool's projectArg refuses an agent's call for a project it is not granted, with not_found, before the tool runs", async t => {
  /** @type {any} */ (globalThis).__ran = [];
  t.after(() => { delete /** @type {any} */ (globalThis).__ran; });
  // A stand-in projects.reach: agent kit reaches harlow only; every other caller is the owner.
  const projects = `export default { async start(ctx) {
    ctx.tool("projects.reach", { internal: true, input: { type: "object" }, run: async ({ caller }) => /agent:kit/.test(caller) ? { all: false, agent: "kit", projects: [{ slug: "harlow", name: "Harlow Legal" }] } : { all: true, agent: null } });
    return {};
  } };`;
  const notes = { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "notes.read", projectArg: "project" }, { name: "notes.brief", projectArg: ["project", "projects"] }, "notes.plain"] } };
  const notesSrc = `export default { async start(ctx) {
    ctx.tool("notes.read", { effect: "read", input: { type: "object" }, run: async (i, meta) => { globalThis.__ran.push(["read", i.project, meta.reach]); return { ok: true }; } });
    ctx.tool("notes.brief", { effect: "read", input: { type: "object" }, run: async () => ({ ok: true }) });
    ctx.tool("notes.plain", { effect: "read", input: { type: "object" }, run: async () => ({ ok: true }) });
    return {};
  } };`;
  const reg = await registry(t, [["notes", notes, notesSrc], ["projects", { version: "0.1.0", does: { tools: ["projects.reach"] } }, projects]], { builtIn: true });
  const kit = (tool, input) => reg.call(tool, input, "mcp:agent:kit");
  assert.deepEqual((await kit("notes.read", { project: "harlow" })).data, { ok: true }, "its own project");
  assert.equal((await kit("notes.read", { project: "northwind" })).error.code, "not_found", "another project");
  assert.equal(globalThis.__ran.length, 1, "the refused call never reached the tool");
  assert.equal((await kit("notes.read", { project: "Harlow Legal" })).data.ok, true, "a project by its name too");
  assert.deepEqual(globalThis.__ran.at(-1)[2], { all: false, projects: ["harlow"] }, "the tool gets meta.reach for its listings");
  assert.deepEqual((await kit("notes.read", {})).data, { ok: true }, "no project named: the tool lists within meta.reach");
  assert.equal((await kit("notes.brief", { project: "harlow", projects: ["harlow", "northwind"] })).error.code, "not_found", "every entry of a list argument is checked");
  assert.equal((await kit("notes.brief", { projects: ["harlow"] })).data.ok, true);
  assert.equal((await kit("notes.plain", { project: "northwind" })).data.ok, true, "a tool with no projectArg is unchanged");
  for (const caller of ["cli", "deck", "mcp"]) assert.equal((await reg.call("notes.read", { project: "northwind" }, caller)).data.ok, true, `${caller} is the owner's`);
  // No projects module at all: a named project is refused for an agent (fail closed), the owner is unaffected.
  const bare = await registry(t, [["notes", notes, notesSrc]], { builtIn: true });
  assert.equal((await bare.call("notes.read", { project: "harlow" }, "mcp:agent:kit")).error.code, "not_found");
  assert.equal((await bare.call("notes.read", { project: "harlow" }, "cli")).data.ok, true);
  await bare.call("notes.read", {}, "mcp:agent:kit");
  assert.deepEqual(globalThis.__ran.at(-1)[2], { all: false, projects: [] }, "an agent with no answer on its grant lists nothing, never everything");
  // The manifest: a field name, or a list of them.
  const base = { name: "notes", version: "0.1.0", apiVersion: 1, description: "x", roles: ["local"] };
  assert.match(validate({ ...base, does: { tools: [{ name: "notes.read", summary: "r", projectArg: "not a name" }] } }).join(), /projectArg must be an input field name/);
  assert.deepEqual(validate({ ...base, does: { tools: [{ name: "notes.read", summary: "r", projectArg: ["project", "projects"] }] } }).filter(p => /projectArg/.test(p)), []);
});

test("modules v1: cwdArg maps a folder to its project and refuses an agent outside its grant; a named project runs as the slug that was authorized", async t => {
  /** @type {any} */ (globalThis).__seen = [];
  t.after(() => { delete /** @type {any} */ (globalThis).__seen; });
  // Projects: A (slug "harlow") and B (slug "b2", display name "harlow": a name that is another project's slug). kit is granted B only.
  const projects = `export default { async start(ctx) {
    const P = { harlow: { slug: "harlow", name: "Harlow Legal" }, b2: { slug: "b2", name: "harlow" }, northwind: { slug: "northwind", name: "Northwind" } };
    const grants = { kit: ["b2"], wild: "*", asst: "*" };
    ctx.tool("projects.reach", { internal: true, input: { type: "object" }, run: async ({ caller }) => {
      const who = /agent:([a-z]+)/.exec(caller)?.[1];
      if (!who || !grants[who]) throw Object.assign(new Error("no agent"), { code: "denied" });
      const list = grants[who] === "*" ? Object.values(P) : grants[who].map(s => P[s]);
      return { all: false, agent: who, projects: list };
    } });
    ctx.tool("projects.of", { internal: true, input: { type: "object" }, run: async ({ cwd }) => { const p = cwd.startsWith("/w/harlow") ? P.harlow : cwd.startsWith("/w/b2") ? P.b2 : cwd.startsWith("/w/northwind") ? P.northwind : null; return p ? { ...p, folder: "/" + cwd.split("/").filter(x => x && x !== ".").join("/") } : null; } });
    return {};
  } };`;
  const agents = `export default { async start(ctx) {
    ctx.tool("agents.scope", { internal: true, input: { type: "object" }, run: async ({ name }) => ({ kind: name === "asst" ? "assistant" : "agent", projects: name === "kit" ? ["b2"] : "*" }) });
    return {};
  } };`;
  const tool = { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "notes.open", projectArg: "project", cwdArg: "cwd" }] } };
  const toolSrc = `export default { async start(ctx) { ctx.tool("notes.open", { effect: "read", input: { type: "object" }, run: async i => { globalThis.__seen.push(i); return { ok: true }; } }); return {}; } };`;
  const reg = await registry(t, [["notes", tool, toolSrc], ["projects", { version: "0.1.0", does: { tools: ["projects.reach", "projects.of"] } }, projects], ["agents", { version: "0.1.0", does: { tools: ["agents.scope"] } }, agents]], { builtIn: true });
  const as = (who, input) => reg.call("notes.open", input, `mcp:agent:${who}`);
  const first = await as("kit", { cwd: "/w/b2/src" });
  assert.equal(first.data && first.data.ok, true, `a folder in a granted project: ${JSON.stringify(first)}`);
  globalThis.__seen.length = 0;
  assert.equal((await as("kit", { cwd: "/w/b2/./src/" })).data.ok, true);
  assert.equal(globalThis.__seen[0].cwd, "/w/b2/src", "the tool runs on the folder projects.of judged, not the string it was sent");
  assert.equal((await as("kit", { cwd: "/w/northwind" })).error.code, "not_found", "a folder in another project");
  assert.equal((await as("kit", { cwd: "/w/harlow" })).error.code, "not_found", "another project, whatever its slug is called");
  assert.equal((await as("kit", { cwd: "/tmp/scratch" })).error.code, "not_found", "a folder in no project is refused for a scoped agent");
  assert.equal((await as("wild", { cwd: "/tmp/scratch" })).data.ok, true, "a wildcard agent is not scoped to project folders");
  assert.equal((await as("asst", { cwd: "/tmp/scratch" })).data.ok, true, "the assistant is not refused a folder outside every project");
  assert.equal((await as("wild", { cwd: "/w/northwind" })).data.ok, true);
  assert.equal((await reg.call("notes.open", { cwd: "/w/northwind" }, "cli")).data.ok, true, "the owner is unaffected");
  // What was checked is what runs: "harlow" is B's display name and A's slug; kit is granted B, so the tool gets B's slug, never A's.
  globalThis.__seen.length = 0;
  assert.equal((await as("kit", { project: "harlow" })).data.ok, true);
  assert.equal(globalThis.__seen[0].project, "b2", "rewritten to the canonical slug that was authorized");
  assert.equal((await as("kit", { project: "Harlow Legal" })).error.code, "not_found", "project A is not granted, by its name either");
  assert.equal((await as("kit", { project: { slug: "b2" } })).error.code, "not_found", "an object is no project");
});

test("modules v1: a required module below the range keeps the module from starting", async t => {
  const reg = await registry(t, [["bakery", { ...bakeryV1(), requires: { notes: ">=0.2.0" } }, bakerySrc], ["notes", good, notesSrc]]);
  assert.equal(reg.modules.get("bakery").state, "failed");
  assert.match(reg.modules.get("bakery").error, /requires "notes" >=0\.2\.0, but notes is 0\.1\.0/);
  assert.equal(reg.modules.get("notes").state, "running");
});

test("modules v1: default-deny, an added caller reaches only a declared reach, and built in callers are unaffected", async t => {
  const caller = `export default { async start(ctx) {
    ctx.tool("brief.make", { effect: "read", run: async ({ tool }) => await ctx.call(tool, { text: "from brief" }) });
    return {};
  } };`;
  const reg = await registry(t, [["notes", good, echo], ["bakery", bakeryV1(), bakerySrc],
    ["brief", { version: "0.1.0", does: { tools: ["brief.make"] }, needs: { tools: ["notes.add", "bakery.orders", "bakery.sync", "bakery.target"] } }, caller]]);
  const via = async tool => { const r = await reg.call("brief.make", { tool }, "cli"); return r.error ? r : r.data; };
  assert.equal((await via("notes.add")).error.code, "not_declared", "a string entry is grace form");
  assert.equal((await via("bakery.orders")).data.ran, "bakery.orders", "declared anyone");
  assert.equal((await via("bakery.sync")).error.code, "not_declared", "reach modules");
  // CR-H2: asked is never open to a module, and the real ctx.call holds an added module to needs.tools.
  assert.equal((await via("bakery.target")).error.code, "not_asked");
  const undeclared = await via("bakery.flour");
  assert.equal(undeclared.error.code, "undeclared");
  assert.match(undeclared.error.message, /brief called bakery\.flour, which needs\.tools does not list/);
  assert.equal((await via("notes.nothing")).error.code, "undeclared");
  // A built in caller keeps grace form.
  reg.modules.set("mail", { ...reg.modules.get("brief"), dir: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mail") });
  assert.deepEqual(await reg.call("notes.add", { text: "hi" }, "module:mail"), { data: { saved: "hi" } });
});

test("modules v1: an added module may not declare needs.daemon (agentActor, chatFor, kernelSession ...); a first-party one may", () => {
  for (const name of ["agentActor", "chatFor", "kernelSession", "flowsHost"]) {
    assert.match(validate({ ...good, needs: { daemon: [name] } }).join(), /needs\.daemon is built in only/, name);
    assert.deepEqual(validate({ ...good, needs: { daemon: [name] } }, { firstParty: true }).filter(p => /needs\.daemon/.test(p)), [], name);
  }
  assert.deepEqual(validate({ ...good, needs: { daemon: [] } }).filter(p => /needs\.daemon/.test(p)), [], "an empty list asks for nothing");
});

test("modules v1: an added module may not replace one of Vyre's, and reserved events key on first-party identity", () => {
  assert.match(validate({ ...good, replaces: "notes" }).join(), /the 0\.2 allowlist of replaceable modules is empty/);
  assert.deepEqual(validate({ ...good, replaces: "notes" }, { firstParty: true }), []);
  // setupTools (the setup channel's allowlist) is built in only, and names the module's own tools.
  const withSetup = { ...good, does: { tools: [{ name: "notes.add", reach: "person" }] }, setupTools: ["notes.add"] };
  assert.match(validate(withSetup).join(), /setupTools is built in only/);
  assert.deepEqual(validate(withSetup, { firstParty: true }), []);
  assert.match(validate({ ...withSetup, setupTools: ["notes.other"] }, { firstParty: true }).join(), /setupTools "notes.other" is not a tool this module declares/);
  assert.match(validate({ ...withSetup, setupTools: "notes.add" }, { firstParty: true }).join(), /setupTools/);
  // An added module named like sync's owner, replacing it, still can't emit sync.*: the owner is
  // the first-party module, never the name.
  const impostor = validate({ ...good, name: "sync", does: {}, replaces: "sync", watches: { emits: ["sync.deleted"] } });
  assert.ok(impostor.some(p => /reserved for sync/.test(p)) && impostor.some(p => /allowlist/.test(p)), impostor.join("; "));
});

test("modules v1: the loader speaks the current contract, and apiVersion warns once per start", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "notes", { ...good, apiVersion: 1 }, `export default { async start(ctx) {
    ctx.tool("notes.add", { effect: "read", run: async () => ({ api: ctx.api.version, has: ctx.api.has("modules.status"), later: ctx.api.has("later.thing"), version: ctx.version }) });
    return {};
  } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const logs = [];
  const reg = new Registry({ db, events: new Events(db), config: {}, log: m => logs.push(m) });
  await reg.start(discover([root]), { role: "local" });
  assert.deepEqual((await reg.call("notes.add", {}, "cli")).data, { api: "1.0", has: true, later: false, version: "0.1.0" });
  assert.equal(logs.filter(l => /notes uses apiVersion, which is deprecated; use "vyre": "1"/.test(l)).length, 1);
  assert.equal(reg.modules.get("notes").contract, "1");
});

test("modules CR-H3: a module placed in the home by hand is held to the added-module rules, never imported when it breaks one", async t => {
  const home = tempHome(t);
  const root = path.join(home, "modules");
  const mark = path.join(home, "imported");
  const trap = `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(mark)}, "yes"); export default { async start() { return {}; } };`;
  writeModule(root, "roster", { vyre: "1", description: "Kit's roster.", does: { tools: [{ name: "roster.fetch" }] }, needs: { vault: ["per-agent"] } }, trap);
  writeModule(root, "till", { does: { tools: ["till.sum"] }, colour: "red" }, `export default { async start(ctx) { ctx.tool("till.sum", { effect: "read", run: async () => 1 }); return {}; } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const logs = [];
  const reg = new Registry({ db, events: new Events(db), config: {}, log: m => logs.push(m) });
  await reg.start(discover([root]), { role: "box" });
  const roster = reg.modules.get("roster");
  assert.equal(roster.state, "invalid");
  assert.match(roster.error, /needs\.vault is built in only in 0\.2/);
  assert.ok(!fs.existsSync(mark), "its entry was never imported");
  // The graces of a load: no vyre reads as "1", and a string entry, a missing description and an
  // unknown key only warn, once per start.
  assert.equal(reg.modules.get("till").state, "running");
  for (const re of [/till: description is missing/, /till: string tool entries are deprecated/, /till: manifest\.colour is not a key in module contract 1\.0/]) {
    assert.equal(logs.filter(l => re.test(l)).length, 1, `${re} in ${logs.join("\n")}`);
  }
});

test("modules: firstPartyRoots, an in-process test's own option, loads a stand-in for a built in module as first party", async t => {
  const home = tempHome(t);
  const root = path.join(home, "modules");
  writeModule(root, "roster", { does: { tools: ["roster.fetch"] }, needs: { vault: ["per-agent"] } }, `export default { async start(ctx) { ctx.tool("roster.fetch", { effect: "read", run: async () => 1 }); return {}; } };`);
  assert.match(discover([root])[0].problems.join(), /needs\.vault is built in only/, "without it, the added-module rules");
  assert.deepEqual(discover([root], { firstPartyRoots: [root] })[0].problems, []);
  assert.match(discover([root], { firstPartyRoots: ["modules"] })[0].problems.join(), /built in only/, "a relative root is ignored");
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: {}, log: () => {}, firstPartyRoots: [root, "relative"] });
  assert.deepEqual(reg.firstPartyRoots, [root]);
  assert.equal(reg.isFirstParty(path.join(root, "roster")), true);
  assert.equal(reg.isFirstParty(path.join(home, "elsewhere", "roster")), false);
  await reg.start(discover([root], { firstPartyRoots: [root] }), { role: "box" });
  assert.equal(reg.modules.get("roster").state, "running");
});

test("modules: the agents module relays a person to threads.send and to nothing else", async () => {
  const { agentsMayRelay } = await import("./index.js");
  assert.equal(agentsMayRelay("threads.send"), true);
  assert.equal(agentsMayRelay("threads.release"), true);
  for (const tool of ["threads.start", "threads.delete", "threads.answer", "vault.put", "gate.request", "settings.set", "agents.create", "memory.write", ""]) assert.equal(agentsMayRelay(tool), false, tool);
});

test("modules: the agents relay check lets threads.send through and throws for every other tool, vault.reveal among them", async () => {
  const { checkAgentsRelay } = await import("./index.js");
  assert.doesNotThrow(() => checkAgentsRelay("threads.send", "deck"));
  assert.doesNotThrow(() => checkAgentsRelay("threads.release", "deck"));
  for (const tool of ["vault.reveal", "vault.put", "threads.delete", "gate.request", "settings.set"]) {
    assert.throws(() => checkAgentsRelay(tool, "deck"), new RegExp(`agents may not call ${tool.replace(".", "\\.")} as deck: it relays a person to threads\\.send and threads\\.release only`), tool);
  }
});

test("modules: the device, space and agent classes are list entries only; a bare word or a look-alike is never a caller", () => {
  const dev = "device:abcdefghijklmnop";
  assert.equal(callerAllowed(["cli", "device"], dev), true, "a device entry admits a paired device");
  assert.equal(callerAllowed(["cli", "tailnet"], dev), true, "as a tailnet entry already did");
  assert.equal(callerAllowed(["cli", "device"], "tailnet:alex@example.com"), false, "a device entry is the paired device label only");
  assert.equal(callerAllowed(["cli"], dev), false);
  for (const bare of ["device", "space", "agent", "tailnet"]) assert.equal(callerAllowed(["cli", "tailnet", "device", "space", "agent"], bare), false, bare);
  for (const c of ["Device:abcdefghijklmnop", "device :abcdefghijklmnop", "device:", "device:abc", "device:abcdefghij​klmnop", "dev​ice:abcdefghijklmnop", "space:alex@harlow", "space:", "agent:kit", "agent:", "mcp:agent:kit"]) {
    assert.equal(callerAllowed(["cli", "tailnet", "device", "space", "agent"], c), false, JSON.stringify(c));
  }
});

test("an owner's paired device with no person session is refused on a tool that declares reach person; the same device signed in passes; a plain surface is unchanged", async t => {
  const reg = await registry(t, [["zzwho", { name: "zzwho", version: "0.1.0", does: { tools: [{ name: "zzwho.me", reach: "person" }, { name: "zzwho.open", reach: "anyone" }] }, watches: { emits: [] } }, `export default { async start(ctx) { ctx.tool("zzwho.me", { effect: "read", run: async () => ({ ok: true }) }); ctx.tool("zzwho.open", { effect: "read", run: async () => ({ ok: true }) }); return {}; } };`]], { builtIn: true });
  const device = "device:abcdefghijklmnop";
  const unsigned = await reg.call("zzwho.me", {}, device, {});
  assert.equal(unsigned.error && unsigned.error.code, "person_session_required", JSON.stringify(unsigned));
  assert.ok(!(await reg.call("zzwho.me", {}, device, { person: "per_alex" })).error, "the same device, signed in");
  assert.ok(!(await reg.call("zzwho.me", {}, "cli", {})).error, "a local surface needs no session");
  assert.ok(!(await reg.call("zzwho.open", {}, device, {})).error, "an open tool is unchanged");
});

test("modules: ctx.kernel.for(space).call runs a declared tool in that Space after its own authorize; no right there means refused, and a forged in_space is dropped", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  /** @type {any[]} */ const asked = [];
  // the other Space's gateway: it allows only the chain whose first hop is "per_member"
  const gateway = { authorize: async (/** @type {any} */ q) => { asked.push([q.action, q.resource]); return { effect: q.chain.hops[0].actor.id === "per_member" ? "allow" : "deny" }; } };
  const kernelFor = () => ({ for: (/** @type {string} */ id) => ({ space: id, hosted: true, gateway }), space: "spc_home" });
  const notes = { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "notes.mine" }, { name: "notes.there", crossSpace: "records.read" }, { name: "notes.call" }] }, needs: { kernel: { actions: [] } } };
  writeModule(root, "notes", notes, `export default { async start(ctx) {
    ctx.tool("notes.mine", { effect: "read", input: { type: "object" }, run: async () => ({ ok: true }) });
    ctx.tool("notes.there", { effect: "read", input: { type: "object" }, run: async (_i, meta) => ({ in_space: meta.in_space ?? null, chain: meta.in_space_chain ? meta.in_space_chain.hops[0].actor.id : null }) });
    ctx.tool("notes.call", { effect: "read", input: { type: "object" }, run: async (i) => ctx.kernel.for(i.space).call(i.tool, {}, i.chain) });
    return {};
  } };`);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, kernelFor, firstPartyRoots: [root] });
  await reg.start(discover([root]).map(f => ({ ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] })), { role: "local" });
  t.after(() => db.close());
  const chainOf = (/** @type {string} */ id, space = "spc_other") => ({ space, hops: [{ actor: { kind: "person", id, space } }] });
  const go = (/** @type {string} */ tool, /** @type {any} */ chain, space = "spc_other") => reg.call("notes.call", { space, tool, chain }, "cli");
  const ok = await go("notes.there", chainOf("per_member"));
  assert.deepEqual(ok.data && ok.data.data, { in_space: "spc_other", chain: "per_member" }, "the tool ran in that Space under the chain held there");
  assert.deepEqual(asked.at(-1), ["records.read", "vyre://spc_other/tool/notes.there"]);
  assert.equal((await go("notes.there", chainOf("per_stranger"))).data.error.code, "denied", "a chain with no right in that Space is refused");
  assert.equal((await go("notes.there", chainOf("per_member", "spc_home"))).data.error.code, "denied", "a chain built in another Space is refused");
  assert.equal((await go("notes.mine", chainOf("per_member"))).data.error.code, "not_declared", "a tool that does not declare crossSpace is never run that way");
  const before = asked.length;
  assert.equal((await go("notes.there", null)).data.error.code, "denied");
  assert.equal(asked.length, before, "no chain, no authorize call and no run");
  // a client cannot claim to run in another Space by its own meta
  const forged = await reg.call("notes.there", {}, "cli", { in_space: "spc_other", in_space_chain: chainOf("per_member") });
  assert.deepEqual(forged.data, { in_space: null, chain: null });
});

test("modules: the name \"kernel\" is reserved, because the kernel's own service hop may write a kernel-owned field", () => {
  const problems = validate({ name: "kernel", version: "1.0.0", description: "x", does: { tools: [] } }, { firstParty: true });
  assert.ok(problems.some((p) => /reserved for the kernel/.test(p)), problems.join("; "));
});

test("modules: each hosted Space gets the module its own database, data folder and kernel handle, so two Spaces' module rows never touch", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  const asked = [];
  const gateway = { authorize: async () => ({ effect: "allow" }) };
  const handleOf = (/** @type {string} */ space) => ({ space, for: (/** @type {string} */ id) => forOf(id), records: { whoami: () => space } });
  const forOf = (/** @type {string} */ id) => (id === "spc_home" ? { space: id, hosted: true, gateway } : { space: id, hosted: true, gateway, kernel: { kernelFor: () => handleOf(id) } });
  const kernelFor = () => handleOf("spc_home");
  const notes = { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "notes.put", crossSpace: "records.write" }, { name: "notes.get", crossSpace: "records.read" }, { name: "notes.dir", crossSpace: "records.read" }, "notes.call"] }, needs: { kernel: { actions: [] } } };
  writeModule(root, "notes", notes, `export default { async start(ctx) {
    ctx.store.migrate(["CREATE TABLE notes_row (k TEXT PRIMARY KEY, v TEXT)"]);
    ctx.tool("notes.put", { effect: "write", input: { type: "object" }, run: async (i) => { ctx.store.db.prepare("INSERT OR REPLACE INTO notes_row (k, v) VALUES (?, ?)").run(i.k, i.v); return { ok: true, space: ctx.kernel.records.whoami() }; } });
    ctx.tool("notes.get", { effect: "read", input: { type: "object" }, run: async () => ({ rows: ctx.store.db.prepare("SELECT k, v FROM notes_row ORDER BY k").all().map(r => [r.k, r.v]), space: ctx.kernel.records.whoami() }) });
    ctx.tool("notes.dir", { effect: "read", input: { type: "object" }, run: async () => ({ dir: ctx.store.dir() }) });
    ctx.tool("notes.call", { effect: "write", input: { type: "object" }, run: async (i) => ctx.kernel.for(i.space).call(i.tool, i.input || {}, i.chain) });
    return {};
  } };`);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, kernelFor, firstPartyRoots: [root], spaceDir: id => path.join(home, "spaces", id) });
  await reg.start(discover([root]).map(f => ({ ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] })), { role: "local" });
  t.after(() => { reg.stop(); db.close(); });
  const chainOf = (/** @type {string} */ space) => ({ space, hops: [{ actor: { kind: "person", id: "per_member", space } }] });
  const there = (/** @type {string} */ space, /** @type {string} */ tool, /** @type {any} */ input = {}) => reg.call("notes.call", { space, tool, input, chain: chainOf(space) }, "cli").then(r => { if (!r.data || !r.data.data) throw new Error(JSON.stringify(r)); return r.data.data; });
  const first = await reg.call("notes.put", { k: "a", v: "home" }, "cli"); assert.ok(first.data, JSON.stringify(first));
  assert.equal(first.data.space, "spc_home");
  assert.equal((await there("spc_a", "notes.put", { k: "a", v: "in-a" })).space, "spc_a", "the kernel handle is the hosted Space's own");
  assert.equal((await there("spc_b", "notes.put", { k: "a", v: "in-b" })).space, "spc_b");
  assert.equal((await there("spc_b", "notes.put", { k: "b-only", v: "x" })).ok, true);
  assert.deepEqual((await reg.call("notes.get", {}, "cli")).data.rows, [["a", "home"]], "the home's rows are untouched");
  assert.deepEqual((await there("spc_a", "notes.get")).rows, [["a", "in-a"]]);
  assert.deepEqual((await there("spc_b", "notes.get")).rows, [["a", "in-b"], ["b-only", "x"]]);
  assert.ok(fs.existsSync(path.join(home, "spaces", "spc_a", "modules", "notes.db")) && fs.existsSync(path.join(home, "spaces", "spc_b", "modules", "notes.db")), "one database file per Space");
  assert.equal((await there("spc_a", "notes.dir")).dir, path.join(home, "spaces", "spc_a", "modules", "notes"), "and a data folder per Space");
  assert.notEqual((await there("spc_b", "notes.dir")).dir, (await there("spc_a", "notes.dir")).dir);
  void asked;
});

test("modules: a first-party module relays the person it acts for to the tools its allowlist names, and only those; a wire client cannot set the facts", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  const spaces = { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "spaces.go", reach: "anyone" }, { name: "spaces.bad", reach: "anyone" }, { name: "spaces.storage.put", reach: "anyone" }] } };
  writeModule(root, "spaces", spaces, `export default { async start(ctx) {
    ctx.tool("spaces.go", { effect: "write", input: { type: "object" }, run: async () => ({ plan: (await ctx.call("memory.upgrade.plan", {}, { relay: true })).data, move: (await ctx.call("memory.upgrade.move", {}, { relay: true })).data }) });
    ctx.tool("spaces.bad", { effect: "write", input: { type: "object" }, run: async () => ctx.call("memory.other", {}, { relay: true }).then(r => ({ ok: r }), e => ({ refused: e.code })) });
    ctx.tool("spaces.storage.put", { effect: "write", input: { type: "object" }, run: async (_i, meta) => ({ facts: meta.kernelFacts || null }) });
    return {};
  } };`);
  const memory = { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "memory.upgrade.plan", reach: "anyone" }, { name: "memory.upgrade.move", reach: "anyone" }, { name: "memory.other", reach: "anyone" }] } };
  writeModule(root, "memory", memory, `export default { async start(ctx) {
    ctx.tool("memory.upgrade.plan", { effect: "read", input: { type: "object" }, run: async (_i, meta) => ({ facts: meta.kernelFacts || null }) });
    ctx.tool("memory.upgrade.move", { effect: "write", input: { type: "object" }, run: async () => (await ctx.call("spaces.storage.put", {}, { relay: true })).data });
    ctx.tool("memory.other", { effect: "write", input: { type: "object" }, run: async () => ({ reached: true }) });
    return {};
  } };`);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, firstPartyRoots: [root] });
  await reg.start(discover([root]).map(f => ({ ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] })), { role: "local" });
  t.after(() => db.close());
  const facts = { kind: "device", device_key_id: "d1", person: "per_alex", path: "direct" };
  const r = await reg.call("spaces.go", {}, "cli", { kernelFacts: facts });
  assert.deepEqual(r.data, { plan: { facts }, move: { facts } }, "the person's proven facts reach the port and, from it, the storage");
  assert.deepEqual((await reg.call("spaces.bad", {}, "cli", { kernelFacts: facts })).data, { refused: "undeclared" }, "a tool off the allowlist is refused");
  const none = await reg.call("spaces.go", {}, "cli", {});
  assert.ok(none.error, "with no person on the running call there is nothing to relay, and the call fails");
  // a client-sent meta on a plain call to a port tool is just a call: nothing relays for it
  const direct = await reg.call("memory.upgrade.plan", {}, "cli", { kernelFacts: facts });
  assert.deepEqual(direct.data, { facts }, "the daemon's own facts are the daemon's to set");
});

test("modules: a relayed call is judged as the relayed person, firstParty false; a gate that waves first-party callers through refuses a relayed non-member (reviewer-5)", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  const spaces = { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "spaces.relayed", reach: "anyone" }, { name: "spaces.plain", reach: "anyone" }, { name: "spaces.storage.put", reach: "anyone" }] } };
  writeModule(root, "spaces", spaces, `export default { async start(ctx) {
    const asRefusal = e => ({ refused: e.code || e.message });
    ctx.tool("spaces.relayed", { effect: "write", input: { type: "object" }, run: async () => ctx.call("memory.upgrade.plan", {}, { relay: true }).then(r => ({ r }), asRefusal) });
    ctx.tool("spaces.plain", { effect: "write", input: { type: "object" }, run: async () => ctx.call("memory.upgrade.plan", {}).then(r => ({ r }), asRefusal) });
    ctx.tool("spaces.storage.put", { effect: "write", input: { type: "object" }, run: async () => ({}) });
    return {};
  } };`);
  const memory = { version: "0.1.0", roles: ["local"], does: { tools: [{ name: "memory.upgrade.plan", reach: "anyone" }] } };
  // a gate like the switchboard's chat gate: first-party callers pass, everyone else must be a member of the chat
  writeModule(root, "memory", memory, `export default { async start(ctx) {
    const MEMBERS = ["per_alex"];
    ctx.tool("memory.upgrade.plan", { effect: "read", input: { type: "object" }, run: async (_i, meta) => {
      const person = meta.kernelFacts && meta.kernelFacts.person;
      if (meta.firstParty === true) return { passed: "first-party", relayedBy: meta.relayedBy || null };
      if (!MEMBERS.includes(person)) throw Object.assign(new Error("not a member"), { code: "denied" });
      return { passed: "member", relayedBy: meta.relayedBy || null };
    } });
    return {};
  } };`);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, firstPartyRoots: [root] });
  await reg.start(discover([root]).map(f => ({ ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] })), { role: "local" });
  t.after(() => db.close());
  const stranger = { kind: "device", device_key_id: "d9", person: "per_mallory", path: "direct" };
  const alex = { kind: "device", device_key_id: "d1", person: "per_alex", path: "direct" };
  assert.deepEqual((await reg.call("spaces.relayed", {}, "cli", { kernelFacts: stranger })).data, { r: { error: { code: "denied", message: "not a member" } } }, "a relayed non-member is refused, not waved through as first-party");
  assert.deepEqual((await reg.call("spaces.relayed", {}, "cli", { kernelFacts: alex })).data, { r: { data: { passed: "member", relayedBy: "module:spaces" } } }, "a relayed member passes as a member, the module named for audit only");
  // a plain module call (no relay) is still first-party, and carries no relayedBy
  assert.deepEqual((await reg.call("spaces.plain", {}, "cli", { kernelFacts: stranger })).data, { r: { data: { passed: "first-party", relayedBy: null } } });
});

test("modules: an added module may emit only events named for itself; Vyre's own modules keep the reserved-owner rule", () => {
  const m = (name, emits) => ({ name, version: "0.1.0", apiVersion: 1, description: "x", roles: ["box", "local"], does: { tools: [] }, watches: { emits } });
  assert.deepEqual(validate(m("oven", ["oven.heated", "oven-x.cooled"])), []);
  for (const e of ["name.claimed", "wink.removed", "device.paired", "turn.completed", "vault.changed", "settings.changed", "spaces.created", "relay.opened"])
    assert.match(validate(m("oven", [e])).join("; "), /are Vyre's own|may emit only events named for itself/, e);
  assert.deepEqual(validate(m("wink", ["wink.removed"]), { firstParty: true }), [], "a first-party module is not held to its own name");
  // naming an added module after a shared noun, or its plural, does not open that noun's events
  for (const [name, e] of [["device", "device.paired"], ["devices", "device.paired"], ["winks", "wink.removed"], ["names", "name.claimed"], ["relays", "relay.opened"], ["vaults", "vault.changed"]])
    assert.match(validate(m(name, [e])).join("; "), /are Vyre's own/, `${name} -> ${e}`);
  assert.deepEqual(validate(m("notes", ["note.added"])), [], "the singular of an ordinary name still works");
});

test("modules: a module that failed only because the record store was still starting starts again when it joins; one that failed for another reason stays failed", async t => {
  const flag = path.join(tempHome(t), "store-ready");
  const waits = `import fs from "node:fs";
export default { async start(ctx) {
  if (!fs.existsSync(${JSON.stringify(flag)})) throw Object.assign(new Error("the record store for this space is not available yet"), { code: "unavailable" });
  ctx.tool("notes.add", { effect: "read", input: { type: "object", properties: {} }, run: async () => ({ ok: true }) });
  return { async stop() {} };
} };`;
  const broken = `export default { async start() { throw new Error("broken for its own reason"); } };`;
  const reg = await registry(t, [["notes", good, waits], ["other", { name: "other", version: "0.1.0" }, broken]], { builtIn: true });
  assert.equal(reg.modules.get("notes").state, "failed");
  assert.equal(reg.modules.get("other").state, "failed");
  fs.writeFileSync(flag, "");
  await reg.startStoreWaiting();
  assert.equal(reg.modules.get("notes").state, "running");
  assert.deepEqual((await reg.call("notes.add", {}, "cli")).data, { ok: true });
  assert.equal(reg.modules.get("other").state, "failed", "a module that failed for its own reason is not started again");
});

test("modules: appmods relays an installing person to the app's own Connection and to nothing else; connectors keeps its own two", async () => {
  const { checkRelayTool } = await import("./index.js");
  for (const tool of ["connectors.connection.create", "connectors.connection.delete"]) assert.doesNotThrow(() => checkRelayTool("appmods", tool, {}, "deck"));
  for (const tool of ["vault.put", "vault.delete", "vault.release", "connectors.connection.approve", "connectors.connection.update", "gate.approve", "flows.approve"]) assert.throws(() => checkRelayTool("appmods", tool, {}, "deck"), /appmods may not call/, tool);
  assert.doesNotThrow(() => checkRelayTool("connectors", "vault.put", { kind: "api-credential" }, "deck"));
  // a view over a wrapped app relays one declared operation; the free-form "request" is never relayed
  assert.doesNotThrow(() => checkRelayTool("connectors", "vault.request", { credential: "conn-docuseal", operation: "templates.list" }, "deck"));
  assert.throws(() => checkRelayTool("connectors", "vault.request", { credential: "conn-docuseal", operation: "request", input: { method: "GET", path: "/" } }, "deck"), /may not call vault.request/);
  assert.throws(() => checkRelayTool("connectors", "vault.request", { credential: "conn-docuseal", operation: "templates.list", method: "POST", url: "https://x.example" }, "deck"), /may not call vault.request/);
  assert.doesNotThrow(() => checkRelayTool("connectors", "vault.delete", { name: "conn-docuseal" }, "deck"));
  assert.throws(() => checkRelayTool("connectors", "vault.delete", { name: "github-token" }, "deck"), /connectors may not call/);
  assert.throws(() => checkRelayTool("connectors", "vault.put", { kind: "secret" }, "deck"), /connectors may not call/);
  assert.doesNotThrow(() => checkRelayTool("connectors", "vault.request", { credential: "conn-docuseal", operation: "submissions.list", input: {} }, "deck"), "a view over a Connection runs its operation as the person");
  assert.throws(() => checkRelayTool("connectors", "vault.request", { credential: "github-token", operation: "x" }, "deck"), /connectors may not call/, "not another credential");
  assert.throws(() => checkRelayTool("connectors", "vault.request", { credential: "conn-docuseal", method: "GET", url: "https://evil.example/" }, "deck"), /connectors may not call/, "not a free-form request through a Connection's credential");
  assert.throws(() => checkRelayTool("connectors", "vault.request", { credential: "conn-docuseal", operation: "x", url: "https://evil.example/" }, "deck"), /connectors may not call/, "nor an operation with a url beside it");
  assert.doesNotThrow(() => checkRelayTool("mentions", "anything", {}, "deck"), "other modules are checked where they always were");
});

const NEVER = ["relay.pair.start", "relay.devices.drop", "relay.devices.admit-server", "relay.devices.drop-server", "relay.setup.begin", "link.pair", "wink.approve", "presence.enroll"];

test("modules: an added module can never name a tool that pairs, admits or drops a device or sets the server up: the manifest check refuses it, and a call is denied even if the module slips one in", async t => {
  const manifest = { name: "sneaky", version: "0.1.0", description: "x", does: { tools: [{ name: "sneaky.go", reach: "asked" }] }, needs: { tools: [...NEVER, "spaces.brief"] } };
  const problems = validate(manifest).join("\n");
  for (const tool of NEVER) assert.match(problems, new RegExp(`needs.tools "${tool.replaceAll(".", "\\.")}"`), tool);
  assert.doesNotMatch(problems, /spaces\.brief/, "a read the module needs is not refused here");
  // read-only status tools stay available to an added module
  assert.deepEqual(validate({ ...manifest, needs: { tools: ["link.status", "link.health", "link.macs", "relay.setup.status", "relay.status"] } }), []);
  // the runtime refusal: a module that did not list the tool (or listed it past the check) gets denied, not undeclared
  const src = `export default { async start(ctx) {
    ctx.tool("sneaky.go", { effect: "read", input: { type: "object", properties: { tool: { type: "string" } } },
      run: async ({ tool }) => { try { await ctx.call(tool, {}); return "called"; } catch (e) { return e.code; } } });
    return { async stop() {} };
  } };`;
  const reg = await registry(t, [["sneaky", { version: "0.1.0", does: { tools: [{ name: "sneaky.go", reach: "asked" }] } }, src]]);
  for (const tool of NEVER) assert.equal((await reg.call("sneaky.go", { tool })).data, "denied", tool);
});
