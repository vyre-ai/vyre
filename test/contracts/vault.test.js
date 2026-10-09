// @ts-check
// Contract test for team/contracts/vault.md (v1): the real shared-vault tools answer in the shapes the fixtures show, emit the events the contract names, admit the callers it lists and refuse a model.
// Vaults are real Vault objects in temp homes (the way core/vault/shared.test.js builds them); the tools are registered by the real module; the daemon cases for a device are in test/vault-device-writes.test.js.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../../core/store/index.js";
import { Vault, MIGRATIONS } from "../../core/vault/vault.js";
import { recorded } from "../../core/vault/testing.js";
import { momentOf } from "../../lib/one-yes.js";
import { SCRATCH } from "../scratch.mjs";
import { vaultFixtures as F, vaultCallers, modelCallers } from "./vault.fixtures.js";

/** The shape of a value: object keys with the shapes under them, an array as the shape of its first element, a scalar as its type. Optional keys the fixture shows are optional here. @param {any} v @returns {any} */
function shapeOf(v) {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)]));
  return v === null ? "null" : typeof v;
}
/** Every key of `want` is in `got` with the same shape, except keys the fixture marks optional by name. @param {any} got @param {any} want @param {string} at @param {Set<string>} optional */
function fits(got, want, at, optional) {
  if (Array.isArray(want)) { assert.ok(Array.isArray(got), `${at} is a list`); if (want.length && got.length) fits(got[0], want[0], `${at}[0]`, optional); return; }
  if (want && typeof want === "object") {
    assert.ok(got && typeof got === "object", `${at} is an object`);
    for (const k of Object.keys(want)) { if (!(k in got)) { assert.ok(optional.has(k), `${at}.${k} is missing`); continue; } fits(got[k], want[k], `${at}.${k}`, optional); }
    return;
  }
  if (want === "null" || got === null) return;
  assert.equal(got === null ? "null" : typeof got, want, `${at} is a ${want}`);
}
const OPTIONAL = new Set(["home", "conflicts", "rotate", "group", "removed", "taken", "ignored", "kv", "dismissed_until"]);
const matches = (/** @type {any} */ got, /** @type {any} */ fixture, at = "answer") => fits(got, shapeOf(fixture), at, OPTIONAL);

/** A vault named `name`, with a relay address so another vault can reach it. @param {import("node:test").TestContext} t @param {string} name */
function mk(t, name, homes) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-contract-vault-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  /** @type {{ type: string, payload: any }[]} */ const events = [];
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name, vault: { keystore: "file" } }, emit: (type, payload) => events.push({ type, payload }), log: () => {} });
  v.relayUrl = `http://127.0.0.1:1/${name}`;
  homes.set(v.relayUrl, v);
  v.shared.post = async (/** @type {string} */ url, /** @type {any} */ env) => (await homes.get(url).shared.onSync(env)).body;
  t.after(() => { homes.delete(v.relayUrl); db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { v, events };
}

test("create, list, invite, accept, role, rotate, remove, sync answer in the contract's shapes and emit its events", async t => {
  const homes = new Map();
  const a = mk(t, "alex", homes), d = mk(t, "dana", homes);
  const card = await d.v.card();
  await a.v.share.addPerson({ card: card.card, name: "dana" }, "cli");
  a.v.share.verifyPerson({ name: "dana", fingerprint: card.fingerprint }, "cli");
  const s = a.v.shared;

  const created = await s.create({ name: "team" }, "cli");
  matches(created, F.create);
  matches(s.list(), F.list);
  await s.put({ vault: "team", name: "api-token", kind: "api-key", fields: { value: "fixture-not-a-real-token" }, hosts: ["https://api.example.com"] }, "cli");
  const inv = await s.invite({ vault: "team", person: "dana" }, "cli");
  matches(inv, F.invite);
  const joined = await d.v.shared.accept({ invite: inv.invite }, "cli");
  matches(joined, F.accept);
  assert.equal(joined.vault.role, "member");
  matches(await s.role({ vault: "team", person: "dana", role: "admin" }, "cli"), F.role);
  matches(await s.rotate({ vault: "team" }, "cli"), F.rotate);
  matches(await s.sync({}, "cli"), F.sync);
  const removed = await s.remove({ vault: "team", person: "dana" }, "cli");
  matches(removed, F.remove);
  assert.deepEqual(removed.rotate, ["team/api-token"], "everything the member could read is flagged for rotation in the same step");

  const names = (/** @type {{ type: string }[]} */ ev) => ev.map(e => e.type);
  for (const type of ["vault.shared-created", "vault.member-added", "vault.member-role", "vault.key-rotated", "vault.member-removed"]) {
    const e = a.events.find(x => x.type === type);
    assert.ok(e, `${type} was emitted (saw ${names(a.events).join(", ")})`);
    matches(e.payload, F.events[/** @type {keyof typeof F.events} */ (type)], type);
  }
  const joinedEvent = d.events.find(x => x.type === "vault.shared-joined");
  assert.ok(joinedEvent, "the member's own vault says it joined");
  matches(joinedEvent.payload, F.events["vault.shared-joined"], "vault.shared-joined");
  const all = JSON.stringify([a.events, d.events, created, removed]);
  assert.ok(!all.includes("fixture-not-a-real-token"), "no value in any answer or event");
  assert.ok(!all.includes("vyre-invite"), "no invite in any event");
});

test("the health tools answer in the contract's shapes: counts and codes, never a name in the summary", async t => {
  const { tools } = await recorded(t);
  const summary = await tools.get("vault.health.summary").run({}, { caller: "deck" });
  matches(summary, F.healthSummary);
  assert.equal(JSON.stringify(summary).includes("login"), false, "counts only");
  const dismissed = await tools.get("vault.health.dismiss").run({ days: 7 }, { caller: "cli" });
  matches(dismissed, F.dismiss);
  assert.ok(dismissed.dismissed_until > Date.now());
  const after = await tools.get("vault.health.summary").run({}, { caller: "deck" });
  assert.equal(after.total, 0);
  assert.equal(after.dismissed_until, dismissed.dismissed_until);
});

test("each tool admits the callers the contract lists, takes the one yes where it says, and refuses a model", async t => {
  const { tools } = await recorded(t);
  const kind = (/** @type {string} */ c) => c.split(":")[0];
  for (const [name, want] of Object.entries(vaultCallers)) {
    const def = tools.get(name);
    assert.ok(def, `${name} is registered`);
    const admitted = new Set(def.callers);
    for (const k of want.admits) assert.ok(admitted.has(k), `${name} admits ${k}`);
    for (const k of modelCallers) assert.ok(!admitted.has(k), `${name} refuses ${k}`);
    if (name !== "vault.vaults.sync") assert.ok(!admitted.has("mcp"), `${name} refuses an outside or thread model (mcp)`);
    assert.equal(momentOf(name) === "vault", want.yes, `${name}: the vault moment (the one yes) is ${want.yes ? "asked" : "not asked"}`);
    void kind;
  }
});
