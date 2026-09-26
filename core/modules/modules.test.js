// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { validate, discover, order, checkInput, Registry } from "./index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const good = { name: "notes", version: "0.1.0", does: { tools: ["notes.add"] }, watches: { emits: ["note.added"] } };

test("modules: a good manifest has no problems", () => {
  assert.deepEqual(validate(good), []);
});

test("modules: tools must carry the module's own name", () => {
  assert.match(validate({ ...good, does: { tools: ["vault.fetch"] } }).join(), /must start with "notes\."/);
});

test("modules: the five verbs must be objects", () => {
  assert.match(validate({ ...good, needs: ["x"] }).join(), /needs must be an object/);
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

async function registry(t, mods, { rules } = {}) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  for (const [name, manifest, src] of mods) writeModule(root, name, manifest, src);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, rules });
  await reg.start(discover([root]), { role: "local" });
  t.after(() => db.close());
  return reg;
}

const echo = `export default { async start(ctx) {
  ctx.tool("notes.add", { input: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    run: async ({ text }) => { ctx.events.emit("note.added", { text }); return { saved: text }; } });
  return { async stop() {} };
} };`;

test("modules: a module's tool runs through the registry and its event is recorded", async t => {
  const reg = await registry(t, [["notes", good, echo]]);
  assert.deepEqual(await reg.call("notes.add", { text: "hi" }), { data: { saved: "hi" } });
  assert.equal(reg.deps.events.since(0).at(-1).type, "note.added");
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
  const sneaky = `export default { async start(ctx) { ctx.tool("notes.delete-all", { run: async () => 1 }); return {}; } };`;
  const reg = await registry(t, [["notes", good, sneaky]]);
  assert.equal(reg.status()[0].state, "failed");
  assert.match(reg.status()[0].error, /does not declare/);
});

test("modules: every call passes through the rules, whoever makes it", async t => {
  const seen = [];
  const reg = await registry(t, [["notes", good, echo]], {
    rules: async call => { seen.push(call.caller); return call.input.text === "rm -rf" ? { allow: false, reason: "held" } : { allow: true }; },
  });
  assert.equal((await reg.call("notes.add", { text: "ok" }, "mcp")).data.saved, "ok");
  assert.deepEqual(await reg.call("notes.add", { text: "rm -rf" }, "http"), { error: { code: "denied", message: "held" } });
  assert.deepEqual(seen, ["mcp", "http"]);
});

test("modules: bad input is refused before the tool runs", async t => {
  const reg = await registry(t, [["notes", good, echo]]);
  assert.equal((await reg.call("notes.add", {})).error.code, "bad_input");
  assert.equal(reg.deps.events.since(0).filter(e => e.type === "note.added").length, 0);
});

test("modules: ctx.store migrations are bound to the module's own name", async t => {
  const src = `export default { async start(ctx) {
    ctx.store.migrate(["CREATE TABLE notes_items (id INTEGER PRIMARY KEY, body TEXT)"]);
    ctx.tool("notes.add", { run: async ({ text }) => { ctx.store.db.prepare("INSERT INTO notes_items (body) VALUES (?)").run(text); return { saved: true }; } });
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
    ctx.tool("brief.make", { run: async () => (await ctx.call("notes.add", { text: "from brief" })).data });
    return {};
  } };`;
  const reg = await registry(t, [["notes", good, echo], ["brief", { version: "0.1.0", requires: ["notes"], does: { tools: ["brief.make"] } }, caller]],
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
    ctx.tool("mailer.check", { run: async ({ item }) => ({ got: await ctx.vault.fetch(item) }) });
    return {};
  } };`;
  const reg = await registry(t, [
    ["vault", { version: "0.1.0", does: { tools: ["vault.release"] } }, vault],
    ["mailer", { version: "0.1.0", does: { tools: ["mailer.check"] }, needs: { vault: ["inbox"] } }, user],
  ]);
  assert.deepEqual(await reg.call("mailer.check", { item: "inbox" }, "cli"), { data: { got: "value-of-inbox-for-module:mailer" } });
  assert.match((await reg.call("mailer.check", { item: "bank" }, "cli")).error.message, /does not declare/);
  assert.equal((await reg.call("vault.release", { name: "inbox" }, "mcp")).error.code, "no_such_tool", "Claude reached the vault directly");
  assert.ok(!reg.listTools().some(x => x.name === "vault.release"), "an internal tool was listed");
});

test("modules: ctx.memory.teach checks the declared kinds and is a no-op without Memory", async t => {
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { run: async ({ kind }) => ({ taught: await ctx.memory.teach(kind, { text: "x" }) }) });
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
  writeModule(b, "notes", { ...good, does: { tools: ["notes.other"] } }, `export default { async start(ctx) { ctx.tool("notes.other", { run: async () => 1 }); return {}; } };`);
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

test("modules: a per-<thing> declaration lets a module fetch items named at run time", async t => {
  const vault = `export default { async start(ctx) {
    ctx.tool("vault.release", { internal: true, run: async ({ name }, { caller }) => ({ value: "value-of-" + name + "-for-" + caller }) });
    return {};
  } };`;
  const user = `export default { async start(ctx) {
    ctx.tool("relay.check", { run: async ({ item }) => ({ got: await ctx.vault.fetch(item) }) });
    return {};
  } };`;
  const reg = await registry(t, [
    ["vault", { version: "0.1.0", does: { tools: ["vault.release"] } }, vault],
    ["relay", { version: "0.1.0", does: { tools: ["relay.check"] }, needs: { vault: ["per-sender"] } }, user],
  ]);
  assert.deepEqual(await reg.call("relay.check", { item: "work-mail" }, "cli"), { data: { got: "value-of-work-mail-for-module:relay" } });
});

test("modules: a presence tool needs a proof from every caller but a module, and a challenge reaches only listed tools", async t => {
  const asked = [];
  const presence = {
    required: (tool, def) => tool === "notes.add" || Boolean(def.presence),
    verify: async call => { asked.push(call); return call.proof && call.proof.ok ? { ok: true, method: "tty" } : { ok: false, message: "prove it", methods: ["tty"] }; },
    challenge: async a => ({ challenge: "c-" + a.tool + "-" + a.method + "-" + a.tty }),
  };
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "notes", good, echo);
  writeModule(root, "brief", { requires: ["notes"], does: { tools: ["brief.make", "brief.secret"] } }, `export default { async start(ctx) {
    ctx.tool("brief.make", { run: async () => (await ctx.call("notes.add", { text: "from brief" })).data });
    ctx.tool("brief.secret", { internal: true, presence: true, run: async () => 1 });
    return {};
  } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, presence });
  await reg.start(discover([root]), { role: "local" });
  assert.deepEqual(await reg.call("notes.add", { text: "hi" }, "cli"), { error: { code: "presence_required", message: "prove it", methods: ["tty"] } });
  assert.deepEqual(await reg.call("notes.add", { text: "hi" }, "cli", { proof: { ok: true } }), { data: { saved: "hi" } });
  assert.deepEqual(asked[1].proof, { ok: true });
  assert.equal(asked[1].caller, "cli");
  assert.deepEqual(await reg.call("brief.make", {}, "mcp"), { data: { saved: "from brief" } }, "a module caller was asked for presence");
  assert.equal(asked.length, 2);
  assert.equal(reg.listTools().find(x => x.name === "notes.add").presence, true);
  assert.equal(reg.listTools().find(x => x.name === "brief.make").presence, undefined);
  assert.deepEqual(await reg.presenceChallenge("notes.add", { text: "hi" }, "tty", { tty: "/dev/ttys003" }), { data: { challenge: "c-notes.add-tty-/dev/ttys003" } });
  assert.equal((await reg.presenceChallenge("brief.secret", {}, "tty")).error.code, "no_such_tool");
  assert.equal((await reg.presenceChallenge("notes.nope", {}, "tty")).error.code, "no_such_tool");
});
