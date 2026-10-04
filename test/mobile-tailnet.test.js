// @ts-check
// The phone on the tailnet (docs/adr/0018-mobile.md): a real vyred with the real Gate and
// verifier, reached the way the names listener reaches it, with the caller and peer the listener
// sets from `tailscale whois`. A tailnet device may now ask for the human-only tools, and presence
// still decides them: no proof is presence_required, a device key's signature sends.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { Presence, inputHash } from "../core/presence/index.js";
import { tempHome } from "./helpers.js";

const PHONE = { node: "alex-phone", stableId: "nTEST", login: "alex@example.com" };

/** A mail server that records what reaches it. */
async function outbox(t) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", d => (body += d));
    req.on("end", () => { got.push(body); res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m1","threadId":"t1"}'); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { got, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

async function world(t) {
  const root = tempHome(t);
  const mail = await outbox(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" },
    gate: { senders: { mail: { type: "gmail", vault: "mail-token", from: "alex@example.com", base: mail.base } } } }));
  const d = await start({ root, log: () => {}, presence: deps => new Presence({ ...deps,
    touchid: { available: async () => false, authenticate: async () => ({ ok: false, reason: "unavailable" }) }, who: async () => [] }) });
  t.after(() => d.stop());
  // What the names module does for each tailnet request, with the phone as the peer.
  const handle = d.registry.deps.handler({});
  const server = http.createServer((req, res) => handle(req, res, `tailnet:${PHONE.login}`, PHONE));
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(() => r(undefined))); });
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const phone = async (tool, input, headers = {}) => {
    const r = await fetch(`${base}/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
    return { status: r.status, body: await r.json(), cookie: String(r.headers.get("set-cookie") || "").split(";")[0] };
  };

  // The mail credential and a held draft, set up by alex at the Mac with a signed Capsule call.
  const cap = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const capKey = d.registry.deps.presence.enroll({ kind: "capsule", name: "Capsule", public_key: cap.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 });
  const person = (tool, input) => {
    const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: cap.privateKey, dsaEncoding: "der" }).toString("base64url");
    return d.registry.call(tool, input, "cli", { proof: { method: "capsule", key: capKey.id, ts, nonce, sig } });
  };
  const put = await person("vault.put", { name: "mail-token", kind: "api-key", fields: { value: "fixture-" + crypto.randomBytes(8).toString("hex") } });
  assert.ok(put.data, JSON.stringify(put));
  assert.ok((await person("vault.grant", { name: "mail-token", module: "gate" })).data);
  const held = await call("gate.request", { kind: "send", via: "mail", to: "dana@harlowlegal.example", content: { subject: "Hello", body: "Draft by the model" } }, { root, caller: "mcp" });
  assert.equal(held.data.state, "held");
  return { d, mail, phone, base, id: held.data.id };
}

/** A P-256 key as the phone's hardware makes it, and the header it signs a call with. */
function deviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const id = crypto.createHash("sha256").update(Buffer.from(pub, "base64url")).digest("base64url").slice(0, 22);
  const header = (tool, input) => {
    const ts = Date.now(), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    return { "x-vyre-presence": `device key=${id} ts=${ts} nonce=${nonce} sig=${sig}` };
  };
  return { pub, id, header };
}

test("mobile: a tailnet device is asked for presence on gate.approve, and a device key's signature sends it", async t => {
  const w = await world(t);
  const tools = await (await fetch(`${w.base}/v1/tools`)).json();
  for (const name of ["gate.get", "gate.approve", "gate.reject", "gate.revise", "threads.answer", "push.subscribe", "vault.reveal", "vault.totp", "presence.session.open"]) {
    assert.ok(tools.data.some(x => x.name === name), `${name} is listed for the phone`);
  }
  // The owner's phone is the owner: what the Deck may use, it may (callerAllowed on main). A tool
  // closed to the Deck stays closed to it.
  for (const name of ["memory.correct", "agents.delete"]) assert.ok(tools.data.some(x => x.name === name), `${name} is listed, as for the Deck`);
  assert.ok(!tools.data.some(x => x.name === "link.pair"), "link.pair stays off the phone");
  assert.equal((await w.phone("gate.get", { id: w.id })).status, 200, "the phone reads a held item");

  // The owner's own action wants the person's session first (ADR 0032), whatever the caller claims.
  const bare = await w.phone("gate.approve", { id: w.id });
  assert.equal(bare.status, 401, JSON.stringify(bare.body));
  assert.equal(bare.body.error.code, "person_session_required");
  assert.equal((await w.phone("gate.approve", { id: w.id }, { "x-vyre-caller": "cli" })).body.error.code, "person_session_required", "a forged caller header changes nothing");
  assert.equal(w.mail.got.length, 0);

  // Enroll the device key with a one-time code, as /onboard/device does when the box has no passkey.
  const k = deviceKey();
  const code = (await w.d.registry.call("presence.code", {}, "module:test")).data.code;
  const enroll = { kind: "device", name: "alex-phone", public_key: k.pub, alg: -7 };
  const enrolled = await w.phone("presence.enroll", enroll, { "x-vyre-presence": `code code=${code}` });
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  assert.equal(enrolled.body.data.id, k.id);

  // The device key signs the phone in as the person.
  const signin = await w.phone("presence.person.start", {}, k.header("presence.person.start", {}));
  assert.equal(signin.status, 200, JSON.stringify(signin.body));
  assert.ok(signin.cookie, "a session cookie");
  const person = { cookie: signin.cookie };

  // Signed in, a send still asks for a proof, and the device is offered.
  const asked = await w.phone("gate.approve", { id: w.id }, person);
  assert.equal(asked.status, 403, JSON.stringify(asked.body));
  assert.equal(asked.body.error.code, "presence_required", "a device is asked for a proof, not denied");
  assert.ok(asked.body.error.methods.includes("device"), "device is offered once enrolled");

  const wrong = await w.phone("gate.approve", { id: w.id }, { ...person, ...k.header("gate.approve", { id: "someone-else" }) });
  assert.equal(wrong.body.error.code, "presence_required", "a proof for another item is no proof");
  const ok = await w.phone("gate.approve", { id: w.id }, { ...person, ...k.header("gate.approve", { id: w.id }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(w.mail.got.length, 1, "the approved draft went out");

  // A device proof opens a presence session bound to this phone.
  const s = await w.phone("presence.session.open", {}, { ...person, ...k.header("presence.session.open", {}) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.ok(s.body.data.session && s.body.data.secret);
});
