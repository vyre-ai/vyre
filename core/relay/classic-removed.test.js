// @ts-check
// The classic bearer pairing code is gone (owner's ruling, 13 Oct 2026, "install settled" item 1): a code any holder could redeem made a device nobody confirmed. A device joins by the Wink ticket
// (signed in by name and approved on another device, or a space code plus the same words), never by a code that proves nothing about who holds it. Pinned here through the real daemon and relay:
// making one is refused in words, redeeming one is refused, the ticket path still pairs, a device paired the old way before this version keeps working only if it is the owner's, and an old unmarked
// one is refused with the next step.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { HUMAN_ONLY } from "../presence/index.js";
import { createRelay } from "../../relay/node/server.js";
import { keyPair } from "../relay/noise.js";
import { deviceSide } from "../relay/channel.js";
import { pairUrl } from "../relay/pairing.js";
import { resolveTicket } from "../../relay/client/client.js";
import { nodeCrypto } from "../../relay/client/nodecrypto.js";
import { fromBase64url } from "../../relay/client/bytes.js";
import { tempHome } from "../../test/helpers.js";
import { macCore } from "../../test/fake-core-keys.js";

const lenient = {
  required: (/** @type {string} */ tool, /** @type {any} */ def, /** @type {any} */ input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async (/** @type {any} */ { proof }) => (proof ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person", methods: [] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
  covered: () => false,
  coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]),
  enroll(/** @type {any} */ k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const PROOF = { proof: { method: "passkey", id: "x" } };

async function world(/** @type {any} */ t) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
  const logs = /** @type {string[]} */ ([]);
  const d = await start({ presence: lenient, root, log: (/** @type {string} */ l) => logs.push(String(l)), coreKeys: macCore() });
  t.after(() => d.stop());
  return { d, url, root, logs };
}

/** A device's one Noise dial to the box: with `secret` it pairs, without it it reconnects as a paired device. Resolves with the box's reply or the refusal's words. */
async function dial(/** @type {any} */ offer, /** @type {any} */ keys, /** @type {string | null} */ secret) {
  const ws = new WebSocket(`${offer.relay}/v1/device?route=${offer.route}`);
  ws.binaryType = "arraybuffer";
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const side = deviceSide({ send: (/** @type {any} */ b) => ws.send(b), close: (/** @type {number} */ c, /** @type {string} */ r) => ws.close(c === 1000 || (c >= 3000 && c < 5000) ? c : 4000, r) },
    { s: keys, box: offer.box, route: offer.route, hello: { v: 1, name: "a phone", ...(secret ? { pair: secret } : {}) } });
  ws.onmessage = e => { if (typeof e.data !== "string") side.receive(Buffer.from(e.data)); };
  ws.onclose = e => side.gone(e.reason || "closed");
  try { const { reply } = await side.ready; ws.close(); return { reply }; }
  catch (e) { try { ws.close(); } catch { /* closed */ } return { refused: String(/** @type {Error} */ (e).message) }; }
}

/** A ticket the box minted (the Wink path), resolved the way a phone does, so a test can dial with it. */
async function ticketOffer(/** @type {any} */ d, /** @type {string} */ url) {
  const minted = await d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  assert.ok(minted.data, JSON.stringify(minted.error));
  const r = await resolveTicket(fromBase64url(minted.data.ticket), { relay: url, crypto: nodeCrypto() });
  return { relay: r.offer.relay, route: r.offer.route, box: Buffer.from(r.offer.box), secret: r.offer.secret };
}

const NEXT = /master password/;

test("a classic pairing code cannot be made: every way to ask is refused in words that name the next step", async t => {
  const { d } = await world(t);
  for (const [tool, caller] of [["relay.pair.start", "cli"], ["relay.pair.start", "deck"], ["relay.pair.first", "onboard"]]) {
    const r = await d.registry.call(tool, {}, caller, PROOF);
    assert.ok(!r.data, `${tool} as ${caller} made something: ${JSON.stringify(r.data)}`);
    assert.match(String(r.error && r.error.message), NEXT, `${tool} as ${caller}: ${JSON.stringify(r.error)}`);
  }
});

test("a classic pairing code cannot be redeemed: relay.join refuses, and the box refuses a bearer secret with the next step", async t => {
  const { d, url, logs } = await world(t);
  const offer = await ticketOffer(d, url);
  const classicUrl = pairUrl({ relay: offer.relay, route: offer.route, box: offer.box, secret: "A".repeat(22), name: "alex" });
  const j = await d.registry.call("relay.join", { url: classicUrl }, "cli", PROOF);
  assert.ok(!j.data, JSON.stringify(j.data));
  assert.match(String(j.error && j.error.message), NEXT);
  const refused = await dial(offer, keyPair(), "B".repeat(22));
  assert.ok(!refused.reply, "a bearer secret paired a device");
  // a relay passes no reason on to a device but "device removed", so the words are the box's own log
  assert.ok(logs.some(l => /expired or was already used/.test(l) && NEXT.test(l)), logs.join("\n"));
  assert.equal((await d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.length, 0, "nothing was enrolled");
});

test("the ticket path still pairs a device, once, and the device is the owner's own", async t => {
  const { d, url } = await world(t);
  const offer = await ticketOffer(d, url);
  const first = await dial(offer, keyPair(), offer.secret);
  assert.ok(first.reply && first.reply.paired, JSON.stringify(first));
  const row = (await d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.find((/** @type {any} */ x) => x.id === first.reply.device);
  assert.ok(row && row.ownerPaired === true, JSON.stringify(row));
  const again = await dial(offer, keyPair(), offer.secret);
  assert.ok(!again.reply, "a ticket works once");
});

test("a device paired the old way before this version: the owner's own keeps working, an unmarked one is refused with the next step", async t => {
  const { d, url, root } = await world(t);
  // two devices, as the box's last version left them: the owner marked one, nobody confirmed the other (a classic code made it), and neither has been judged by this version yet
  const mk = async () => { const offer = await ticketOffer(d, url); const keys = keyPair(); const paired = await dial(offer, keys, offer.secret); assert.ok(paired.reply && paired.reply.device, JSON.stringify(paired)); return { offer, keys, id: String(paired.reply.device) }; };
  const marked = await mk(), unmarked = await mk(), lateMark = await mk();
  const db = d.registry.deps.db;
  db.prepare("UPDATE relay_devices SET old_code = NULL WHERE id IN (?, ?, ?)").run(marked.id, unmarked.id, lateMark.id);
  db.prepare("UPDATE relay_devices SET owner_paired = NULL WHERE id IN (?, ?)").run(unmarked.id, lateMark.id);
  await d.stop();
  // the upgrade: a new start judges each row once
  const seen = /** @type {any[]} */ ([]);
  const up = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore() });
  t.after(() => up.stop());
  for (let i = 0; i < 100; i++) { const st = (await up.registry.call("relay.status", {}, "cli", PROOF)).data; if (st && st.connected) break; await new Promise(r => setTimeout(r, 100)); }
  up.events.on("device.removed", (/** @type {any} */ e) => seen.push(e.payload || e));
  assert.ok((await dial(marked.offer, marked.keys, null)).reply, "the owner's own device keeps working");
  // the owner marks a phone of his own before it next connects
  up.registry.deps.db.prepare("UPDATE relay_devices SET owner_paired = ? WHERE id = ?").run(JSON.stringify({ by: "owner", at: Date.now(), path: "marked" }), lateMark.id);
  assert.ok((await dial(lateMark.offer, lateMark.keys, null)).reply, "a device marked in time keeps working");
  const refused = await dial(unmarked.offer, unmarked.keys, null);
  assert.ok(!refused.reply, "an unmarked old device is let in");
  assert.match(String(refused.refused), /device removed/, "the device hears the one reason a relay passes on, which sends its app to pair again");
  const gone = seen.find(e => e.id === unmarked.id);
  assert.ok(gone, JSON.stringify(seen));
  assert.match(String(gone.why), NEXT, "the owner's screens get the words and the next step");
  const listed = (await up.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices.map((/** @type {any} */ x) => x.id);
  assert.ok(!listed.includes(unmarked.id) && listed.includes(marked.id) && listed.includes(lateMark.id), JSON.stringify(listed));
  // a device paired after the upgrade by the ticket path is never judged by the old rule
  const fresh = await ticketOffer(up, url);
  const k = keyPair();
  const p2 = await dial(fresh, k, fresh.secret);
  assert.ok(p2.reply && p2.reply.paired, JSON.stringify(p2));
  assert.ok((await dial(fresh, k, null)).reply, "a new device keeps working");
});
