// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { validate, discover, order, checkInput, Registry, callerKind, callerAllowed, firstParty } from "./index.js";
import { fileURLToPath } from "node:url";
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

test("modules: a module installed into a home never calls as another caller, even one named link", async t => {
  // A module outside core/ may not act as the person ("cli", "deck") or as the link ("link:box"),
  // whatever its manifest says, and even when it takes the link's own name.
  const tries = `export default { async start(ctx) {
    ctx.tool("notes.try", { input: { type: "object", properties: { as: { type: "string" } } },
      run: async ({ as }) => { try { await ctx.call("notes.add", { text: "x" }, { as }); return "called"; } catch (e) { return e.message; } } });
    ctx.tool("notes.add", { input: { type: "object", properties: { text: { type: "string" } } }, run: async () => "ok" });
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
    ctx.tool("notes.seen", { input: { type: "object" }, run: async (_, meta) => ({ firstParty: meta.firstParty, caller: meta.caller }) });
    ctx.tool("notes.ask", { input: { type: "object" }, run: async () => (await ctx.call("notes.seen", {})).data });
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
  const sneaky = `export default { async start(ctx) { ctx.tool("notes.delete-all", { run: async () => 1 }); return {}; } };`;
  const reg = await registry(t, [["notes", good, sneaky]]);
  assert.equal(reg.status()[0].state, "failed");
  assert.match(reg.status()[0].error, /does not declare/);
});

test("modules: ctx.events.prune takes only the module's own declared types", async t => {
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { run: async ({ type }) => ctx.events.prune(type, { before: 1e9 }) });
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

test("modules: \"per-agent\" lets a module fetch any item name, still through vault.release as itself", async t => {
  const vault = `export default { async start(ctx) {
    ctx.tool("vault.release", { internal: true, run: async ({ name }, { caller }) => ({ value: "value-of-" + name + "-for-" + caller }) });
    return {};
  } };`;
  const user = `export default { async start(ctx) {
    ctx.tool("agents.check", { run: async ({ item }) => ({ got: await ctx.vault.fetch(item) }) });
    return {};
  } };`;
  const reg = await registry(t, [
    ["vault", { version: "0.1.0", does: { tools: ["vault.release"] } }, vault],
    ["agents", { version: "0.1.0", does: { tools: ["agents.check"] }, needs: { vault: ["per-agent"] } }, user],
  ]);
  assert.deepEqual(await reg.call("agents.check", { item: "scout-token" }, "cli"), { data: { got: "value-of-scout-token-for-module:agents" } });
  assert.deepEqual(await reg.call("agents.check", { item: "juno-key" }, "cli"), { data: { got: "value-of-juno-key-for-module:agents" } });
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

test("modules: ctx.remote says no_link without a link, and a listener's peer reaches run but not input", async t => {
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { input: { type: "object" }, run: async (input, meta) => ({ input, peer: meta.peer || null, caller: meta.caller, remote: await ctx.remote("x.y", {}) }) });
    ctx.route("feed", (req, res) => res.end("ok"));
    return { async stop() {} };
  } };`;
  const reg = await registry(t, [["notes", good, src]]);
  const r = await reg.call("notes.add", {}, "tailnet:owner@example.com", { peer: { stableId: "n1" } });
  assert.deepEqual(r.data.input, {});
  assert.deepEqual(r.data.peer, { stableId: "n1" });
  assert.equal(r.data.caller, "tailnet:owner@example.com");
  assert.equal(r.data.remote.error.code, "no_link");
  assert.ok(reg.routes.has("/v1/notes/feed"));
});

test("modules: a tool's error code passes through when it is a plain code; anything else is failed", async t => {
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { run: async ({ text }) => {
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

test("modules: a tool learns how presence was proved, and never sees the proof itself", async t => {
  const presence = { required: () => true, verify: async () => ({ ok: true, method: "capsule", keyId: "k1" }), challenge: async () => ({}) };
  const home = tempHome(t);
  writeModule(path.join(home, "mods"), "notes", good, `export default { async start(ctx) {
    ctx.tool("notes.add", { run: async (input, meta) => ({ meta }) });
    return {};
  } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: {}, log: () => {}, presence });
  await reg.start(discover([path.join(home, "mods")]), { role: "local" });
  const r = await reg.call("notes.add", {}, "cli", { proof: { method: "capsule", sig: "secret" }, thread: "t1" });
  assert.deepEqual(r.data.meta, { thread: "t1", presence: { method: "capsule", keyId: "k1" }, caller: "cli", firstParty: false });
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
    ctx.tool("talker.check", { run: async ({ item }) => ({ got: await ctx.vault.fetch(item) }) });
    ctx.tool("talker.mods", { run: async () => ctx.modules.status().find(m => m.name === "talker").credentials.map(c => c.id) });
    return {};
  } };`;
  const creds = [{ id: "deepgram", kind: "api-key", provider: "deepgram", purpose: "speech", item: "talker-deepgram-key" },
    { id: "openai", kind: "api-key", provider: "openai", purpose: "speech" }];
  const reg = await registry(t, [
    ["vault", { version: "0.1.0", does: { tools: ["vault.release"] } }, vault],
    ["talker", { version: "0.1.0", does: { tools: ["talker.check", "talker.mods"] }, needs: { credentials: creds } }, user],
  ]);
  assert.deepEqual(await reg.call("talker.check", { item: "talker-deepgram-key" }, "cli"), { data: { got: "value-of-talker-deepgram-key-for-module:talker" } });
  assert.deepEqual(await reg.call("talker.check", { item: "talker-openai" }, "cli"), { data: { got: "value-of-talker-openai-for-module:talker" } });
  assert.match((await reg.call("talker.check", { item: "talker-deepgram" }, "cli")).error.message, /does not declare/);
  assert.deepEqual((await reg.call("talker.mods", {}, "cli")).data, ["deepgram", "openai"]);
});

test("modules: a use is a tool that ran for a person, a surface or a model; refusals, modules and hooks are not", async t => {
  const src = `export default { async start(ctx) {
    ctx.tool("notes.add", { input: { type: "object", properties: { fail: { type: "boolean" } } },
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
    ctx.tool("notes.add", { run: async () => {
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
