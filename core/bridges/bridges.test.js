// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import * as config from "../config/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { fakeKernelFor } from "../../test/fake-chain-kernel.js";

const CORE = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const SECRET = "SSN-123-45-6789-SENTINEL";
const NOTE = "NOTE-SENTINEL-private-remark";
const DAY = 86_400_000;
const ME = { presence: { method: "touchid" } };

/** The made-up world the fakes serve: harlow and northwind, alex in both, kit in northwind, sam a plain member of harlow. */
function world(over = {}) {
  return {
    members: {
      harlow: { alex: { space: "harlow", person: "alex", role: "owner" }, sam: { space: "harlow", person: "sam", role: "member" }, tem: { space: "harlow", person: "tem", role: "temp", scope: ["vyre://harlow/project/p1"], expires: Date.now() - 1000 } },
      northwind: { alex: { space: "northwind", person: "alex", role: "owner" }, kit: { space: "northwind", person: "kit", role: "admin" } },
    },
    policy: { harlow: { inference: "space_only", secrets: "space_only", allow_copy: true }, northwind: { inference: "any", secrets: "any", allow_copy: true } },
    spaces: { alex: [{ space: "harlow", name: "Harlow Legal", color: "#1d4ed8" }, { space: "northwind", name: "Northwind Bakery", color: "#d97706", link: "https://northwind.vyre.run" }] },
    schemas: { "client.updated": { fields: { name: { red: "public" }, ssn: { red: "privileged", sealed: true } } }, client: { fields: { name: { red: "public" }, email: { red: "pii" }, notes: { red: "internal", free_text: true }, ssn: { red: "privileged", sealed: true } } } },
    records: { harlow: { client: { c1: { id: "c1", version: 3, data: { name: "Dana Harlow", email: "dana@example.com", notes: NOTE, ssn: SECRET } }, c2: { id: "c2", version: 1, data: { name: "Eli Ward", email: "eli@example.com", notes: "n2", ssn: "x" } } } }, northwind: {} },
    tasks: [], defined: [], ...over,
  };
}

const FAKES = {
  spaces: `export default { async start(ctx) {
    const w = () => globalThis.__bw;
    ctx.tool("spaces.membership", { run: async ({ space, person }) => (w().members[space] || {})[person] || null });
    ctx.tool("spaces.merge-list", { run: async ({ person }) => w().spaces[person] ?? null });
    // A box-shaped home holds no identity of its own: "who is this device" is not answerable (the person comes from the call's chain).
    ctx.tool("spaces.self", { run: async () => { throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" }); } });
    ctx.tool("spaces.policy", { run: async ({ space }) => w().policy[space] || {} });
    return {};
  } };`,
  records: `export default { async start(ctx) {
    const w = () => globalThis.__bw;
    ctx.tool("records.read", { run: async ({ space, type, id }) => ({ record: ((w().records[space] || {})[type] || {})[id] || null }) });
    ctx.tool("records.query", { run: async ({ space, type }) => ({ rows: Object.values((w().records[space] || {})[type] || {}), next_cursor: null }) });
    ctx.tool("records.create", { run: async ({ space, type, id, data, meta }) => { const r = { id, version: 1, data, meta }; ((w().records[space] ||= {})[type] ||= {})[id] = r; return { record: r }; } });
    ctx.tool("records.schema", { run: async ({ type }) => ({ schema: w().schemas[type] || null }) });
    ctx.tool("records.state", { run: async () => ({ types: [] }) });
    ctx.tool("records.define", { run: async ({ space, diff }) => { w().defined.push({ space, diff }); return { ok: true }; } });
    return {};
  } };`,
  tasks: `export default { async start(ctx) {
    ctx.tool("tasks.create", { run: async (t) => { const task = { id: "t" + (globalThis.__bw.tasks.length + 1), ...t }; globalThis.__bw.tasks.push(task); return { task }; } });
    return {};
  } };`,
};
const MANIFEST = { spaces: ["spaces.membership", "spaces.merge-list", "spaces.policy", "spaces.self"], records: ["records.read", "records.query", "records.create", "records.schema", "records.state", "records.define"], tasks: ["tasks.create"] };

/** A real box registry with core/bridges and fake spaces (and, unless left out, records and tasks) modules. */
async function boxRegistry(t, { w = world(), fakes = ["spaces", "records", "tasks"] } = {}) {
  globalThis.__bw = w;
  t.after(() => { delete globalThis.__bw; });
  const home = tempHome(t);
  const p = config.ensure(home);
  const mods = path.join(home, "fakes");
  for (const f of fakes) writeModule(mods, f, { does: { tools: MANIFEST[f].map(name => ({ name, reach: "modules" })) } }, FAKES[f]);
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box", name: "testbox" }, paths: p, log: () => {}, kernelFor: spec => { const k = fakeKernelFor(spec); return { ...k, chain: async meta => { const c = await k.chain(meta); if (!(c.hops[0] && c.hops[0].actor.kind === "person")) return c; return w.self ? { ...c, hops: [{ actor: { kind: "person", id: w.self } }, ...c.hops.slice(1)] } : { hops: [{ actor: { kind: "service", id: "module" } }] }; } }; } });
  const core = discover([CORE]).filter(f => f.manifest && f.manifest.name === "bridges");
  await reg.start([...core, ...discover([mods])], { role: "box" });
  t.after(async () => { await reg.stop(); db.close(); });
  assert.equal(reg.modules.get("bridges").state, "running", reg.modules.get("bridges").error);
  // The fake spaces module answers "who is the verified caller" from w.self: these tests act as whoever the input names, unless a test pins w.self itself (a guest, a stranger).
  const call = (tool, input = {}, caller = "deck", meta = {}) => { if (!w.pinned) w.self = input.person ?? w.self; return reg.call(tool, input, caller, meta); };
  const ok = async (...a) => { const r = await call(...a); assert.ok(!r.error, JSON.stringify(r.error)); return r.data; };
  const all = () => events.since(0);
  return { reg, db, events, call, ok, w, all };
}

const viewOffer = (over = {}) => ({ person: "alex", source: "harlow", destination: "northwind", type: "client", fields: ["name", "notes", "ssn"], max_red: "internal", expires_at: Date.now() + DAY, ...over });
const refOffer = (over = {}) => ({ person: "alex", source: "harlow", destination: "northwind", types: ["client"], label_fields: ["name"], expires_at: Date.now() + DAY, ...over });
const stripUrn = c => ({ ...c, urn: undefined });

async function liveView(h, over) {
  const b = await h.ok("bridges.propose-view", viewOffer(over), "deck", ME);
  await h.ok("bridges.accept", { person: "kit", bridge: b.id });
  return b;
}

test("bridges: a shared view goes through proposal, acceptance, reads and revoke, all through the tools", async t => {
  const h = await boxRegistry(t);
  const noPresence = await h.call("bridges.propose-view", viewOffer());
  assert.equal(noPresence.error?.code, "needs_presence", "the source side needs the person in presence");
  const b = await h.ok("bridges.propose-view", viewOffer(), "deck", ME);
  assert.equal(b.status, "proposed");
  assert.equal(b.salt, undefined, "the shape never carries the salt");

  const early = await h.call("bridges.view.read", { person: "kit", share: b.id });
  assert.equal(early.error?.code, "not_accepted", "nothing flows before the destination accepts");

  assert.equal((await h.ok("bridges.accept", { person: "kit", bridge: b.id })).status, "accepted");
  const read = await h.ok("bridges.view.read", { person: "kit", share: b.id });
  assert.equal(read.read_only, true);
  assert.deepEqual(read.fields, ["name", "notes"], "the allow-list narrowed to the class ceiling, sealed left out");
  assert.deepEqual(read.rows[0].data, { name: "Dana Harlow", notes: NOTE });
  assert.equal(JSON.stringify(read).includes(SECRET), false, "the sealed value is never in the result");
  assert.equal(read.labels.trust, "external");
  assert.deepEqual(read.labels.source_spaces, ["harlow"]);
  assert.deepEqual(read.residency, { inference: "space_only", secrets: "space_only" }, "the source's residency travels with the data");

  const revoked = await h.ok("bridges.revoke", { person: "alex", bridge: b.id, space: "harlow", reason: "done" });
  assert.equal(revoked.status, "revoked");
  const after = await h.call("bridges.view.read", { person: "kit", share: b.id });
  assert.equal(after.error?.code, "revoked", "reads stop at once");
});

test("bridges: two-sided consent, only the destination's own member accepts", async t => {
  const h = await boxRegistry(t);
  const b = await h.ok("bridges.propose-view", viewOffer(), "deck", ME);
  assert.equal((await h.call("bridges.accept", { person: "sam", bridge: b.id })).error?.code, "not_found", "a member of the source only is nobody here");
  assert.equal((await h.call("bridges.accept", { person: "stranger", bridge: b.id })).error?.code, "not_found");
  assert.equal((await h.call("bridges.propose-view", viewOffer({ person: "sam" }), "deck", ME)).error?.code, "forbidden", "a plain member cannot offer a share");
  assert.equal((await h.call("bridges.propose-view", viewOffer({ person: "alex", destination: "harlow" }), "deck", ME)).error?.code, "bad_input");
  // an agent cannot propose (person reach): no chain from a model reaches the source side
  assert.equal((await h.call("bridges.propose-view", viewOffer(), "mcp:agent:juno", ME)).error?.code, "denied");
  await h.ok("bridges.accept", { person: "kit", bridge: b.id });
  assert.equal((await h.call("bridges.accept", { person: "kit", bridge: b.id })).error?.code, "bad_input", "already accepted");
});

test("bridges: an expired share stops reading", async t => {
  const h = await boxRegistry(t);
  const b = await liveView(h, { expires_at: Date.now() + 150 });
  await h.ok("bridges.view.read", { person: "kit", share: b.id });
  await new Promise(r => setTimeout(r, 220));
  assert.equal((await h.call("bridges.view.read", { person: "kit", share: b.id })).error?.code, "expired");
});

test("bridges: a reference resolves only through an accepted share, and every no looks the same", async t => {
  const h = await boxRegistry(t);
  const b = await h.ok("bridges.propose-reference", refOffer(), "deck", ME);
  const urn = "vyre://harlow/client/c1";
  const before = await h.ok("bridges.resolve", { person: "kit", space: "northwind", urn });
  assert.equal(before.resolved, false, "not resolvable before acceptance");
  await h.ok("bridges.accept", { person: "kit", bridge: b.id });
  const good = await h.ok("bridges.resolve", { person: "kit", space: "northwind", urn });
  assert.equal(good.resolved, true);
  assert.equal(good.label, "Dana Harlow");
  assert.equal(good.labels.trust, "external");
  assert.equal(JSON.stringify(good).includes(SECRET), false);
  // a record that does not exist, a type not shared, a stranger, and a revoked grant all answer the same chip
  const noRecord = stripUrn(await h.ok("bridges.resolve", { person: "kit", space: "northwind", urn: "vyre://harlow/client/nope" }));
  const wrongType = stripUrn(await h.ok("bridges.resolve", { person: "kit", space: "northwind", urn: "vyre://harlow/matter/c1" }));
  const stranger = stripUrn(await h.ok("bridges.resolve", { person: "stranger", space: "northwind", urn }));
  assert.deepEqual(noRecord, wrongType);
  assert.deepEqual(noRecord, stranger);
  await h.ok("bridges.revoke", { person: "kit", bridge: b.id });
  assert.deepEqual(stripUrn(await h.ok("bridges.resolve", { person: "kit", space: "northwind", urn })), noRecord, "revoked reads as nothing");
  assert.equal((await h.call("bridges.resolve", { person: "kit", space: "northwind", urn: "not a urn" })).error?.code, "bad_input");
});

test("bridges: a projection delivers only allowed fields with scoped ids, and stops on revoke", async t => {
  const h = await boxRegistry(t);
  const b = await h.ok("bridges.propose-projection", { person: "alex", source: "harlow", destination: "northwind", types: ["client.updated"], fields: ["name", "ssn"], max_red: "internal", expires_at: Date.now() + DAY }, "deck", ME);
  const ev = { id: "ev_origin_1", space: "harlow", type: "client.updated", subject: "vyre://harlow/client/c1", cause: "ev_origin_0", data: { name: "Dana Harlow", ssn: SECRET, extra: "no" } };
  assert.equal((await h.call("bridges.project", { projection: b.id, event: ev }, "module:test")).error?.code, "not_accepted");
  await h.ok("bridges.accept", { person: "kit", bridge: b.id });
  assert.equal((await h.call("bridges.project", { projection: b.id, event: ev }, "deck")).error?.code, "no_such_tool", "only modules reach the consumer");
  const row = await h.ok("bridges.project", { projection: b.id, event: ev }, "module:test");
  assert.deepEqual(row.data, { name: "Dana Harlow" });
  assert.equal(row.trust, "external");
  // The scoped ids are random hex, so a bare "c1" turns up in them by chance (about a third of runs): look for the origin's whole id instead.
  assert.ok(!/ev_origin|\/c1(?![0-9a-z])/.test(JSON.stringify(row)), "the origin's ids do not cross: " + JSON.stringify(row));
  assert.equal(await h.ok("bridges.project", { projection: b.id, event: { ...ev, type: "client.deleted" } }, "module:test"), null, "outside the selector: nothing");
  assert.ok(h.w.records.northwind.projected_event, "it landed in the destination's own records");
  await h.ok("bridges.revoke", { person: "alex", bridge: b.id, space: "harlow" });
  assert.equal((await h.call("bridges.project", { projection: b.id, event: ev }, "module:test")).error?.code, "revoked");
});

test("bridges: either side revokes, both logs hear it once, and the events carry no values", async t => {
  const h = await boxRegistry(t);
  const b = await liveView(h);
  await h.ok("bridges.view.read", { person: "kit", share: b.id });
  await h.ok("bridges.revoke", { person: "kit", bridge: b.id });
  await h.ok("bridges.revoke", { person: "kit", bridge: b.id }); // idempotent
  const mine = h.all().filter(e => e.source === "bridges");
  const revoked = mine.filter(e => e.type === "bridge.revoked");
  assert.deepEqual(revoked.map(e => e.payload.space).sort(), ["harlow", "northwind"], "one event per Space, once");
  for (const type of ["view.proposed", "view.accepted", "view.read", "view.revoked"]) {
    assert.deepEqual(mine.filter(e => e.type === type).map(e => e.payload.space).sort(), ["harlow", "northwind"], type);
  }
  const text = JSON.stringify(mine.map(e => e.payload));
  for (const s of [SECRET, NOTE, "Dana Harlow", "dana@example.com"]) assert.equal(text.includes(s), false, `${s} must not be in an event`);
  const read = mine.find(e => e.type === "view.read");
  assert.equal(read.payload.rows, 2);
  assert.deepEqual(read.payload.fields, ["name", "notes"]);
});

test("bridges: no existence oracle through the tools", async t => {
  const h = await boxRegistry(t);
  const b = await liveView(h);
  const unknown = await h.call("bridges.view.read", { person: "kit", share: "br_nope" });
  const outsider = await h.call("bridges.view.read", { person: "stranger", share: b.id });
  const strangerGet = await h.call("bridges.get", { person: "stranger", bridge: b.id });
  const unknownGet = await h.call("bridges.get", { person: "stranger", bridge: "br_nope" });
  assert.deepEqual(outsider.error, unknown.error, "a share you are not part of reads like one that does not exist");
  assert.deepEqual(strangerGet.error, unknownGet.error);
  assert.equal((await h.call("bridges.revoke", { person: "stranger", bridge: b.id })).error?.code, "not_found");
  assert.equal((await h.call("bridges.revoke", { person: "sam", bridge: b.id })).error?.code, "forbidden", "a plain member of the source may not stop it");
  assert.equal((await h.call("bridges.list", { person: "stranger", space: "northwind" })).error?.code, "not_found");
  assert.equal((await h.call("bridges.copy", { person: "sam", urn: "vyre://harlow/client/nope", toSpace: "northwind" })).error?.code, "not_found");
});

test("bridges: list shows both sides and get shows one share, never values", async t => {
  const h = await boxRegistry(t);
  const b = await liveView(h);
  h.w.spaces.kit = [{ space: "northwind", name: "Northwind Bakery", color: "#d97706" }];
  const fromSource = await h.ok("bridges.list", { person: "alex", space: "harlow" });
  const fromDest = await h.ok("bridges.list", { person: "kit", space: "northwind" });
  assert.deepEqual([fromSource[0].id, fromSource[0].side], [b.id, "source"]);
  assert.deepEqual([fromDest[0].id, fromDest[0].side], [b.id, "destination"]);
  assert.deepEqual((await h.ok("bridges.list", { person: "kit" })).map(x => x.id), [b.id], "with no space, every Space the person belongs to");
  const got = await h.ok("bridges.get", { person: "kit", bridge: b.id });
  assert.deepEqual(got.spec.fields, ["name", "notes", "ssn"]);
  assert.equal(JSON.stringify(got).includes(SECRET), false);
});

test("bridges: records not installed answers in plain words", async t => {
  const h = await boxRegistry(t, { fakes: ["spaces"] });
  const b = await liveView(h); // the offer and acceptance records are the bridge row itself
  const r = await h.call("bridges.view.read", { person: "kit", share: b.id });
  assert.equal(r.error?.message, "records are not installed in that space");
  const chip = await h.ok("bridges.resolve", { person: "kit", space: "northwind", urn: "vyre://harlow/client/c1" });
  assert.equal(chip.resolved, false);
});

test("bridges: copy to my space keeps provenance, empties sealed fields and carries residency", async t => {
  const h = await boxRegistry(t);
  const out = await h.ok("bridges.copy", { person: "alex", urn: "vyre://harlow/client/c1", toSpace: "northwind" });
  assert.equal(out.record.data.name, "Dana Harlow");
  assert.equal(out.record.data.ssn, null, "the sealed field comes across empty");
  assert.deepEqual(out.notes, [{ field: "ssn", note: "sealed value not copied" }]);
  assert.equal(out.provenance.from, "vyre://harlow/client/c1");
  assert.equal(out.provenance.source_version, 3);
  assert.deepEqual(out.residency, { inference: "space_only", secrets: "space_only" });
  assert.equal(out.labels.trust, "external");
  assert.equal(JSON.stringify(h.w.records.northwind).includes(SECRET), false);
  const ev = h.all().filter(e => e.type === "record.copied");
  assert.deepEqual(ev.map(e => e.payload.space).sort(), ["harlow", "northwind"]);
  assert.equal(JSON.stringify(ev.map(e => e.payload)).includes(SECRET), false);
  assert.equal((await h.call("bridges.copy", { person: "kit", urn: "vyre://harlow/client/c1", toSpace: "northwind" })).error?.code, "not_found", "no read, no copy, and it looks like absence");
  assert.equal((await h.call("bridges.copy", { person: "alex", urn: "vyre://harlow/client/c1", toSpace: "harlow" })).error?.code, "wrong_space");
});

test("bridges: a model chain is held for a copy and refused for sealed values", async t => {
  const h = await boxRegistry(t);
  const held = await h.call("bridges.copy", { person: "alex", urn: "vyre://harlow/client/c1", toSpace: "northwind" }, "mcp:agent:juno");
  assert.equal(held.error?.code, "held", JSON.stringify(held));
  assert.equal(h.w.records.northwind.client, undefined, "nothing was written");
  const sealed = await h.call("bridges.copy", { person: "alex", urn: "vyre://harlow/client/c1", toSpace: "northwind", copy_sealed: ["ssn"] }, "mcp:agent:juno", ME);
  assert.equal(sealed.error?.code, "sealed");
  // a bare model session ("mcp") is no more the person than a named agent: it is nobody, and is refused before anything is judged (BR-1)
  assert.equal((await h.call("bridges.copy", { person: "alex", urn: "vyre://harlow/client/c1", toSpace: "northwind", copy_sealed: ["ssn"] }, "mcp", ME)).error?.code, "forbidden");
  // the person alone, with presence: off by default, so still not copied
  const own = await h.call("bridges.copy", { person: "alex", urn: "vyre://harlow/client/c1", toSpace: "northwind", copy_sealed: ["ssn"] }, "deck");
  assert.equal(own.error?.code, "needs_presence");
  const own2 = await h.call("bridges.copy", { person: "alex", urn: "vyre://harlow/client/c1", toSpace: "northwind", copy_sealed: ["ssn"] }, "deck", ME);
  assert.ok(own2.error, "copy.sealed is off until the Space's owner grants it");
  assert.equal(JSON.stringify(h.w.records).includes(`"ssn":"${SECRET}"`) && JSON.stringify(h.w.records.northwind).includes(SECRET), false);
});

test("bridges: a Kit carries definitions, never data; install needs the approved plan", async t => {
  const h = await boxRegistry(t);
  const rows = await h.call("bridges.kit.export", { definitions: { name: "Intake", types: [{ name: "lead", rows: [{ name: "Dana" }] }] } });
  assert.equal(rows.error?.code, "bad_input");
  assert.ok(rows.error.detail.problems.length);
  const ref = await h.call("bridges.kit.export", { definitions: { name: "Intake", types: [{ name: "lead", note: "see vyre://harlow/client/c1" }] } });
  assert.equal(ref.error?.code, "bad_input");
  const kit = await h.ok("bridges.kit.export", { definitions: { name: "Intake", version: "1", types: [{ name: "lead", fields: [{ name: "name" }, { name: "source" }], stages: [{ name: "new" }] }], flows: [{ name: "follow-up" }], created_by: "alex" } });
  assert.equal(kit.format, "vyre-kit");
  assert.equal(kit.created_by, undefined);
  const plan = await h.ok("bridges.kit.plan", { person: "alex", space: "northwind", kit });
  assert.equal(plan.adds.types[0].name, "lead");
  assert.equal(plan.automatic, false);
  assert.equal((await h.call("bridges.kit.plan", { person: "sam", space: "northwind", kit })).error?.code, "not_found");
  assert.equal((await h.call("bridges.kit.install", { person: "alex", space: "northwind", kit, approved_plan_hash: "wrong" })).error?.code, "not_accepted");
  assert.equal((await h.call("bridges.kit.install", { person: "kit", space: "northwind", kit, approved_plan_hash: plan.plan_hash }, "deck")).error, undefined, "an admin may install");
  assert.equal(h.w.defined.length, 1);
  assert.equal(h.w.defined[0].space, "northwind");
  assert.ok(h.all().some(e => e.type === "kit.installed" && e.payload.space === "northwind" && e.payload.kit === "Intake"));
});

test("bridges: continue in another Space makes a task there that points back by reference", async t => {
  const h = await boxRegistry(t);
  const out = await h.ok("bridges.continue", { person: "alex", fromSpace: "harlow", toSpace: "northwind", summaryRefs: ["vyre://harlow/client/c1"], title: "Pick this up" });
  assert.equal(h.w.tasks.length, 1);
  assert.equal(h.w.tasks[0].space, "northwind");
  assert.deepEqual(h.w.tasks[0].inputs, ["vyre://harlow/client/c1"]);
  assert.equal(h.w.tasks[0].source, "continue_in_space");
  assert.equal(JSON.stringify(h.w.tasks[0]).includes(NOTE), false, "references, not copies");
  assert.deepEqual(out.refs, ["vyre://harlow/client/c1"]);
  assert.equal((await h.call("bridges.continue", { person: "alex", fromSpace: "harlow", toSpace: "northwind", summaryRefs: ["vyre://northwind/client/z"] })).error?.code, "bad_input");
  assert.equal((await h.call("bridges.continue", { person: "sam", fromSpace: "harlow", toSpace: "northwind", summaryRefs: ["vyre://harlow/client/c1"] })).error?.code, "forbidden", "not a member of the destination");
  assert.equal((await h.call("bridges.continue", { person: "alex", fromSpace: "harlow", toSpace: "northwind", summaryRefs: ["vyre://harlow/client/c1"] }, "mcp:agent:juno")).error?.code, "held", "a model's hand-off waits for a person");
  assert.ok(h.all().some(e => e.type === "task.continued" && e.payload.space === "harlow"));
});

test("bridges: without tasks, continue is saved as a pending continuation with a clear note", async t => {
  const h = await boxRegistry(t, { fakes: ["spaces", "records"] });
  const out = await h.ok("bridges.continue", { person: "alex", fromSpace: "harlow", toSpace: "northwind", summaryRefs: ["vyre://harlow/client/c1"] });
  assert.equal(out.task.pending, true);
  assert.match(out.task.note, /Tasks are not installed/);
  const row = h.db.prepare("SELECT * FROM bridges_continuations").get();
  assert.equal(row.to_space, "northwind");
  assert.equal(row.from_space, "harlow");
  assert.deepEqual(JSON.parse(row.refs), ["vyre://harlow/client/c1"]);
});

test("bridges: merge.links gives one link per live Space and never reads data", async t => {
  const h = await boxRegistry(t);
  const links = await h.ok("bridges.merge.links", { person: "alex" });
  assert.deepEqual(links, [
    { space: "harlow", name: "Harlow Legal", color: "#1d4ed8", link: "https://harlow.vyre.run" },
    { space: "northwind", name: "Northwind Bakery", color: "#d97706", link: "https://northwind.vyre.run" },
  ]);
  h.w.spaces.tem = [{ space: "harlow", name: "Harlow Legal", color: "#1d4ed8" }, { space: "northwind", name: "Northwind Bakery", color: "#d97706" }];
  assert.deepEqual(await h.ok("bridges.merge.links", { person: "tem" }), [], "an expired temp and a non-member get no links");
  assert.deepEqual((await h.ok("bridges.merge.links", { person: "kit", spaces: ["northwind", "harlow"] })).map(l => l.space), ["northwind"], "without spaces.list, the candidates are checked one by one");
  assert.equal(JSON.stringify(links).includes("Dana"), false);
  assert.equal((await h.call("bridges.merge.links", { person: "alex" }, "mcp:agent:juno")).error?.code, "denied", "a person's own surface only");
});

test("bridges: session.policy takes the strictest residency, and only for Spaces the person belongs to", async t => {
  const h = await boxRegistry(t);
  const p = await h.ok("bridges.session.policy", { person: "alex", spaces: ["harlow", "northwind"] }, "module:assistant");
  assert.equal(p.multi, true);
  assert.equal(p.persistent_writes, "drafts");
  assert.deepEqual(p.residency.inference, "space_only", "harlow is space_only, so the whole context is");
  assert.deepEqual(p.ask.must_name, ["harlow", "northwind"]);
  const one = await h.ok("bridges.session.policy", { person: "kit", spaces: ["northwind"] }, "module:assistant");
  assert.equal(one.multi, false);
  assert.equal((await h.call("bridges.session.policy", { person: "kit", spaces: ["northwind", "harlow"] }, "module:assistant")).error?.code, "not_found");
  assert.equal((await h.call("bridges.session.policy", { person: "alex", spaces: ["harlow"] }, "deck")).error?.code, "no_such_tool");
});

test("bridges: the manifest declares every event the module emits and the lib's actions", async t => {
  const h = await boxRegistry(t);
  const { ACTIONS } = await import("./index.js");
  const { BRIDGE_ACTIONS } = await import("../../lib/spaces/bridges.js");
  assert.equal(ACTIONS, BRIDGE_ACTIONS);
  const manifest = JSON.parse((await import("node:fs")).readFileSync(path.join(CORE, "bridges", "module.json"), "utf8"));
  assert.deepEqual([...manifest.does.actions].sort(), BRIDGE_ACTIONS.map(a => a.action).sort());
  // a whole lifecycle emits only declared types (ctx.events.emit throws on any other)
  const b = await liveView(h);
  await h.ok("bridges.view.read", { person: "kit", share: b.id });
  await h.ok("bridges.revoke", { person: "kit", bridge: b.id });
  const types = new Set(h.all().filter(e => e.source === "bridges").map(e => e.type));
  for (const x of types) assert.ok(manifest.watches.emits.includes(x), x);
});


test("bridges BR-1: the person is the verified caller's, never the input's: a guest, a plain model session, an anonymous caller or a mismatched name gets nothing", async t => {
  const h = await boxRegistry(t);
  const b = await h.ok("bridges.propose-view", viewOffer(), "deck", ME);
  await h.ok("bridges.accept", { person: "kit", bridge: b.id });
  const reads = ["bridges.view.read", "bridges.resolve", "bridges.copy", "bridges.continue"];
  const input = {
    "bridges.view.read": { person: "kit", share: b.id },
    "bridges.resolve": { person: "kit", space: "northwind", urn: "vyre://harlow/client/c1" },
    "bridges.copy": { person: "kit", urn: "vyre://harlow/client/c1", toSpace: "northwind" },
    "bridges.continue": { person: "kit", fromSpace: "northwind", toSpace: "harlow", summaryRefs: ["vyre://northwind/matter/m1"] },
  };
  h.w.pinned = true;
  h.w.self = "kit";
  // the person's own deck as kit: allowed (nothing is held back by the identity check)
  assert.ok(!(await h.call("bridges.view.read", input["bridges.view.read"], "deck")).error, "kit reading as kit through his own surface");
  // anonymous, a plain mcp session, a hook, a guest and a module: each naming kit gets a refusal, and no data
  for (const caller of ["mcp", "harness", "hook", "tailnet-guest:mallory@example.com", "module:other"]) {
    for (const tool of reads) {
      const r = await h.call(tool, input[tool], caller);
      assert.ok(r.error, `${tool} as ${caller} must be refused`);
      assert.ok(["forbidden", "denied", "no_such_tool"].includes(r.error.code), `${tool} as ${caller}: ${r.error.code}`);
      assert.ok(!JSON.stringify(r).includes("Dana Harlow"), "no data came back");
    }
  }
  // the person's own surface, but naming someone else: bad_input, never silently replaced
  h.w.self = "alex";
  for (const tool of reads) assert.equal((await h.call(tool, input[tool], "deck")).error?.code, "bad_input", tool);
  // and with nobody verified at all the surface itself is refused
  h.w.self = null;
  assert.equal((await h.call("bridges.view.read", input["bridges.view.read"], "deck")).error?.code, "forbidden");
});


test("bridges: no tool reads the person from its input (the source is grepped); the one exception is the modules-only session policy, whose caller is a first-party module", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const lines = src.split("\n");
  const bad = [];
  let inPolicy = false;
  lines.forEach((line, n) => {
    if (/ctx\.tool\("bridges\.session\.policy"/.test(line)) inPolicy = true;
    else if (/ctx\.tool\("/.test(line)) inPolicy = false;
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
    if (/\b(i|input)\.person\b/.test(line) && !inPolicy && !/The person a call is for is the VERIFIED|i && i\.person !== undefined/.test(line)) bad.push(`${n + 1}: ${line.trim().slice(0, 100)}`);
    if (/personOf\s*=\s*i\s*=>/.test(line)) bad.push(`${n + 1}: ${line.trim().slice(0, 100)}`);
  });
  assert.deepEqual(bad, [], "identity read from input");
});
