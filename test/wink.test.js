// @ts-check
// Wink pairing as grants (core/wink): a typed code, two-sided, ends in one grant and a few events; an invitation becomes a membership;
// sharing a computer is a node.host grant; removal takes the grant and the device with it. A real vyred, the Node relay, a real typing
// device (relay/client/join.js). 127.0.0.1 only. Run on a runner or the test server (daemon tests never run on the person's Mac).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { start } from "../core/daemon/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { joinWithCode } from "../relay/client/join.js";
import { pairTicket, resolveTicket } from "../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../relay/client/nodecrypto.js";
import { fromBase64url } from "../relay/client/bytes.js";
import { ackCode } from "../relay/client/code.js";
import { tempHome } from "./helpers.js";
import { macCore } from "./fake-core-keys.js";
import { card, removal, FORBIDDEN } from "../core/wink/cards.js";

/** Takes any presence proof: refusals below are about who calls and what the module decides. */
const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
  covered: () => false,
  coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]),
  enroll(k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const PROOF = { proof: { method: "passkey", id: "x" } };
const SCREEN = "device:abcdefghijklmnop";
const A = { ...PROOF, peer: { stableId: "nodeA", node: "a" }, person: { id: "ps1" } };

async function world(t) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: true, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore() });
  t.after(() => d.stop());
  const events = [];
  d.events.on("*", e => events.push([e.type, e.payload]));
  const call = (tool, input = {}, caller = SCREEN, meta = A) => d.registry.call(tool, input, caller, meta);
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  return { d, url, root, events, call, status };
}
const until = async (f, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 25)); } };
const keystore = t => fileKeyStore(path.join(tempHome(t), "k.json"));

/** The new device types the code; resolves the states it showed and the pairing result. */
function typeCode(t, w, input, extra = {}) {
  const states = [];
  const done = joinWithCode({ relay: w.status.url, input, name: "Sam's laptop", onState: s => states.push(s), pollMs: 200, waitMs: 20_000, pairOptions: { crypto: nodeCrypto(), keyStore: keystore(t), timeout: 20_000 }, ...extra });
  return { states, done };
}

test("wink: a typed code is two-sided, ends in one device grant and events, and the code never rides the event bus", async t => {
  const w = await world(t);
  const open = await w.call("wink.code.open", { flow: "W2" });
  assert.ok(open.data?.code, JSON.stringify(open.error));
  assert.match(open.data.code, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  assert.match(ack.code, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/, "the new device shows a code to type back");
  const found = await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.ok(found, "the box knows a device is waiting");
  assert.equal((await w.call("wink.offers")).data.offers.length, 1);
  for (const [type, payload] of w.events) assert.ok(!JSON.stringify(payload ?? {}).includes(open.data.code), `${type} never carries the code`);
  // typing the right code back adds it
  const typed = await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code.toLowerCase().replace(/-/g, " ") });
  assert.equal(typed.data?.ok, true, JSON.stringify(typed.error));
  const r = await done;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.paired.device, "the device is paired");
  const access = (await w.call("wink.access")).data;
  assert.equal(access.grants.length, 0, "no grant in any space: a device belongs to the identity");
  assert.equal(access.devices.length, 1);
  assert.equal(access.devices[0].id, r.paired.device);
  assert.equal(access.devices[0].kind, "computer");
  assert.deepEqual(access.devices[0].owner, { kind: "identity", id: access.devices[0].identity });
  const kinds = w.events.map(e => e[0]);
  for (const k of ["wink.offered", "wink.found", "wink.confirmed", "wink.joined"]) assert.ok(kinds.includes(k), `${k} was emitted`);
  assert.ok(!kinds.includes("grant.created"), "no space grant is written for a device");
  assert.equal((await w.call("wink.offers")).data.offers.length, 0, "a used offer is no longer waiting");
});

test("wink: a wrong code typed back closes the code at once and a fresh one is showing; nothing is added", async t => {
  const w = await world(t);
  const open = await w.call("wink.code.open", { flow: "W2" });
  const { states, done } = typeCode(t, w, open.data.code, { waitMs: 1500 });
  await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  const wrong = await w.call("wink.code.ack", { offer: open.data.offer, typed: "WINK-0000-0000" });
  assert.equal(wrong.data?.ok, false);
  assert.ok(w.events.some(e => e[0] === "wink.code-closed"), "the code closed");
  await until(() => w.events.find(e => e[0] === "wink.code-replaced"));
  const status = (await w.call("wink.code.status")).data;
  assert.ok(status.code && status.code !== open.data.code, "a fresh code is showing, with no tap");
  assert.equal((await done).ok, false, "the typing device never pairs");
  assert.equal((await w.call("wink.access")).data.grants.length, 0, "nothing was added");
});

test("wink: the code is the owner's: an agent, a guest and a hook are refused", async t => {
  const w = await world(t);
  for (const caller of ["tailnet:agent:juno", "tailnet-guest:kit", "hook", "anonymous"]) {
    const r = await w.call("wink.code.open", { flow: "W2" }, caller);
    assert.ok(r.error, `${caller} is refused`);
  }
});

test("wink: an invitation is sealed into a ticket; the invited person's redemption writes a membership grant", async t => {
  const w = await world(t);
  const inv = await w.call("wink.invite", { role: "member", projects: ["intake"], days: 2 });
  assert.ok(inv.data?.ticket, JSON.stringify(inv.error));
  const ticket = fromBase64url(inv.data.ticket);
  // A lookup uses a ticket up on the relay, so the card is read from a twin invitation and the first one is redeemed.
  const twin = await w.call("wink.invite", { role: "member", projects: ["intake"], days: 2 });
  const looked = await resolveTicket(fromBase64url(twin.data.ticket), { relay: w.status.url, crypto: nodeCrypto() });
  assert.equal(looked.invite.kind, "invite", "the card's offer is read from the sealed record");
  assert.equal(looked.invite.role, "member");
  assert.deepEqual(looked.invite.projects, ["intake"]);
  const paired = await pairTicket(ticket, { relay: w.status.url, name: "Chris's laptop", crypto: nodeCrypto(), keyStore: keystore(t) });
  assert.equal(paired.device, undefined, "no device is enrolled by an invitation");
  const grants = (await w.call("wink.access")).data.grants;
  assert.equal(grants.length, 1);
  assert.equal(grants[0].source, "wink:W5");
  assert.equal(grants[0].subject.actor.kind, "person");
  assert.ok(w.events.some(e => e[0] === "wink.joined" && e[1].role === "member"));
  assert.equal((await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.length, 0, "no device row for the invitee");
  // the invitation is single use
  await assert.rejects(() => pairTicket(ticket, { relay: w.status.url, crypto: nodeCrypto(), keyStore: keystore(t) }), /expired or was already used/);
});

test("wink: a sensitive role waits for the admin's approval, and decline adds nothing", async t => {
  const w = await world(t);
  const inv = await w.call("wink.invite", { role: "admin" });
  const ticket = fromBase64url(inv.data.ticket);
  await pairTicket(ticket, { relay: w.status.url, name: "Chris's laptop", crypto: nodeCrypto(), keyStore: keystore(t) });
  assert.equal((await w.call("wink.access")).data.grants.length, 0, "no grant yet");
  const pending = (await w.call("wink.offers")).data.offers.find(o => o.state === "pending");
  assert.ok(pending, "the offer waits for the admin");
  assert.match(pending.receiver.fingerprint, /^[a-z2-7]{4} [a-z2-7]{4}$/, "with the invitee's fingerprint words");
  const ok = await w.call("wink.approve", { offer: pending.id });
  assert.ok(ok.data?.grant, JSON.stringify(ok.error));
  assert.equal((await w.call("wink.access")).data.grants.length, 1);
  const inv2 = await w.call("wink.invite", { role: "admin" });
  await pairTicket(fromBase64url(inv2.data.ticket), { relay: w.status.url, name: "Eve's laptop", crypto: nodeCrypto(), keyStore: keystore(t) });
  const p2 = (await w.call("wink.offers")).data.offers.find(o => o.state === "pending");
  assert.equal((await w.call("wink.decline", { offer: p2.id })).data.declined, true);
  assert.equal((await w.call("wink.access")).data.grants.length, 1, "still only the approved one");
  assert.equal((await w.call("wink.invite", { role: "owner" })).error?.code, "bad_input");
});

test("wink: sharing a computer is a node.host grant with limits, and only for a computer that is paired", async t => {
  const w = await world(t);
  assert.equal((await w.call("wink.share", { device: "nopenopenopenope" })).error?.code, "not_found");
  const open = await w.call("wink.code.open", { flow: "W2" });
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code });
  const r = await done;
  const shared = await w.call("wink.share", { device: r.paired.device, cpu: 0.25, hours_day: 4, awake: true, on_power: true });
  assert.ok(shared.data?.grant, JSON.stringify(shared.error));
  const g = (await w.call("wink.access")).data.grants.find(x => x.source === "wink:W4");
  assert.ok(g);
  assert.ok(g.resource.includes(`/node/${r.paired.device}/`));
  assert.ok(w.events.some(e => e[0] === "wink.shared"));
});

test("wink: removing a device takes it from the identity with its connections, and removing it at the relay takes it from the registry", async t => {
  const w = await world(t);
  const open = await w.call("wink.code.open", { flow: "W2" });
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code });
  const r = await done;
  const dev = (await w.call("wink.access")).data.devices[0];
  const out = await w.call("wink.remove", { device: dev.id });
  assert.ok(out.data?.removed, JSON.stringify(out.error));
  assert.match(out.data.prompt, /stop reaching your server at once/);
  assert.equal((await w.call("wink.access")).data.devices.length, 0);
  assert.equal(typeof out.data.closed, "boolean", "it says whether the connections were closed");
  assert.ok(w.events.some(e => e[0] === "wink.removed" && e[1].device === r.paired.device));
  assert.equal((await w.call("wink.remove", { device: dev.id })).error?.code, "not_found");
  // relay.devices.remove is the person's own tool: the surface that asked closes the connections with it.
  if (!out.data.closed) await w.d.registry.call("relay.devices.remove", { id: dev.id }, "cli", PROOF);
  const left = (await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.find(d => d.id === r.paired.device);
  assert.ok(!left, "the device is gone");
});

test("wink: a ring pairing (the existing path) registers a phone under the identity, and removing the device at the relay clears it", async t => {
  const w = await world(t);
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  const paired = await pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "Alex's iPhone", crypto: nodeCrypto(), keyStore: keystore(t) });
  await until(async () => (await w.call("wink.access")).data.devices.length === 1);
  const a = (await w.call("wink.access")).data;
  assert.equal(a.devices[0].kind, "phone");
  assert.equal(a.grants.length, 0);
  await w.d.registry.call("relay.devices.remove", { id: paired.device }, "cli", PROOF);
  await until(async () => (await w.call("wink.access")).data.devices.length === 0);
});

test("wink: Add a phone shows a QR and a code, a phone never takes a space target, and the phone's typed-back code adds it as a phone", async t => {
  const w = await world(t);
  assert.equal((await w.call("wink.phone.open", { space: "spc_aaaaaaaaaaaa" })).error?.code, "identity_only");
  const open = await w.call("wink.phone.open", {});
  assert.ok(open.data?.code, JSON.stringify(open.error));
  assert.match(open.data.qr, /^vyre:\/\/wink\/1\?c=WINK-[0-9A-Z]{4}-[0-9A-Z]{4}&r=/);
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code })).data.ok, true);
  assert.equal((await done).ok, true);
  const dev = (await w.call("wink.access")).data.devices[0];
  assert.equal(dev.kind, "phone");
  assert.deepEqual(dev.offers, { access: true });
  const scan = await w.call("wink.phone.scan", { payload: open.data.qr, target: { kind: "space", id: "spc_aaaaaaaaaaaa" } });
  assert.equal(scan.error?.code, "identity_only", "a phone is refused a space");
  assert.match(scan.error.message, /not to a space/);
});

test("wink: the server's own code and typed-back confirmation use the same two-sided path, and a pick-a-number tool does not exist", async t => {
  const w = await world(t);
  const open = await w.call("wink.server.code", {});
  assert.match(open.data.code, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.server.confirm", { offer: open.data.offer, typed: "WINK-0000-0000" })).data.ok, false);
  assert.equal((await done).ok, false);
  for (const gone of ["wink.code.pick", "wink.pick"]) assert.equal((await w.call(gone, {})).error?.code, "no_such_tool", `${gone} is gone`);
});

test("wink: the app's side carries the proof: pair.server without presence is refused, a space pairing by a non-admin is refused, an admin passes; the server's own side stays presence-free", async t => {
  const w = await world(t);
  const bare = { peer: A.peer, person: A.person };
  const own = (await w.call("wink.pair.targets", {})).data.targets[0];
  const code = "WINK-K7QM-4P2X";
  // no presence proof: refused before anything is checked or typed
  const none = await w.call("wink.pair.server", { code, target: { kind: "identity", id: own.id } }, SCREEN, bare);
  assert.equal(none.error?.code, "presence_required", JSON.stringify(none));
  const noneSpace = await w.call("wink.pair.server", { code, target: { kind: "space", id: w.status.space || "spc_aaaaaaaaaaaa" } }, SCREEN, bare);
  assert.equal(noneSpace.error?.code, "presence_required");
  // with presence: a space the person does not administer is refused, then an unreachable code is a plain bad input (the checks passed)
  assert.equal((await w.call("wink.pair.server", { code, target: { kind: "space", id: "spc_aaaaaaaaaaaa" } })).error?.code, "not_admin");
  const spaces = (await w.call("wink.pair.targets", {})).data.targets.filter(x => x.kind === "space");
  assert.ok(spaces.length >= 1, "the owner of this box administers its space");
  assert.equal((await w.call("wink.pair.server", { code: "hello", target: { kind: "space", id: spaces[0].id } })).error?.code, "bad_input");
  assert.equal((await w.call("wink.pair.server", { code: "hello", target: { kind: "identity", id: own.id } })).error?.code, "bad_input");
  // the headless server has no Touch ID: its two calls take no proof
  const open = await w.call("wink.server.code", {}, SCREEN, bare);
  assert.ok(open.data?.code, JSON.stringify(open.error));
  assert.equal((await w.call("wink.server.confirm", { offer: open.data.offer, typed: "WINK-0000-0000" }, SCREEN, bare)).error?.code, "not_found", "reaches the module with no proof");
});

test("wink: a new server code always replaces the old one: the abandoned code stops working and the offer closes", async t => {
  const w = await world(t);
  const first = (await w.call("wink.server.code", {})).data;
  const second = (await w.call("wink.server.code", {})).data;
  assert.ok(second.code && second.code !== first.code, "a different code, not the abandoned one");
  assert.notEqual(second.offer, first.offer);
  const offers = (await w.call("wink.offers")).data.offers;
  assert.ok(!offers.some(o => o.id === first.offer), "the old offer is no longer waiting");
  const old = typeCode(t, w, first.code);
  assert.equal((await old.done).ok, false, "typing the abandoned code fails");
  const { states, done } = typeCode(t, w, second.code);
  await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.server.confirm", { offer: second.offer, typed: "WINK-0000-0000" })).data.ok, false);
  await done;
});

test("wink cards: every card and prompt is in the words of wink-copy.md and never names a network, a key or a ticket", () => {
  const kinds = ["phone", "computer", "server", "invite", "lend", "share"];
  for (const kind of kinds) {
    const c = card({ kind: /** @type {any} */ (kind), receiver: { name: "Alex's iPhone", fingerprint: "7KQM 4P2X", os: "mac" }, approver: { name: "your phone", fingerprint: "9f8e 7d6c" }, space: kind === "invite" || kind === "lend" ? "Harlow Legal" : "Personal", inviter: { name: "Chris", fingerprint: "ab12 cd34" }, server: "harlow-home", quota: "4 GB, 2 sessions at a time" });
    for (const v of [c.title, c.goesInto, c.allows, c.forHowLong, c.primary, c.secondary, c.who, c.from || ""]) assert.doesNotMatch(v, FORBIDDEN, `${kind}: "${v}"`);
    assert.match(c.goesInto, /^Goes into: /, `${kind} says which space it goes into`);
    assert.doesNotMatch(c.primary, /^Allow$/, "a button names the action");
    assert.ok(c.who.includes("7KQM 4P2X"), "the fingerprint is beside the name");
  }
  assert.equal(card({ kind: "phone", receiver: { name: "Alex's iPhone", fingerprint: "7KQM 4P2X" } }).primary, "Add with Face ID");
  assert.equal(card({ kind: "invite", receiver: { name: "Sam" }, space: "Harlow Legal", inviter: { name: "Chris" } }).primary, "Join Harlow Legal");
  assert.equal(card({ kind: "lend", receiver: {}, space: "Harlow Legal", server: "harlow-home" }).primary, "Use harlow-home");
  assert.equal(card({ kind: "share", receiver: {} }).open, true, "the share card is marked for app-design's words");
  for (const what of ["device", "member", "leave", "lent", "share"]) {
    const p = removal({ what: /** @type {any} */ (what), name: "Alex's iPad", member: "Sam", space: "Harlow Legal", count: 3 });
    assert.doesNotMatch(p.prompt, FORBIDDEN);
    assert.equal(p.hold, true);
    assert.doesNotMatch(p.prompt, /unreadable/);
  }
});

test("wink: the code on screen is never derivable from the typed-back code, and the typed-back code is the same on both ends", () => {
  const key = crypto.randomBytes(32);
  assert.equal(ackCode(key), ackCode(key));
  assert.notEqual(ackCode(key), ackCode(crypto.randomBytes(32)));
});

/** Pairs one computer the typed-code way and returns its device id. */
async function pairComputer(t, w) {
  const open = await w.call("wink.code.open", { flow: "W2" });
  const { states, done } = typeCode(t, w, open.data.code);
  const ack = await until(() => states.find(s => s.state === "ack"));
  await until(() => w.events.find(e => e[0] === "wink.found"));
  assert.equal((await w.call("wink.code.ack", { offer: open.data.offer, typed: ack.code })).data?.ok, true);
  const r = await done;
  assert.equal(r.ok, true);
  return r.paired.device;
}

test("wink.relay.apply: the owner's app signs the instruction, the box checks it; no presence is asked on the box (lead ruling 3 Oct)", async t => {
  const w = await world(t);
  const device = await pairComputer(t, w);
  const box = (await w.d.registry.call("relay.route.id", {}, "module:wink", {})).data.route;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const sign = (i, key = privateKey) => crypto.sign(null, Buffer.from(`vyre-wink-instruction-v1\n${i.box}\n${i.action}\n${i.url || ""}\n${i.ts}\n${i.nonce}`), key).toString("base64url");
  const make = (o = {}) => { const i = { v: 1, action: "relay.enable", url: w.url, box, device, ts: Date.now(), nonce: crypto.randomBytes(12).toString("base64url"), ...o }; return { ...i, sig: o.sig || sign(i) }; };
  const apply = i => w.call("wink.relay.apply", i, "cli", {});
  // no key registered yet: refused, whoever signed
  assert.match((await apply(make())).error?.message || "", /refused/);
  // registering the key is the owner's own act and needs presence
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  assert.equal((await w.call("wink.device.key", { device, key: spki }, SCREEN, {})).error?.code, "presence_required");
  assert.equal((await w.call("wink.device.key", { device, key: spki })).data?.device, device);
  const good = make();
  const r = await apply(good);
  assert.equal(r.data?.applied, true, JSON.stringify(r.error));
  assert.match((await apply(good)).error?.message || "", /already used/);
  for (const [why, i, re] of [
    ["another box", make({ box: "someone-else" }), /another box/],
    ["a stale time", make({ ts: Date.now() - 5 * 60_000 }), /too old/],
    ["a bad url", make({ url: "http://x" }), /ws:\/\/|wss:\/\//],
    ["an unknown device", make({ device: "ghost" }), /not a device of the owner/],
    ["a tampered url", { ...make(), url: "wss://evil.test" }, /signature/],
    ["another key", make({ sig: sign({ box, action: "relay.enable", url: w.url, ts: 1, nonce: "x" }, crypto.generateKeyPairSync("ed25519").privateKey) }), /signature/],
  ]) assert.match((await apply(i)).error?.message || "", re, why);
  // an agent never applies one, even with a good signature
  assert.equal((await w.call("wink.relay.apply", make(), "tailnet:agent:juno", {})).error?.code, "denied");
});
