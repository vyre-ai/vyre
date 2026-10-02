// @ts-check
// The person session over the tailnet (core/presence/person.js), end to end: the real names
// listener's request path with whois simulated, in front of a real vyred router. A node signed in
// as the owner is only the owner's device; a script on it (no cookie, no signed token) cannot
// answer an ask, approve, open a terminal or reach a human-only tool.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { start } from "../core/daemon/index.js";
import * as config from "../core/config/index.js";
import { names } from "../core/names/service.js";
import { HUMAN_ONLY, fingerprint } from "../core/presence/index.js";
import { COOKIE, signed } from "../core/presence/person.js";
import { Presence } from "../core/presence/index.js";
import { open } from "../core/store/index.js";
import { tempHome } from "./helpers.js";

const MAC_IP = "100.101.1.2", PHONE_IP = "100.101.1.3";
const WHO = {
  [MAC_IP]: { login: "alex@example.com", tagged: false, node: "alex-mac", stableId: "nMAC", tags: [], caps: {} },
  [PHONE_IP]: { login: "alex@example.com", tagged: false, node: "alex-phone", stableId: "nPHONE", tags: [], caps: {} },
};

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
  const svc = names({ ctx, ts: { whois: async ip => WHO[ip] || null, status: async () => ({}) }, save: p => config.save(p, root, d.config),
    certs: { load: () => null, save: () => {} }, dns: async () => ({}), issue: async () => ({}) });
  t.after(() => svc.close());
  /** One request through the listener. `origin` stands for tailnet's CORS marking a cross-origin call. */
  const send = async (ip, method, url, input, headers = {}) => {
    const raw = input === undefined ? "" : JSON.stringify(input);
    const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), { method, url,
      headers: { host: "alex.vyre.run:0", "content-type": "application/json", ...headers }, socket: { remoteAddress: ip } });
    let out = "", status = 0;
    /** @type {Record<string, any>} */
    const set = {};
    const res = { setHeader(k, v) { set[k.toLowerCase()] = v; }, writeHead(s, h = {}) { status = s; for (const [k, v] of Object.entries(h)) set[k.toLowerCase()] = v; }, end(b = "") { out += b; }, headersSent: false };
    await svc.onRequest(req, res);
    return { status, headers: set, ...(out ? JSON.parse(out) : {}) };
  };
  const call = (ip, tool, input = {}, headers) => send(ip, "POST", `/v1/tools/${tool}`, input, headers);
  /** One request as the relay bridge hands it over: caller device:<id>, no Origin, host "relay". */
  const relayed = async (id, method, url, input, headers = {}) => {
    const raw = input === undefined ? "" : JSON.stringify(input);
    const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), { method, url, headers: { host: "relay", "content-type": "application/json", ...headers } });
    let out = "", status = 0;
    const res = { setHeader() {}, writeHead(s2) { status = s2; }, end(b = "") { out += b; }, headersSent: false };
    await handler({})(req, res, `device:${id}`, { kind: "device", stableId: id, node: "alex-phone", login: null, tags: [], caps: {} });
    return { status, ...(out ? JSON.parse(out) : {}) };
  };
  return { d, send, call, relayed, root };
}

/** The cookie a presence.person.start answer set, as a request's cookie header. */
const cookieOf = r => String(r.headers["set-cookie"] || "").split(";")[0];

test("person: a script on the owner's Mac is the owner's device, never the person", async t => {
  const { call } = await box(t);
  for (const [tool, input] of [["threads.answer", { ask: "0123456789abcdef01", decision: "allow" }], ["gate.reject", { id: "g1" }],
    ["agents.create", { name: "kit" }], ["term.open", {}], ["vault.reveal", { name: "northwind-mail" }]]) {
    const r = await call(MAC_IP, tool, input);
    assert.equal(r.status, 401, `${tool}: ${JSON.stringify(r)}`);
    assert.equal(r.error.code, "person_session_required", tool);
  }
  // A proof alone is not enough over the tailnet: human-only still wants the person's session.
  const proved = await call(MAC_IP, "vault.reveal", { name: "northwind-mail" }, { "x-vyre-presence": "passkey id=x" });
  assert.equal(proved.error.code, "person_session_required");
  // Reads stay the device's: the Deck loads before anyone signs in.
  assert.equal((await call(MAC_IP, "agents.list")).status, 200);
  assert.deepEqual((await call(MAC_IP, "presence.person.status")).data, { signed: false });
});

test("person: the Deck signs in with a passkey, gets an HttpOnly cookie pinned to its node, and the secret never reaches the page", async t => {
  const { call, send } = await box(t);
  assert.equal((await call(MAC_IP, "presence.person.start", {})).error.code, "presence_required", "signing in takes a passkey");
  const s = await call(MAC_IP, "presence.person.start", {}, { "x-vyre-presence": "passkey id=x" });
  assert.equal(s.status, 200, JSON.stringify(s));
  assert.equal(s.data.token, undefined, "the secret is only in the cookie");
  const setCookie = String(s.headers["set-cookie"]);
  assert.match(setCookie, new RegExp(`^${COOKIE}=[\\w-]+\\.[\\w-]+; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=7776000$`));
  const cookie = { cookie: cookieOf(s) };

  assert.deepEqual((await call(MAC_IP, "presence.person.status", {}, cookie)).data, { signed: true, id: s.data.id, kind: "cookie" });
  const made = await call(MAC_IP, "agents.create", { name: "kit" }, cookie);
  assert.equal(made.status, 200, JSON.stringify(made));
  // Human-only: the session and a proof.
  assert.notEqual((await call(MAC_IP, "presence.person.revoke", { id: "nope" }, cookie)).error.code, "person_session_required");

  // The same cookie from the phone is refused: it was made on the Mac.
  assert.equal((await call(PHONE_IP, "agents.update", { name: "kit", description: "x" }, cookie)).error.code, "person_session_required");

  // Listed without a secret, revoked from anywhere signed in, and then it is only a device again.
  const list = (await call(MAC_IP, "presence.person.sessions", {}, cookie)).data.sessions;
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ["created", "expires", "id", "kind", "label", "last_used", "node"]);
  assert.equal(list[0].node, "nMAC");
  const end = await send(MAC_IP, "POST", "/v1/person/end", {}, cookie);
  assert.equal(end.data.ended, true);
  assert.match(String(end.headers["set-cookie"]), /Max-Age=0/);
  assert.equal((await call(MAC_IP, "agents.create", { name: "juno" }, cookie)).error.code, "person_session_required");
});

test("person: the hosted app gets a code on the box's page, trades it with PKCE and a key, and signs every request", async t => {
  const { call, send } = await box(t);
  const verifier = crypto.randomBytes(32).toString("base64url");
  const cc = crypto.createHash("sha256").update(verifier).digest("base64url");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = publicKey.export({ format: "jwk" });

  const APP = "https://app.vyre.run";
  const back = { return: `${APP}/signed-in?x=1` };
  const app = { "x-test-origin": APP };
  // The code goes back only to an allowed app, never to a page that names itself.
  for (const bad of ["https://evil.example/cb", "http://app.vyre.run/cb", "not a url"]) {
    const r = await call(PHONE_IP, "presence.person.start", { cc, return: bad }, { "x-vyre-presence": "passkey id=x" });
    assert.ok(["denied", "bad_input"].includes(r.error && r.error.code), `${bad}: ${JSON.stringify(r)}`);
  }
  const c = await call(PHONE_IP, "presence.person.start", { cc, label: "Vyre app", ...back }, { "x-vyre-presence": "passkey id=x" });
  assert.equal(c.data.kind, "code");
  assert.equal(c.data.redirect, `${APP}/signed-in?x=1&code=${c.data.code}`);
  assert.equal(c.headers["set-cookie"], undefined, "no cookie for the app");

  // The code is bound to its node and its verifier, and is used once.
  assert.equal((await send(MAC_IP, "POST", "/v1/person/token", { code: c.data.code, verifier, key }, app)).error.code, "denied");
  const c2 = await call(PHONE_IP, "presence.person.start", { cc, ...back }, { "x-vyre-presence": "passkey id=x" });
  assert.equal((await send(PHONE_IP, "POST", "/v1/person/token", { code: c2.data.code, verifier: "wrong", key }, app)).error.code, "denied");
  const c4 = await call(PHONE_IP, "presence.person.start", { cc, ...back }, { "x-vyre-presence": "passkey id=x" });
  assert.equal((await send(PHONE_IP, "POST", "/v1/person/token", { code: c4.data.code, verifier, key })).error.code, "denied", "only the app it was made for trades it");
  const c3 = await call(PHONE_IP, "presence.person.start", { cc, ...back }, { "x-vyre-presence": "passkey id=x" });
  const tok = await send(PHONE_IP, "POST", "/v1/person/token", { code: c3.data.code, verifier, key }, app);
  assert.equal(tok.status, 200, JSON.stringify(tok));
  assert.equal((await send(PHONE_IP, "POST", "/v1/person/token", { code: c3.data.code, verifier, key }, app)).error.code, "denied", "used once");
  // From the app's origin, nothing works without the session.
  assert.equal((await call(PHONE_IP, "agents.list", {}, app)).status, 401);

  const sign = (tool, input, { t = Date.now(), n = crypto.randomBytes(12).toString("base64url"), k = privateKey } = {}) => {
    const raw = JSON.stringify(input);
    const sig = crypto.sign("sha256", Buffer.from(signed({ method: "POST", path: `/v1/tools/${tool}`, raw, t, n })), { key: k, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return { authorization: `Vyre ${tok.data.token}`, "x-vyre-proof": `t=${t} n=${n} sig=${sig}` };
  };
  const ok = await call(PHONE_IP, "agents.create", { name: "kit" }, sign("agents.create", { name: "kit" }));
  assert.equal(ok.status, 200, JSON.stringify(ok));

  // The token alone, an old signature, a replay, another key, another body: all refused.
  assert.equal((await call(PHONE_IP, "agents.list", {}, { authorization: `Vyre ${tok.data.token}` })).status, 401);
  assert.equal((await call(PHONE_IP, "agents.list", {}, sign("agents.list", {}, { t: Date.now() - 5 * 60_000 }))).status, 401);
  const once = sign("agents.list", {});
  assert.equal((await call(PHONE_IP, "agents.list", {}, once)).status, 200);
  assert.equal((await call(PHONE_IP, "agents.list", {}, once)).status, 401, "a replay");
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  assert.equal((await call(PHONE_IP, "agents.list", {}, sign("agents.list", {}, { k: other }))).status, 401);
  assert.equal((await call(PHONE_IP, "agents.create", { name: "evil" }, sign("agents.create", { name: "kit2" }))).status, 401, "signed for another body");
  // From the Mac, the phone's token is nothing.
  assert.equal((await call(MAC_IP, "agents.list", {}, sign("agents.list", {}))).status, 401);
});

test("person: from the hosted app's origin, nothing at all without a session but that the box is there", async t => {
  const { send } = await box(t);
  const app = { "x-test-origin": "https://app.vyre.run" };
  assert.deepEqual((await send(PHONE_IP, "GET", "/v1/health", undefined, app)).data, { reachable: true }, "reachable, and nothing else about the box");
  for (const [method, url] of [["GET", "/v1/tools"], ["GET", "/v1/events"], ["GET", "/v1/events/stream"], ["GET", "/v1/modules"],
    ["POST", "/v1/tools/agents.list"], ["POST", "/v1/presence/challenge"], ["GET", "/now"]]) {
    const r = await send(PHONE_IP, method, url, method === "POST" ? {} : undefined, app);
    assert.equal(r.status, 401, `${method} ${url}: ${JSON.stringify(r).slice(0, 120)}`);
    assert.equal(r.error.code, "person_session_required");
  }
  // The token trade is the one call that answers (here refusing a made-up code).
  assert.equal((await send(PHONE_IP, "POST", "/v1/person/token", { code: "x", verifier: "y", key: {} }, app)).status, 403);
});

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

test("person: the native app returns to vyre:// and must sign the trade with the key it registers", async t => {
  const { call, send } = await box(t);
  const verifier = crypto.randomBytes(32).toString("base64url");
  const cc = crypto.createHash("sha256").update(verifier).digest("base64url");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = publicKey.export({ format: "jwk" });
  assert.equal((await call(PHONE_IP, "presence.person.start", { cc, return: "vyre://elsewhere/x" }, { "x-vyre-presence": "passkey id=x" })).error.code, "denied");
  const code = async () => (await call(PHONE_IP, "presence.person.start", { cc, return: "vyre://person/signin" }, { "x-vyre-presence": "passkey id=x" })).data.code;
  const human = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  const trade = (c, k = privateKey, extra = {}) => {
    const body = { code: c, verifier, key, human };
    const t2 = Date.now(), n = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(signed({ method: "POST", path: "/v1/person/token", raw: JSON.stringify(body), t: t2, n })), { key: k, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return send(PHONE_IP, "POST", "/v1/person/token", body, { "x-vyre-proof": `t=${t2} n=${n} sig=${sig}`, ...extra });
  };
  assert.equal((await send(PHONE_IP, "POST", "/v1/person/token", { code: await code(), verifier, key })).error.code, "denied", "unsigned");
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  assert.equal((await trade(await code(), other)).error.code, "denied", "signed by another key");
  assert.equal((await trade(await code(), privateKey, { "x-test-origin": "https://app.vyre.run" })).error.code, "denied", "a web page cannot trade a native code");
  const before = lenient.enrolled.length;
  const ok = await trade(await code());
  assert.equal(ok.status, 200, JSON.stringify(ok));
  // The biometric key rides the trade: enrolled as a device presence key, for HUMAN_ONLY proofs.
  assert.match(ok.data.human.key, /^[\w-]{22}$/);
  const k = lenient.enrolled[lenient.enrolled.length - 1];
  assert.equal(lenient.enrolled.length, before + 1);
  assert.deepEqual([k.kind, k.alg], ["device", -7]);
  assert.equal(crypto.createPublicKey({ key: Buffer.from(k.public_key, "base64url"), format: "der", type: "spki" }).export({ format: "jwk" }).x, human.x);
  // Signing in again with the same biometric key answers the id it already has.
  const again = await trade(await code());
  assert.deepEqual(again.data.human, { key: ok.data.human.key });
  assert.match(ok.data.token, /^[\w-]+\.[\w-]+$/);
});

test("person: a device whose passkey was removed is told device_removed, but only when it holds the credential the box issued", async t => {
  const { call, root } = await box(t);
  const s = await call(MAC_IP, "presence.person.start", {}, { "x-vyre-presence": "passkey id=x key=pk1" });
  assert.equal(s.status, 200, JSON.stringify(s));
  const cookie = { cookie: cookieOf(s) };
  assert.equal((await call(MAC_IP, "presence.person.status", {}, cookie)).data.signed, true);

  // The real removal, on the same database: the key's sessions end and are remembered for 30 days.
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  db.prepare("INSERT INTO presence_keys (id, kind, name, public_key, alg, sign_count, created) VALUES (?,?,?,?,?,0,?)").run("pk1", "passkey", "alex-phone", "x", -7, Date.now());
  db.prepare("UPDATE presence_people SET key_id = ? WHERE id = ?").run("pk1", s.data.id);
  assert.equal(Presence.prototype.remove.call({ db, now: Date.now, coreLink: null }, "pk1"), true);

  const gone = await call(MAC_IP, "agents.list", {}, cookie);
  assert.equal(gone.status, 401);
  assert.equal(gone.error.code, "device_removed");
  // A stranger, or a guess at the secret, gets what anyone always got: nothing says that key ever existed.
  const [id] = cookie.cookie.replace(`${COOKIE}=`, "").split(".");
  for (const bad of [`${COOKIE}=${id}.${"A".repeat(43)}`, `${COOKIE}=${"B".repeat(16)}.${"A".repeat(43)}`]) {
    const r = await call(MAC_IP, "agents.create", { name: "juno" }, { cookie: bad });
    assert.notEqual(r.error && r.error.code, "device_removed", bad);
  }
});

test("person: a cookie sent by a request another site or an opaque frame started is not the person's (Safari sends SameSite=Strict from a sandboxed frame)", async t => {
  const { call } = await box(t);
  const s = await call(MAC_IP, "presence.person.start", {}, { "x-vyre-presence": "passkey id=x" });
  const cookie = cookieOf(s);
  const status = headers => call(MAC_IP, "presence.person.status", {}, { cookie, ...headers });
  assert.equal((await status({})).data.signed, true, "no Sec-Fetch headers (curl, a native client, an old browser): untouched");
  assert.equal((await status({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" })).data.signed, true, "the Deck's own fetch");
  assert.equal((await status({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe" })).data.signed, true, "the Deck's own iframe load stays working");
  assert.equal((await status({ "sec-fetch-site": "none", "sec-fetch-dest": "document" })).data.signed, true, "the person typing the address");
  assert.equal((await status({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" })).data.signed, false, "another site");
  assert.equal((await status({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" })).data.signed, false);
  assert.equal((await status({ "sec-fetch-site": "same-site", "sec-fetch-dest": "iframe" })).data.signed, false, "a frame that is not from this origin");
  assert.equal((await status({ "sec-fetch-site": "same-site", "sec-fetch-dest": "document" })).data.signed, false, "another box's page on a sibling name (vyre.run is not a public suffix)");
  assert.equal((await status({ "sec-fetch-site": "same-site", "sec-fetch-dest": "empty" })).data.signed, false, "a same-site fetch");
  assert.equal((await status({ "sec-fetch-site": "same-site", "sec-fetch-dest": "embed" })).data.signed, false);
  assert.equal((await status({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "object" })).data.signed, false);
});
