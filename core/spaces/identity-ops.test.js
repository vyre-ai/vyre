// @ts-check
// spaces: a person's identity chain on real devices (file stores in temp homes) against the real directory Worker on the fake runtime.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import worker, * as W from "../../names/worker/index.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import { fakeDns } from "../../names/worker/fake-dns.js";
import * as C from "../../kernel/identity/chain.js";
import { idDirectory, memorySeen } from "../../lib/identity/directory.js";
import { fileIdentityStore } from "./identity.js";
import { createIdentityOps } from "./identity-ops.js";
import { newCode, codeKey, normalizeCode, codeLooksRight } from "./recovery.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const FAST = { memoryKiB: 64, passes: 1 };

function world(t) {
  const dns = fakeDns();
  const clock = { t: T0 };
  const rt = createRuntime({ worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", RESOLVE_TXT: async () => [] } });
  t.after(async () => { await rt.settle(); assert.deepEqual(rt.errors.map(String), []); });
  let n = 0;
  const tamper = { resolve: /** @type {null|((d: any) => any)} */ (null) };
  const fetch = async (url, init) => {
    const res = await worker.fetch(new Request(url, { ...init, headers: { ...(init.headers || {}), "cf-connecting-ip": `198.51.${(n >> 8) & 255}.${n++ & 255}` } }), rt.env);
    if (tamper.resolve && String(url).includes("/v1/ids/resolve")) { const j = await res.json(); return new Response(JSON.stringify({ data: tamper.resolve(j.data) }), { status: 200, headers: { "content-type": "application/json" } }); }
    return res;
  };
  const mkDir = () => { const seen = memorySeen(); return { seen, dir: idDirectory({ base: "http://127.0.0.1:1", fetch, now: () => clock.t, seen }) }; };
  const { dir } = mkDir();
  /** A device: its own home, its own store, and the ops over them. */
  const device = label => {
    const home = tempHome(t);
    const store = fileIdentityStore(path.join(home, "spaces"));
    const events = [];
    const own = mkDir();
    const ops = createIdentityOps({ store, dir: own.dir, seen: own.seen, now: () => clock.t, emit: (type, p) => events.push([type, p]), stretch: FAST });
    return { label, home, store, ops, events, file: path.join(home, "spaces", "identity.json") };
  };
  /** Pairing hands a new device the chain: it makes its key, the signed-in device adds it, then the new one keeps the chain. */
  const pair = async (from, to, label) => {
    const key = to.store.newDeviceKey();
    await from.ops.addEntry({ kind: "device", publicKey: key.publicKey, label });
    to.store.join(key, from.store.ops(), from.store.status().name);
    return key;
  };
  return { clock, dir, device, pair, tamper };
}

test("recovery code: 128 bits in groups of four, forgiving to type, a password changes the key", () => {
  const code = newCode();
  assert.match(code, /^[a-z2-7]{4}(-[a-z2-7]{4}){5}-[a-z2-7]{2}$/);
  assert.ok(codeLooksRight(code) && codeLooksRight(code.toUpperCase().replace(/-/g, " ")));
  assert.notEqual(newCode(), code);
  const a = codeKey(code, "", FAST), b = codeKey(code.toUpperCase(), "", FAST), c = codeKey(code, "correct horse battery", FAST), d = codeKey(code, "correct horse batterz", FAST);
  assert.equal(a.eid, b.eid, "case and dashes do not matter");
  assert.notEqual(a.eid, c.eid, "the password is part of the key");
  assert.notEqual(c.eid, d.eid);
  assert.throws(() => codeKey("nope", "", FAST), e => e.code === "bad_code");
  assert.equal(normalizeCode("AB-cd ef"), "abcdef");
});

test("identity: create makes the chain with the code on it, claims the name, returns the code once and stores no secret of it", async t => {
  const w = world(t), phone = w.device("phone");
  const made = await phone.ops.create({ name: "alex", password: "four plain words here", deviceLabel: "alex's phone" });
  assert.match(made.recoveryCode, /^[a-z2-7-]{32}$/);
  assert.equal(made.passwordSet, true);
  assert.equal(phone.store.status().name, "alex");
  assert.match(phone.store.status().id, /^per_[a-z2-7]{26}$/);
  const list = await phone.ops.entries();
  assert.deepEqual(list.map(e => [e.kind, e.self, e.newcomer]), [["device", true, false], ["code", false, false]], "founders are never newcomers");
  const onDisk = fs.readFileSync(phone.file, "utf8");
  assert.ok(!onDisk.includes(normalizeCode(made.recoveryCode)) && !onDisk.includes("four plain words here"), "the code and password are never written on the device");
  assert.equal(fs.statSync(phone.file).mode & 0o777, 0o600);
  // anyone resolves the chain; the directory returned the same list and nothing private
  const r = await w.dir.resolve("alex");
  assert.equal(r.ok, true);
  assert.equal(r.id, phone.store.status().id);
  assert.ok(r.state.entries.every(e => e.pub), "public keys only");
  // a claim that fails leaves no key behind
  const other = w.device("other");
  await assert.rejects(other.ops.create({ name: "alex" }), e => e.code === "taken");
  assert.equal(other.store.status().exists, false);
});

test("identity: a second device signs in at once; for 24 hours it cannot remove older entries or change the code; an older device removes it and every device is told", async t => {
  const w = world(t), phone = w.device("phone"), laptop = w.device("laptop");
  await phone.ops.create({ name: "alex", deviceLabel: "phone" });
  w.clock.t += HOUR;
  await w.pair(phone, laptop, "laptop");
  assert.equal(laptop.store.status().name, "alex");
  const lap = (await laptop.ops.entries()).find(e => e.self);
  assert.equal(lap.newcomer, true);
  // works at once: the laptop adds a recovery contact? no (a contact is protected), but it adds a device
  const tablet = w.device("tablet");
  await w.pair(laptop, tablet, "tablet");
  // cannot remove older entries, replace the code or add a contact
  const phoneEid = phone.store.status().eid;
  await assert.rejects(laptop.ops.removeEntry(phoneEid), e => e.code === "newcomer" && /24 hours/.test(e.message));
  await assert.rejects(laptop.ops.replaceCode(), e => e.code === "newcomer");
  await assert.rejects(laptop.ops.addEntry({ kind: "contact", publicKey: laptop.ops.makeContactKey("alex").publicKey }), e => e.code === "newcomer");
  // the phone is told, and removes the newcomer tree in one tap each
  const told = await phone.ops.sync();
  assert.deepEqual(told.alerts.map(a => [a.type, a.entry && a.entry.kind]), [["add", "device"]], "the tablet the laptop added; the phone knows what it did itself");
  assert.ok(phone.events.some(([type]) => type === "identity.entry-added"));
  assert.equal((await phone.ops.sync()).alerts.length, 0, "told once");
  await phone.ops.removeEntry(lap.eid);
  await phone.ops.removeEntry(tablet.store.status().eid);
  const gone = await laptop.ops.sync();
  assert.equal(gone.removed, true);
  assert.ok(laptop.events.some(([type]) => type === "identity.device-removed"));
  assert.equal((await phone.ops.entries()).length, 2);
});

test("identity: the recovery code is replaceable; the old one stops; all devices lost, code and password in hand, a new device is back at once", async t => {
  const w = world(t), phone = w.device("phone");
  const made = await phone.ops.create({ name: "alex", password: "four plain words here", deviceLabel: "phone" });
  w.clock.t += 2 * HOUR;
  const fresh = w.device("new phone");
  await assert.rejects(fresh.ops.recoverWithCode({ name: "alex", code: made.recoveryCode, password: "", deviceLabel: "new" }), e => e.code === "wrong_code");
  await assert.rejects(fresh.ops.recoverWithCode({ name: "alex", code: made.recoveryCode, password: "wrong words wrong words" }), e => e.code === "wrong_code");
  await assert.rejects(fresh.ops.recoverWithCode({ name: "alex", code: "aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aa", password: "four plain words here" }), e => e.code === "wrong_code");
  await fresh.ops.recoverWithCode({ name: "alex", code: made.recoveryCode, password: "four plain words here", deviceLabel: "new phone" });
  assert.equal(fresh.store.status().id, phone.store.status().id, "the same permanent id");
  assert.equal(fresh.store.status().exists, true);
  // the new device is a newcomer, and the phone sees it
  assert.equal((await fresh.ops.entries()).find(e => e.self).newcomer, true);
  assert.equal((await phone.ops.sync()).alerts.length, 1);
  // replace the code from the phone; the old code then cannot sign in anywhere
  const next = await phone.ops.replaceCode({ password: "" });
  assert.notEqual(next.recoveryCode, made.recoveryCode);
  const third = w.device("third");
  await assert.rejects(third.ops.recoverWithCode({ name: "alex", code: made.recoveryCode, password: "four plain words here" }), e => e.code === "wrong_code");
  await third.ops.recoverWithCode({ name: "alex", code: next.recoveryCode, deviceLabel: "third" });
});

test("identity: everything lost, two of the recovery contacts approve", async t => {
  const w = world(t), phone = w.device("phone"), kit = w.device("kit"), juno = w.device("juno"), harlow = w.device("harlow");
  // the contacts have identities of their own and hold an approval key for alex
  await phone.ops.create({ name: "alex", deviceLabel: "phone" });
  for (const [d, n] of [[kit, "kit"], [juno, "juno"], [harlow, "harlow"]]) await d.ops.create({ name: n, deviceLabel: n });
  for (const d of [kit, juno, harlow]) {
    const k = d.ops.makeContactKey("alex");
    await phone.ops.addEntry({ kind: "contact", publicKey: k.publicKey, label: d.store.status().name });
  }
  w.clock.t += 30 * HOUR;
  const fresh = w.device("new phone");
  const begun = await fresh.ops.beginContactRecovery({ name: "alex", deviceLabel: "new phone" });
  assert.equal(begun.contacts, 3);
  const a1 = await kit.ops.approveRecovery(begun.request);
  const a2 = await harlow.ops.approveRecovery(begun.request);
  await assert.rejects(fresh.ops.finishContactRecovery({ request: begun.request, key: begun.key, approvals: [a1] }), e => e.code === "no_quorum");
  const stranger = w.device("stranger");
  await assert.rejects(stranger.ops.approveRecovery(begun.request), e => e.code === "not_a_contact");
  await fresh.ops.finishContactRecovery({ request: begun.request, key: begun.key, approvals: [a1, a2] });
  assert.equal(fresh.store.status().id, phone.store.status().id);
  // the recovered device is a newcomer: the old phone is still the older entry and sees the alert
  const told = await phone.ops.sync();
  assert.deepEqual(told.alerts.map(a => a.type), ["recover"]);
  // a request made against an old head is refused
  await assert.rejects(juno.ops.approveRecovery(begun.request), e => e.code === "stale_request");
});

test("identity: a stale or forked answer from the directory is noticed and not taken", async t => {
  const w = world(t), phone = w.device("phone");
  await phone.ops.create({ name: "alex", deviceLabel: "phone" });
  w.clock.t += HOUR;
  const tablet = w.device("tablet");
  await w.pair(phone, tablet, "tablet");
  assert.equal((await phone.ops.sync()).ok, true);
  // the operator replays the chain from before the tablet was added
  w.tamper.resolve = d => ({ ...d, ops: d.ops.slice(0, 1) });
  const stale = await phone.ops.sync();
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale");
  assert.ok(phone.events.some(([type, p]) => type === "identity.warning" && p.code === "stale"));
  // a different history at the same place
  w.tamper.resolve = null;
  const evil = w.device("evil");
  await evil.ops.create({ name: "mallory", deviceLabel: "evil" });
  w.tamper.resolve = d => ({ ...d, ops: evil.store.ops(), id: evil.store.status().id });
  const other = await phone.ops.sync();
  assert.equal(other.ok, false);
  assert.equal(other.code, "other_id");
  assert.equal(phone.store.ops().length, 2, "the device kept the list it trusted");
});

test("alerts: every existing device is told of a new sign-in; a newcomer cannot suppress or delay it, and the push carries no secret", async t => {
  const { NOTES } = await import("../push/index.js");
  const w = world(t), phone = w.device("phone"), laptop = w.device("laptop"), mac = w.device("mac");
  const made = await phone.ops.create({ name: "alex", deviceLabel: "phone" });
  w.clock.t += 2 * HOUR;
  await w.pair(phone, laptop, "alex's laptop");
  await w.pair(phone, mac, "alex's mac");
  // a thief with the code signs in on a new device, then (as that newcomer) adds more devices, tries to remove the others and to replace the code
  const thief = w.device("thief");
  await thief.ops.recoverWithCode({ name: "alex", code: made.recoveryCode, password: "", deviceLabel: "unknown" });
  const extra = thief.store.newDeviceKey();
  await thief.ops.addEntry({ kind: "device", publicKey: extra.publicKey, label: "more" });
  for (const d of [phone, laptop, mac]) await assert.rejects(thief.ops.removeEntry(d.store.status().eid), e => e.code === "newcomer");
  await assert.rejects(thief.ops.replaceCode(), e => e.code === "newcomer");
  // each older device learns of BOTH new entries on its own next check, whatever the thief's device does or does not do afterwards
  for (const d of [laptop, mac, phone]) {
    const told = await d.ops.sync();
    const labels = told.alerts.map(a => a.entry.label);
    assert.ok(labels.includes("more") && labels.includes("unknown"), `${d.label} was told of both new entries`);
    assert.equal((await d.ops.sync()).alerts.length, 0);
  }
  // the alert that would ring each device's phones: fixed words, a one-tap remove, rings through quiet hours, and nothing secret
  const ev = phone.events.filter(([type, p]) => type === "identity.entry-added" && p.entry).map(([, p]) => p);
  assert.equal(ev.length, 2);
  for (const p of ev) {
    const n = NOTES["identity.entry-added"]({ payload: p }, {});
    assert.equal(n.kind, "notice");
    assert.equal(n.loud, true);
    assert.deepEqual(n.actions, ["remove"]);
    assert.match(n.title, /new sign-in/);
    const blob = JSON.stringify(n);
    assert.ok(!blob.includes(made.recoveryCode) && !blob.includes("alex's") && !/privateKey/.test(blob), "no secret or device name in the push");
    assert.match(n.path, /^\/settings\?section=identity&remove=[a-z2-7]{26}$/);
  }
  // one tap from an older device removes the thief's devices
  await phone.ops.removeEntry(thief.store.status().eid);
  await phone.ops.removeEntry(extra.eid);
  assert.equal((await thief.ops.sync()).removed, true);
});

test("personOf: the identity list read live maps a device to its person, and a removed device maps to nobody at its next call", async t => {
  const { personOfChains } = await import("../../kernel/remote/person-of.js");
  const w = world(t), phone = w.device("phone"), laptop = w.device("laptop");
  await phone.ops.create({ name: "alex", deviceLabel: "phone" });
  w.clock.t += 2 * HOUR;
  await w.pair(phone, laptop, "alex's laptop");
  const id = phone.store.status().id, laptopEid = laptop.store.status().eid;
  // stateOf as the module's tool does it: the directory's current verified list, each call
  const stateOf = async () => { const r = await w.dir.resolve("alex"); return r.ok ? r.state : null; };
  const personOf = personOfChains({ people: () => [id], stateOf });
  assert.equal(await personOf(laptopEid), id);
  assert.equal(await personOf(phone.store.status().eid), id);
  assert.equal(await personOf("a".repeat(26)), null);
  await phone.ops.removeEntry(laptopEid);
  assert.equal(await personOf(laptopEid), null, "removed: nobody, at once");
});
