// @ts-check
// An agent's Chrome signs in only with a login shared with THAT agent, through the sharing levels (a grant of the Fill in level or above on the login), and never shows the agent the value.
// This file proves the grant check at the one place a fill starts (agentFill, then access.allowed, then the kernel): no share, a share to another agent, a share at a level that lacks vault.fill, an origin
// the login is not for, an expired share and a taken-back share all refuse BEFORE the agent's computer is touched (computers.fill.begin is never called); a share at Fill in, to the agent, lets it start.
// The browser is a stand-in that stops after the connection opens: the sign-in itself is covered against a real Chrome in agent-fill.test.js.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Access } from "./access.js";
import { kernelRig, SPACE } from "./kernel-rig.js";
import { SaidIntents } from "./said.js";
import { agentFill } from "./agent-fill.js";
import { ACCESS_LEVELS } from "../../kernel/seal/uses.js";
import { SCRATCH } from "../../test/scratch.mjs";

const ORIGIN = "https://app.northwind.example", OTHER = "https://evil.example";
const PASS = "fixture-password-0123456789abcdef";

async function world(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-fill-sharing-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const rig = await kernelRig({ agents: { kit: "agt_kit", juno: "agt_juno", assistant: "agt_asst" } });
  const events = /** @type {any[]} */ ([]);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "box", vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), log: () => {}, clock: rig.clock });
  v.access = new Access(v, rig.ctx);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await v.put({ name: "northwind-app", kind: "login", fields: { username: "alex@northwind.example", password: PASS }, url: `${ORIGIN}/login`, hosts: [ORIGIN] }, "cli");
  await v.put({ name: "graph-api", kind: "api-credential", fields: { config: JSON.stringify({ hosts: ["graph.example.test"], auth: { type: "bearer" } }), secret: "fixture-secret-0123456789" } }, "cli");
  await v.access.convertScopes();
  const calls = /** @type {any[]} */ ([]);
  /** A stand-in for the browser: the connection opens and then stops, so a started fill shows as the stop and a refused one as a refusal. */
  const makeCdp = () => ({ connect: async () => { throw Object.assign(new Error("stand-in browser: stop here"), { code: "stand_in" }); }, close: async () => {} });
  const d = { vault: v, said: new SaidIntents(v), log: () => {}, makeCdp, call: async (/** @type {string} */ name, /** @type {any} */ input) => {
    calls.push({ name, input });
    if (name === "computers.fill.begin") return { data: { fill: "fill-1", cdpUrl: "http://127.0.0.1:9", token: "" } };
    return { data: { agent: input.agent, ended: true } };
  } };
  const urn = await v.access.urn("northwind-app");
  /** A share of the login with an agent, as the sharing tools make it: the actions of a level, on the login's own address. */
  const share = (/** @type {string} */ agent, /** @type {readonly string[]} */ actions = ACCESS_LEVELS.use, over = {}) =>
    rig.gw.grants.create(rig.owner(), { subject: { kind: "actor", actor: { kind: "agent", id: rig.uid(agent), space: SPACE } }, actions: [...actions], resource: { prefix: urn }, conditions: {}, source: "vault:share", ...over }, { presence: { n: Math.random() } });
  const fill = (/** @type {string} */ agent, /** @type {any} */ extra = {}) => agentFill(d, { agent, item: "northwind-app", origin: ORIGIN, ...extra });
  const began = () => calls.filter(c => c.name === "computers.fill.begin").length;
  return { v, rig, db, events, calls, share, fill, began };
}

const refused = (/** @type {Promise<any>} */ p, /** @type {RegExp} */ re = /is not lent to/) => assert.rejects(p, e => /** @type {any} */ (e).code === "denied" && re.test(/** @type {Error} */ (e).message));

test("no share, no fill: a login nobody shared with the agent is refused before its computer is touched, and the refusal is on the record", async t => {
  const w = await world(t);
  await refused(w.fill("juno"));
  assert.equal(w.began(), 0, "the agent's computer was never shielded");
  const row = /** @type {any} */ (w.db.prepare("SELECT ok, who, origin FROM vault_audit WHERE action = 'agent-fill' ORDER BY rowid DESC LIMIT 1").get());
  assert.deepEqual({ ok: row.ok, who: row.who, origin: row.origin }, { ok: 0, who: "agent:juno", origin: ORIGIN });
});

test("a share is to one agent: kit's share does not let juno fill, and juno's share does not let kit", async t => {
  const w = await world(t);
  await w.share("kit");
  await refused(w.fill("juno"));
  assert.equal(w.began(), 0);
  const why = JSON.stringify({ effect: await w.v.access.effectFor("kit", "northwind-app", "vault.fill", ORIGIN), allowed: await w.v.access.allowed("kit", "northwind-app", ORIGIN).catch(e => String(e.message)), uid: await w.v.access.uidOf("kit"), urn: await w.v.access.urn("northwind-app"), mayNoOrigin: await w.rig.ctx.kernel.agentMay(w.rig.uid("kit"), "vault.fill", await w.v.access.urn("northwind-app")), mayOrigin: await w.rig.ctx.kernel.agentMay(w.rig.uid("kit"), "vault.fill", await w.v.access.urn("northwind-app"), ORIGIN) });
  await assert.rejects(w.fill("kit"), e => /** @type {any} */ (e).code === "stand_in", `kit, with a share, gets as far as its browser (what the vault saw: ${why})`);
  assert.equal(w.began(), 1);
  await refused(w.fill("assistant"), /is not lent to/);
  assert.equal(w.began(), 1, "the default assistant holds nothing it was not given");
});

test("only a level that includes Fill in lets an agent fill: Read-only or API use does not, Fill in and above do", async t => {
  const w = await world(t);
  const lacking = await w.share("juno", ["vault.read", "vault.call"]);
  await refused(w.fill("juno"));
  await w.rig.gw.grants.revoke(w.rig.owner(), lacking.id, "wrong level", { presence: { n: 1 } });
  // An assistant is given use and nothing above it (the kernel refuses a grant of reveal, edit or manage to an agent), so Fill in is the one level an agent can hold
  for (const level of /** @type {const} */ (["reveal", "edit", "manage"]))
    await assert.rejects(w.share("juno", ACCESS_LEVELS[level]), e => /** @type {any} */ (e).code === "bad_input", `${level} is never an agent's`);
  const g = await w.share("juno", ACCESS_LEVELS.use);
  await assert.rejects(w.fill("juno"), e => /** @type {any} */ (e).code === "stand_in", "use lets it start");
  await w.rig.gw.grants.revoke(w.rig.owner(), g.id, "next level", { presence: { n: 1 } });
  await refused(w.fill("juno"));
});

test("a fill goes only where the login is for: another origin, a lookalike and no origin the login names are refused even with a share", async t => {
  const w = await world(t);
  await w.share("juno");
  for (const origin of [OTHER, `${ORIGIN}.evil.example`, "http://app.northwind.example", `${ORIGIN}:8443`, "not an origin"])
    await assert.rejects(w.fill("juno", { origin }), e => ["denied", "bad_input"].includes(/** @type {any} */ (e).code), origin);
  assert.equal(w.began(), 0, "none of them reached the computer");
  await assert.rejects(w.fill("juno", { origin: undefined }), e => /** @type {any} */ (e).code === "stand_in", "no origin means the login's own");
});

test("an expired share and a taken-back share stop filling at once", async t => {
  const w = await world(t);
  const g = await w.share("juno", ACCESS_LEVELS.use, { conditions: { when: { expires: w.rig.clock() + 5_000 } } });
  await assert.rejects(w.fill("juno"), e => /** @type {any} */ (e).code === "stand_in");
  const real = w.v.clock; w.v.clock = () => real() + 3_600_000;
  for (let i = 0; i < 6000; i++) w.rig.clock();
  await refused(w.fill("juno"));
  w.v.clock = real;
  const h = await w.share("juno");
  await assert.rejects(w.fill("juno"), e => /** @type {any} */ (e).code === "stand_in");
  await w.rig.gw.grants.revoke(w.rig.owner(), h.id, "taken back", { presence: { n: 1 } });
  await refused(w.fill("juno"));
  void g;
});

test("only a login can be filled; the value never reaches the agent: not in the refusal, not in the audit, not in the events", async t => {
  const w = await world(t);
  await w.share("juno");
  await assert.rejects(agentFill({ vault: w.v, said: new SaidIntents(w.v), log: () => {}, call: async () => ({ data: {} }) }, { agent: "juno", item: "graph-api" }), e => /** @type {any} */ (e).code === "not_found");
  let seen = "";
  try { await w.fill("juno"); } catch (e) { seen = String(/** @type {Error} */ (e).message); }
  const all = JSON.stringify({ seen, events: w.events, audit: w.db.prepare("SELECT * FROM vault_audit").all(), calls: w.calls.filter(c => c.name !== "computers.fill.begin") });
  const where = Object.entries({ seen, events: JSON.stringify(w.events), audit: JSON.stringify(w.db.prepare("SELECT * FROM vault_audit").all()), calls: JSON.stringify(w.calls.filter(c => c.name !== "computers.fill.begin")) }).filter(([, x]) => x.includes(PASS)).map(([k]) => k);
  assert.ok(!all.includes(PASS), `the password is nowhere an agent or a log can read it (found in: ${where.join(", ")})`);
  assert.ok(!all.includes("alex@northwind.example"), "nor the username");
  // The one place a value goes is the begin of the fill itself: the agent's own computer is handed the values to scrub from everything the agent's DevTools return (agent-fill.js, the fill window), and the call carries nothing else of the login.
  const begin = w.calls.filter(c => c.name === "computers.fill.begin");
  assert.equal(begin.length, 1); assert.deepEqual(Object.keys(begin[0].input).sort(), ["agent", "origin", "values"]);
});
