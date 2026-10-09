// @ts-check
// The person session of a device paired over the relay (core/presence/person.js), on a real vyred: the device signs in with its own enrolled key, and a session opened at pairing ends on every end path.
// The cases that drove the removed tailnet names listener (the Deck's passkey sign-in, the hosted and native apps' PKCE trade, the SameSite cookie rules over the listener, device_removed over it) are gone with
// it; the cross-site cookie refusal has its own cases in test/appmods-origin.test.js, and the device_removed answer needs a rewrite onto the relay (team/BACKLOG.md, 0.3.1).

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { start } from "../core/daemon/index.js";
import * as config from "../core/config/index.js";
import { HUMAN_ONLY, fingerprint } from "../core/presence/index.js";
import { COOKIE, signed } from "../core/presence/person.js";
import { Presence } from "../core/presence/index.js";
import { open } from "../core/store/index.js";
import { tempHome } from "./helpers.js";

/** Asks for a proof on every human-only tool and takes any proof: refusals below are about the session. */
const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: proof.method === "device" ? "device" : "passkey", keyId: proof.key || proof.cred || "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  covered: () => false,
  coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]),
  // As the real one: a device key's id is its fingerprint, and the same key twice is refused.
  enroll(k) { const id = fingerprint(k.public_key); if (this.enrolled.some(e => e.id === id)) throw new Error("that key is already enrolled");
    this.enrolled.push({ ...k, id }); return { id, kind: k.kind, name: k.name }; },
};

async function box(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { tailscale: true, owner: "alex@example.com", port: 0 }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());
  const ctx = d.registry.context({ name: "names", version: "0.1.0", does: { tools: [] }, watches: { emits: ["owner.seen"] } });
  // Stands in for tailnet's CORS step, which marks a request from an allowed app origin on the peer.
  const handler = ctx.handler;
  ctx.handler = policy => { const h = handler(policy); return (req, res, caller, peer) => h(req, res, caller, req.headers["x-test-origin"] ? { ...peer, origin: req.headers["x-test-origin"] } : peer); };
  /** One request as the relay bridge hands it over: caller device:<id>, no Origin, host "relay". */
  const relayed = async (id, method, url, input, headers = {}) => {
    const raw = input === undefined ? "" : JSON.stringify(input);
    const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), { method, url, headers: { host: "relay", "content-type": "application/json", ...headers } });
    let out = "", status = 0;
    const res = { setHeader() {}, writeHead(s2) { status = s2; }, end(b = "") { out += b; }, headersSent: false };
    await handler({})(req, res, `device:${id}`, { kind: "device", stableId: id, node: "alex-phone", login: null, tags: [], caps: {} });
    return { status, ...(out ? JSON.parse(out) : {}) };
  };
  return { d, relayed, root };
}


test("person: a device paired over the relay is a device too, and signs in with its own enrolled key", async t => {
  const { d, relayed } = await box(t);
  const ID = "abcdefghijklmnop";
  // The relay's record of which presence key it enrolled for each device (relay.device.presence).
  d.registry.tools.set("relay.device.presence", { module: "relay", description: "", input: { type: "object" }, internal: true, callers: null, hook: false, presence: false,
    run: async ({ id }) => ({ key: id === ID ? "kphone" : null }) });
  assert.equal((await relayed(ID, "POST", "/v1/tools/agents.create", { name: "kit" })).error.code, "person_session_required");
  assert.equal((await relayed(ID, "POST", "/v1/tools/agents.list", {})).status, 200, "reads stay the device's");

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = publicKey.export({ format: "jwk" });
  const proof = k => ({ "x-vyre-presence": `device key=${k} ts=${Date.now()} nonce=abcdefgh1234 sig=x` });
  assert.equal((await relayed(ID, "POST", "/v1/tools/presence.person.start", { key }, proof("kother"))).error.code, "denied", "another device's key");
  assert.equal((await relayed(ID, "POST", "/v1/tools/presence.person.start", { key }, { "x-vyre-presence": "passkey id=x" })).error.code, "denied", "a relayed device signs in with its device key");
  const s = await relayed(ID, "POST", "/v1/tools/presence.person.start", { key }, proof("kphone"));
  assert.equal(s.status, 200, JSON.stringify(s));
  assert.equal(s.data.kind, "bearer");
  const sign = (tool, input, { t = Date.now(), n = crypto.randomBytes(12).toString("base64url") } = {}) => {
    const sig = crypto.sign("sha256", Buffer.from(signed({ method: "POST", path: `/v1/tools/${tool}`, raw: JSON.stringify(input), t, n })), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return { authorization: `Vyre ${s.data.token}`, "x-vyre-proof": `t=${t} n=${n} sig=${sig}` };
  };
  const made = await relayed(ID, "POST", "/v1/tools/agents.create", { name: "kit" }, sign("agents.create", { name: "kit" }));
  assert.equal(made.status, 200, JSON.stringify(made));
  // Pinned to the device id: another relayed device cannot use it.
  assert.equal((await relayed("qrstuvwxyz234567", "POST", "/v1/tools/agents.list", {}, sign("agents.list", {}))).status, 401);

  // A browser paired over the relay: its passkey, enrolled by the relay module alone, for app.vyre.run.
  const spki = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const web = { kind: "passkey", name: "alex-phone web", public_key: spki, alg: -7, rp_id: "app.vyre.run", credential_id: "webcredential1", device: ID };
  assert.equal((await d.registry.call("presence.enroll", web, "cli", { proof: { method: "passkey" } })).error.code, "denied", "only the relay enrolls it");
  assert.equal((await d.registry.call("presence.enroll", { ...web, rp_id: "evil.example" }, "module:relay")).error.code, "denied");
  assert.ok(!(await d.registry.call("presence.enroll", web, "module:relay")).error);
  const w = await relayed(ID, "POST", "/v1/tools/presence.person.start", { key }, { "x-vyre-presence": "passkey id=x cred=webcredential1" });
  assert.equal(w.data && w.data.kind, "bearer", JSON.stringify(w));
  // Another device cannot sign in with it.
  assert.equal((await relayed("qrstuvwxyz234567", "POST", "/v1/tools/presence.person.start", { key }, { "x-vyre-presence": "passkey id=x cred=webcredential1" })).error.code, "denied");
});

test("person: a device its owner paired opens its person session at pairing with no prompt, and every end path closes it", async t => {
  const { d, relayed, root } = await box(t);
  const ID = "abcdefghijklmnop", OTHER = "qrstuvwxyz234567";
  const dk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rogue = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = dk.publicKey.export({ format: "jwk" });
  // wink's pair record, as wink.device.record answers it: confirmed by the owner, with the key the device registered.
  /** @type {any} */ let rec = { id: ID, kind: "phone", confirmed: true, owner: "id1", confirmedBy: "id1", hardware: true, key: jwk, confirmKeyId: "owner-key" };
  d.registry.tools.set("wink.device.record", { module: "wink", description: "", input: { type: "object" }, internal: true, callers: null, hook: false, presence: false, run: async () => rec });
  const sign = (k, text) => crypto.sign("sha256", Buffer.from(text), { key: k.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const signedCall = (tok, k, tool, input, extra = {}) => {
    const t = Date.now(), n = crypto.randomBytes(12).toString("base64url");
    return { authorization: `Vyre ${tok}`, "x-vyre-proof": `t=${t} n=${n} sig=${sign(k, signed({ method: "POST", path: `/v1/tools/${tool}`, raw: JSON.stringify(input), t, n }))}`, ...extra };
  };

  // Nothing is signed in before pairing: the person's own act is refused.
  assert.equal((await relayed(ID, "POST", "/v1/tools/agents.create", { name: "kit" })).error.code, "person_session_required");
  // An unconfirmed record and another caller get no grant; a confirmed browser gets a session and nothing more (reviewer-3's rule, 4 Oct): a grant that is believed in software only.
  rec = { ...rec, confirmed: false };
  assert.ok((await d.registry.call("presence.person.pair-grant", { device: ID }, "module:wink")).error, "unconfirmed");
  rec = { ...rec, confirmed: true, kind: "web", hardware: false };
  const web = await d.registry.call("presence.person.pair-grant", { device: ID }, "module:wink");
  assert.equal(web.data && web.data.granted, true, "a confirmed browser gets its session");
  assert.equal(web.data && web.data.software, true, "and it is a software session, never believed to be in hardware");
  rec = { ...rec, kind: "phone", hardware: true };
  assert.ok((await d.registry.call("presence.person.pair-grant", { device: ID }, "module:relay")).error, "not wink");
  assert.equal((await relayed(ID, "POST", "/v1/tools/presence.person.pair-challenge", {})).data.challenge.length, 32, "a device with no grant gets a challenge of the same shape");
  assert.ok((await relayed(ID, "POST", "/v1/tools/presence.person.start-paired", { sig: sign(dk, "x") })).error, "no grant, no session");

  // The owner confirmed: wink asks for the grant once.
  const g = await d.registry.call("presence.person.pair-grant", { device: ID }, "module:wink");
  assert.equal(g.data.granted, true, JSON.stringify(g));
  const ch = (await relayed(ID, "POST", "/v1/tools/presence.person.pair-challenge", {})).data.challenge;
  assert.equal(ch, g.data.challenge);
  // Another device's channel, and a key that is not the confirmed one, get the same refusal.
  const bad = [await relayed(OTHER, "POST", "/v1/tools/presence.person.start-paired", { sig: sign(dk, `paired-start\n${OTHER}\n${ch}`) }),
    await relayed(ID, "POST", "/v1/tools/presence.person.start-paired", { sig: sign(rogue, `paired-start\n${ID}\n${ch}`) })];
  assert.equal(new Set(bad.map(b => JSON.stringify(b.error))).size, 1, "one refusal for every failure");
  // The device signs with the confirmed key: a session, with no prompt and no passkey.
  const s = await relayed(ID, "POST", "/v1/tools/presence.person.start-paired", { sig: sign(dk, `paired-start\n${ID}\n${ch}`) });
  assert.equal(s.status, 200, JSON.stringify(s));
  const made = await relayed(ID, "POST", "/v1/tools/agents.create", { name: "kit" }, signedCall(s.data.token, dk, "agents.create", { name: "kit" }));
  assert.equal(made.status, 200, JSON.stringify(made));
  // The same signed start again, and another device using the token, get nothing.
  assert.ok((await relayed(ID, "POST", "/v1/tools/presence.person.start-paired", { sig: sign(dk, `paired-start\n${ID}\n${ch}`) })).error);
  assert.equal((await relayed(OTHER, "POST", "/v1/tools/agents.list", {}, signedCall(s.data.token, dk, "agents.list", {}))).status, 401);

  // The row's own clock stands for time passing.
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const day = 86_400_000;
  const row = () => db.prepare("SELECT * FROM presence_people WHERE node = ? AND paired = 1").get(ID);
  let k = 0;
  const act = tok => { const input = { name: `kit${++k}` }; return relayed(ID, "POST", "/v1/tools/agents.create", input, signedCall(tok, dk, "agents.create", input)); };
  const use = () => act(s.data.token);
  // No 90-day cap: a session made 200 days ago, used 5 days ago, still works.
  db.prepare("UPDATE presence_people SET created = ?, last_used = ?, rotated = ? WHERE id = ?").run(Date.now() - 200 * day, Date.now() - 5 * day, Date.now() - 5 * day, s.data.id);
  assert.equal((await use()).status, 200, "day 200, used 5 days ago");
  // 31 days idle: refused, with the sign-in hint.
  db.prepare("UPDATE presence_people SET last_used = ?, rotated = ? WHERE id = ?").run(Date.now() - 31 * day, Date.now() - 31 * day, s.data.id);
  const late = await use();
  assert.equal(late.status, 401);
  assert.match(late.error.message, /sign in again/);
  // A rotation 34 days overdue: only the rotation answers.
  const g2 = await d.registry.call("presence.person.pair-grant", { device: ID }, "module:wink");
  const ch2 = g2.data.challenge;
  const s2 = await relayed(ID, "POST", "/v1/tools/presence.person.start-paired", { sig: sign(dk, `paired-start\n${ID}\n${ch2}`) });
  assert.equal(s2.status, 200, JSON.stringify(s2));
  const use2 = () => act(s2.data.token);
  assert.equal((await use2()).status, 200);
  db.prepare("UPDATE presence_people SET rotated = ? WHERE id = ?").run(Date.now() - 34 * day, s2.data.id);
  const stale = await use2();
  assert.equal(stale.status, 401, "past the grace the secret does nothing else");
  const rotated = await relayed(ID, "POST", "/v1/tools/presence.person.rotate", { t: String(Date.now()), n: "rotatenonce001", sig: "x" }, signedCall(s2.data.token, dk, "presence.person.rotate", { t: String(Date.now()), n: "rotatenonce001", sig: "x" }));
  assert.equal(rotated.status === 401 || Boolean(rotated.error), true, "a rotation with a bad signature is refused");
  // Revoke: refused at once.
  const s3x = row();
  assert.ok(s3x);
  db.prepare("UPDATE presence_people SET rotated = ? WHERE id = ?").run(Date.now(), s2.data.id);
  assert.equal((await use2()).status, 200, "renewed clock works again");
  assert.equal((await d.registry.call("presence.person.revoke", { id: s2.data.id }, "cli", { person: { id: "x", kind: "cookie" } })).data.revoked, s2.data.id);
  assert.equal((await use2()).status, 401, "revoked: refused at once");
  // Device removal, recovery reset and sign-out-everywhere end it through endPaired.
  const g3 = await d.registry.call("presence.person.pair-grant", { device: ID }, "module:wink");
  const s4 = await relayed(ID, "POST", "/v1/tools/presence.person.start-paired", { sig: sign(dk, `paired-start\n${ID}\n${g3.data.challenge}`) });
  const use4 = () => act(s4.data.token);
  assert.equal((await use4()).status, 200);
  assert.ok((await d.registry.call("presence.person.end-paired", { device: ID }, "module:relay")).error, "only wink ends it");
  assert.equal((await d.registry.call("presence.person.end-paired", { device: ID }, "module:wink")).data.ended, 1);
  const gone = await use4();
  assert.equal(gone.status, 401);
  assert.equal(gone.error.code, "device_removed");
  const g5 = await d.registry.call("presence.person.pair-grant", { device: ID }, "module:wink");
  const s5 = await relayed(ID, "POST", "/v1/tools/presence.person.start-paired", { sig: sign(dk, `paired-start\n${ID}\n${g5.data.challenge}`) });
  assert.equal((await d.registry.call("presence.person.end-paired", {}, "module:wink")).data.ended, 1, "reset or sign-out-everywhere ends every paired session");
  assert.equal((await act(s5.data.token)).status, 401);
});
