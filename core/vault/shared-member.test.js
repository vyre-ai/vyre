// @ts-check
// A member uses what the Space owner shared with her (vault.me.shared.list and vault.me.shared.request): the kernel decides on HER chain, on the item's address; Fill in covers her own reads and sends
// (a person's own act is never held; an agent acting for her is held at the Gate); an item not shared is indistinguishable from one that does not exist; the key is added at the vault's home and never reaches her. A real grants store behind
// core/vault/kernel-rig.js and the real relay over a fake network.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Access } from "./access.js";
import { register } from "./request.js";
import { kernelRig, SPACE } from "./kernel-rig.js";
import { levelActions } from "../../kernel/seal/uses.js";
import { SCRATCH } from "../../test/scratch.mjs";

const BOB = "per_bob", EVE = "per_eve";
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const json = (status, body) => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
const GRAPH = { auth: { type: "bearer" }, hosts: ["graph.example.test"] };

async function mk(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-sharedmember-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const rig = await kernelRig({ people: [BOB, EVE] });
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "box", vault: { keystore: "file" } }, emit: () => {}, log: () => {}, clock: rig.clock });
  v.access = new Access(v, rig.ctx);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const net = { calls: /** @type {any[]} */ ([]) };
  const gate = { items: new Map() };
  const call = async (tool, input) => {
    if (tool === "gate.offer") return { data: { name: input.name } };
    if (tool === "gate.request") { const id = `h${gate.items.size + 1}`; gate.items.set(id, { id, input }); return { data: { id, state: "held", message: `Held as ${id}` } }; }
    return { error: { code: "no_such_tool", message: tool } };
  };
  const tools = new Map();
  register({ vault: v, tool: (name, _c, _d, _i, run) => tools.set(name, { run }), internal: (n, _d, _i, run) => tools.set(n, { run }), call, said: { match: async () => null },
    deps: { lookup: async () => [{ address: "93.184.216.10", family: 4 }], transport: async r => { net.calls.push({ host: r.url.hostname, method: r.method }); return json(200, { ok: true }); } } });
  const secrets = {};
  const cred = async name => { secrets[name] = fake(name); await v.put({ name, kind: "api-credential", fields: { config: JSON.stringify(GRAPH), secret: secrets[name] } }, "cli"); };
  const asPerson = (who, extra = {}) => ({ caller: "device:abcdefghijklmnop", chain: rig.person(who), ...extra });
  const list = who => tools.get("vault.me.shared.list").run({}, asPerson(who));
  const ask = (input, who, extra) => tools.get("vault.me.shared.request").run(input, asPerson(who, extra));
  const share = async (name, subject, level = "use", over = {}) => {
    const i = { subject, actions: [...levelActions(level)], resource: { prefix: await v.access.urn(name) }, conditions: {}, source: "vault:share", ...over };
    return rig.gw.grants.create(rig.owner(), i, { presence: { n: Math.random() } });
  };
  const person = who => ({ kind: "actor", actor: { kind: "person", id: who, space: SPACE } });
  const GET = { method: "GET", url: "https://graph.example.test/v1/a" }, POST = { method: "POST", url: "https://graph.example.test/v1/send", body: { a: 1 } };
  const vaults = who => tools.get("vault.me.vaults").run({}, asPerson(who));
  return { v, rig, net, gate, secrets, cred, list, ask, share, person, GET, POST, tools, vaults };
}

test("a credential not shared with her is not there; shared at Fill in she reads it and her own outward act goes out unheld; the key never reaches her", async t => {
  const { cred, list, ask, share, person, net, gate, secrets, GET, POST } = await mk(t);
  await cred("graph-api");
  assert.deepEqual((await list(BOB)).items, [], "nothing shared, nothing listed");
  const missing = await ask({ credential: "graph-api", ...GET }, BOB).catch(e => e);
  const absent = await ask({ credential: "no-such-api", ...GET }, BOB).catch(e => e);
  assert.equal(missing.code, "not_found"); assert.equal(absent.code, "not_found");
  assert.equal(missing.message.replace("graph-api", "X"), absent.message.replace("no-such-api", "X"), "not shared reads exactly like not existing");
  assert.equal(net.calls.length, 0);
  await share("graph-api", person(BOB), "use");
  assert.deepEqual((await list(BOB)).items.map((/** @type {any} */ i) => i.name), ["graph-api"]);
  assert.deepEqual((await list(EVE)).items, [], "another member sees nothing");
  const r = await ask({ credential: "graph-api", ...GET }, BOB);
  assert.equal(r.kind, "read"); assert.equal(net.calls.length, 1);
  assert.ok(!JSON.stringify(r).includes(secrets["graph-api"]) && !JSON.stringify(await list(BOB)).includes(secrets["graph-api"]), "no value reaches her");
  const sent = await ask({ credential: "graph-api", ...POST }, BOB);
  assert.ok(!sent.held && sent.kind !== "read", "her own outward act is hers: it goes out, it is not held");
  assert.equal(net.calls.length, 2); assert.equal(net.calls[1].method, "POST"); assert.equal(gate.items.size, 0, "nothing waits at the Gate for a person's own act");
  await assert.rejects(ask({ credential: "graph-api", ...GET }, EVE), { code: "not_found" });
});

test("a share that allows reads only refuses an outward act (not even held); a revoked share and a removed member stop the next call; the owner uses the owner's tools", async t => {
  const { cred, ask, share, person, rig, net, GET, POST } = await mk(t);
  await cred("graph-api");
  const g = await share("graph-api", person(BOB), "use", { actions: ["vault.read"] });
  assert.equal((await ask({ credential: "graph-api", ...GET }, BOB)).kind, "read");
  await assert.rejects(ask({ credential: "graph-api", ...POST }, BOB), { code: "denied" }, "reads only: no outward act, not even held");
  await rig.gw.grants.revoke(rig.owner(), g.id, "test", { presence: { n: 1 } });
  await assert.rejects(ask({ credential: "graph-api", ...GET }, BOB), { code: "not_found" });
  assert.equal(net.calls.length, 1);
  await assert.rejects(ask({ credential: "graph-api", ...GET }, "per_owner"), /member's own vault|denied/, "the owner is refused here");
});

test("a team share reaches the people in the team and stops when they leave it", async t => {
  const { cred, ask, share, rig, GET } = await mk(t);
  await cred("graph-api");
  const team = await rig.gw.grants.teams.set(rig.owner(), { name: "Billing", members: [BOB] });
  await share("graph-api", { kind: "group", id: team.id }, "use");
  assert.equal((await ask({ credential: "graph-api", ...GET }, BOB)).kind, "read");
  await assert.rejects(ask({ credential: "graph-api", ...GET }, EVE), { code: "not_found" });
  await rig.gw.grants.teams.set(rig.owner(), { id: team.id, members: [] });
  await assert.rejects(ask({ credential: "graph-api", ...GET }, BOB), { code: "not_found" });
});

test("a member sees the vaults shared with her: a whole vault shared once lists every credential in it, nothing of another vault, and stops when it is taken back", async t => {
  const { v, rig, cred, vaults, ask, share, person, GET, net } = await mk(t);
  await cred("graph-api"); await cred("other-api");
  const acme = await rig.gw.grants.vaults.set(rig.owner(), { name: "Acme" });
  const other = await rig.gw.grants.vaults.set(rig.owner(), { name: "Other" });
  const put = (/** @type {string} */ item, /** @type {string} */ vid) => { v.db.prepare("UPDATE vault_items SET named = ? WHERE name = ?").run(vid, item); v.sign("vault_items", /** @type {any} */ (v.db.prepare("SELECT id FROM vault_items WHERE name = ?").get(item)).id); };
  put("graph-api", acme.id); put("other-api", other.id);
  assert.deepEqual((await vaults(BOB)).vaults, [], "nothing shared yet");
  const g = await rig.gw.grants.create(rig.owner(), { subject: person(BOB), actions: [...levelActions("use")], resource: { prefix: `vyre://${SPACE}/vault/${acme.id}` }, conditions: {}, source: "vault:vshare" }, { presence: { n: Math.random() } });
  const mine = (await vaults(BOB)).vaults;
  assert.deepEqual(mine.map((/** @type {any} */ x) => [x.name, x.items.map((/** @type {any} */ i) => i.name)]), [["Acme", ["graph-api"]]], "only the vault shared with her, and what is in it");
  assert.equal((await ask({ credential: "graph-api", ...GET }, BOB)).kind, "read", "and she can use it, through the vault's one grant");
  await assert.rejects(ask({ credential: "other-api", ...GET }, BOB), { code: "not_found" }, "another vault stays closed");
  assert.deepEqual((await vaults(EVE)).vaults, [], "another member sees nothing");
  assert.equal(net.calls.length, 1);
  await rig.gw.grants.revoke(rig.owner(), g.id, "test", { presence: { n: 1 } });
  assert.deepEqual((await vaults(BOB)).vaults, []);
});
