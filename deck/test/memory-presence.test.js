// @ts-check
// The Deck's passkey presence flow (deck/views/memory-presence.js) against a fake vyred and a
// fake navigator.credentials. The fake authenticator signs for real (ES256), so the header's
// encoding is checked the way vyred checks it (docs/adr/0004-presence.md). A real platform
// passkey cannot be made headless; this is as close as node gets.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { b64uEncode, b64uDecode, publicKeyOptions, passkeyHeader, withPresence, isExpired } from "../views/memory-presence.js";
import { lessonSummary, skillSummary, correctSummary, presenceCommand } from "../views/memory-data.js";

// core/presence/index.js's parse(), as on the security branch: "<method> k=v k=v".
function parse(header) {
  const [method, ...rest] = header.trim().split(/\s+/);
  const out = { method };
  for (const part of rest) {
    const m = /^([a-z][a-z0-9_]*)=(\S*)$/.exec(part);
    if (!m || m[1] === "method" || Object.hasOwn(out, m[1])) return null;
    out[m[1]] = m[2];
  }
  return out;
}

const RP = "localhost";
const sha = b => crypto.createHash("sha256").update(b).digest();

/** A platform authenticator that says yes (or throws what it is told to). */
function authenticator({ fail = /** @type {any} */ (null) } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rawId = crypto.randomBytes(16);
  const calls = /** @type {any[]} */ ([]);
  return {
    rawId, publicKey, calls,
    credentials: {
      async get(/** @type {any} */ o) {
        calls.push(o);
        if (fail) throw fail;
        const pk = o.publicKey;
        const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64uEncode(pk.challenge), origin: "http://localhost:4747" }));
        const ad = Buffer.concat([sha(Buffer.from(pk.rpId)), Buffer.from([0x05]), Buffer.from([0, 0, 0, 0])]);
        const signature = crypto.sign("sha256", Buffer.concat([ad, sha(cd)]), privateKey);
        const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        return { rawId: ab(rawId), response: { authenticatorData: ab(ad), clientDataJSON: ab(cd), signature: ab(signature) } };
      },
    },
  };
}

/**
 * A fake vyred: the tool needs presence until a header arrives; the challenge route hands out
 * options. `verify` checks the header like vyred would, with the authenticator's public key.
 */
function vyred({ methods = ["tty", "passkey"], auth = /** @type {any} */ (null), challengeError = /** @type {any} */ (null), retryError = /** @type {any} */ (null), tool = "learn.accept" } = {}) {
  const seen = /** @type {any[]} */ ([]);
  const wa = b64uEncode(crypto.randomBytes(32));
  const f = async (/** @type {string} */ url, /** @type {any} */ init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, headers: init.headers, body });
    const json = (/** @type {any} */ b) => ({ status: b.error ? 403 : 200, statusText: "", json: async () => b });
    if (url === "/v1/presence/challenge") {
      if (challengeError) return json({ error: challengeError });
      return json({ data: { challenge: "ch_1-x", webauthn: { challenge: wa, rpId: RP, userVerification: "required", timeout: 60000,
        allowCredentials: auth ? [{ type: "public-key", id: b64uEncode(auth.rawId) }] : [] } } });
    }
    assert.equal(url, "/v1/tools/" + encodeURIComponent(tool));
    const h = init.headers["x-vyre-presence"];
    if (!h) return json({ error: { code: "presence_required", message: `${tool} needs a person`, methods } });
    if (retryError) return json({ error: retryError });
    const p = parse(h);
    assert.ok(p, "the header parses");
    assert.equal(p.method, "passkey");
    assert.equal(p.id, "ch_1-x");
    const cd = JSON.parse(Buffer.from(b64uDecode(p.cd)).toString("utf8"));
    assert.equal(cd.challenge, wa, "the WebAuthn challenge round-trips");
    assert.equal(p.cred, b64uEncode(auth.rawId));
    const ad = Buffer.from(b64uDecode(p.ad));
    assert.ok(ad.subarray(0, 32).equals(sha(Buffer.from(RP))));
    const ok = crypto.verify("sha256", Buffer.concat([ad, sha(Buffer.from(b64uDecode(p.cd)))]), { key: auth.publicKey, dsaEncoding: "der" }, Buffer.from(b64uDecode(p.sig)));
    assert.ok(ok, "the signature checks out");
    return json({ data: { id: body.id, status: "active" } });
  };
  return { f, seen, wa };
}

/** A sheet that records what it shows and lets the test press its buttons. */
function sheet(script = /** @type {(v: any, s: any) => void} */ ((v) => { if (v.state === "ask") v.confirm(); })) {
  const s = { views: /** @type {any[]} */ ([]), closed: 0, show(/** @type {any} */ v) { s.views.push(v); queueMicrotask(() => script(v, s)); }, close() { s.closed++; } };
  return s;
}
const states = s => s.views.map(v => v.state);

// ---- encoding ----------------------------------------------------------------------------------

test("base64url: round trip, no padding, and the URL alphabet", () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33, 70000]) {
    const b = crypto.randomBytes(n);
    const s = b64uEncode(b);
    assert.doesNotMatch(s, /[+/=]/);
    assert.equal(s, b.toString("base64url"));
    assert.deepEqual(Buffer.from(b64uDecode(s)), b);
  }
  assert.equal(b64uEncode(new Uint8Array([251, 255]).buffer), "-_8");
  assert.deepEqual([...b64uDecode("-_8")], [251, 255]);
  assert.deepEqual([...b64uDecode("+/8=")], [251, 255], "plain base64 with padding is read too");
  assert.equal(b64uEncode(new DataView(new Uint8Array([9, 1, 2, 9]).buffer, 1, 2)), Buffer.from([1, 2]).toString("base64url"), "a view encodes only its window");
  assert.throws(() => b64uDecode("a b"));
  assert.throws(() => b64uDecode(/** @type {any} */ (7)));
});

test("vyred's WebAuthn options become bytes for navigator.credentials.get", () => {
  const id = crypto.randomBytes(16);
  const o = publicKeyOptions({ challenge: "AAEC", rpId: "box.tail.ts.net", allowCredentials: [{ type: "public-key", id: id.toString("base64url") }], userVerification: "required", timeout: 60000 });
  assert.deepEqual([...o.challenge], [0, 1, 2]);
  assert.equal(o.rpId, "box.tail.ts.net");
  assert.equal(o.userVerification, "required");
  assert.equal(o.timeout, 60000);
  assert.deepEqual(Buffer.from(o.allowCredentials[0].id), id);
  assert.equal(o.allowCredentials[0].type, "public-key");
  assert.throws(() => publicKeyOptions(/** @type {any} */ (null)));
});

test("the header is what core/presence parses: passkey id cred ad cd sig", async () => {
  const a = authenticator();
  const cred = await a.credentials.get({ publicKey: publicKeyOptions({ challenge: "AAEC", rpId: RP }) });
  const hdr = passkeyHeader("ch_1-x", cred);
  assert.match(hdr, /^passkey id=ch_1-x cred=[A-Za-z0-9_-]+ ad=[A-Za-z0-9_-]+ cd=[A-Za-z0-9_-]+ sig=[A-Za-z0-9_-]+$/);
  assert.deepEqual(Object.keys(/** @type {any} */ (parse(hdr))), ["method", "id", "cred", "ad", "cd", "sig"]);
  assert.throws(() => passkeyHeader("a b", cred), /token/);
  assert.throws(() => passkeyHeader("x", /** @type {any} */ ({ rawId: new ArrayBuffer(1), response: {} })), /assertion/);
});

// ---- the flow ----------------------------------------------------------------------------------

test("no presence needed: one call, no sheet", async () => {
  const s = sheet();
  const f = async () => ({ status: 200, statusText: "", json: async () => ({ data: { ok: 1 } }) });
  assert.deepEqual(await withPresence("memory.correct", { fact: "f1", action: "wrong" }, { fetch: /** @type {any} */ (f), sheet: s, credentials: null }), { ok: 1 });
  assert.equal(s.views.length, 0);
});

test("presence_required: challenge, summary, passkey, then the same call with the header", async () => {
  const a = authenticator();
  const v = vyred({ auth: a });
  const s = sheet();
  const input = { id: 7 };
  const r = await withPresence("learn.accept", input, { fetch: /** @type {any} */ (v.f), credentials: a.credentials, sheet: s, summary: "Accept lesson “x” · block · everywhere" });
  assert.deepEqual(r, { id: 7, status: "active" });
  assert.deepEqual(v.seen.map(x => x.url), ["/v1/tools/learn.accept", "/v1/presence/challenge", "/v1/tools/learn.accept"]);
  assert.deepEqual(v.seen[1].body, { tool: "learn.accept", input, method: "passkey" });
  assert.deepEqual(v.seen[2].body, input, "the retry carries the same input, so its hash matches");
  assert.equal(v.seen[2].headers["x-vyre-caller"], "deck");
  assert.deepEqual(states(s), ["working", "ask", "working", "working"]);
  assert.equal(s.views.find(x => x.state === "ask").summary, "Accept lesson “x” · block · everywhere");
  assert.equal(s.closed, 1);
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].publicKey.userVerification, "required");
});

test("no passkey offered: the sheet says Settings or the terminal, and nothing is asked of the browser", async () => {
  const a = authenticator();
  const v = vyred({ methods: ["tty"], auth: a });
  const s = sheet(x => x.cancel());
  await assert.rejects(withPresence("learn.accept", { id: 7 }, { fetch: /** @type {any} */ (v.f), credentials: a.credentials, sheet: s, command: "vyre learn accept 7" }),
    e => e.state === "no_passkey" && e.code === "presence_no_passkey");
  assert.equal(s.views[0].state, "no_passkey");
  assert.equal(s.views[0].command, "vyre learn accept 7");
  assert.equal(a.calls.length, 0);
  assert.equal(v.seen.length, 1, "no challenge is started");
});

test("no passkey enrolled, though vyred listed it: the challenge's refusal turns into the same state", async () => {
  const a = authenticator();
  const v = vyred({ auth: a, challengeError: { code: "bad_input", message: "no passkey is enrolled; enroll one with presence.enroll" } });
  const s = sheet(x => { if (x.state === "no_passkey") x.cancel(); });
  await assert.rejects(withPresence("learn.accept", { id: 7 }, { fetch: /** @type {any} */ (v.f), credentials: a.credentials, sheet: s }), e => e.state === "no_passkey");
  assert.deepEqual(states(s), ["working", "no_passkey"]);
});

test("a browser without WebAuthn: no_passkey", async () => {
  const v = vyred();
  const s = sheet(x => x.cancel());
  await assert.rejects(withPresence("learn.accept", { id: 7 }, { fetch: /** @type {any} */ (v.f), credentials: undefined, sheet: s }), e => e.state === "no_passkey");
});

test("Cancel on the sheet: rejected as cancelled, no passkey prompt, no retry", async () => {
  const a = authenticator();
  const v = vyred({ auth: a, tool: "learn.retire" });
  const s = sheet(x => { if (x.state === "ask") x.cancel(); });
  await assert.rejects(withPresence("learn.retire", { id: 7 }, { fetch: /** @type {any} */ (v.f), credentials: a.credentials, sheet: s }), e => e.state === "cancelled");
  assert.equal(a.calls.length, 0);
  assert.equal(v.seen.filter(x => x.url.startsWith("/v1/tools/")).length, 1);
  assert.equal(s.closed, 1);
});

test("the passkey prompt dismissed (NotAllowedError): cancelled, no retry", async () => {
  const a = authenticator({ fail: Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" }) });
  const v = vyred({ auth: a, tool: "learn.relax" });
  const s = sheet();
  await assert.rejects(withPresence("learn.relax", { id: 7, level: "ask" }, { fetch: /** @type {any} */ (v.f), credentials: a.credentials, sheet: s }), e => e.state === "cancelled");
  assert.equal(v.seen.length, 2, "first call and challenge only");
  assert.ok(a.calls[0].publicKey && a.calls[0].signal, "the prompt can be aborted when the sheet closes");
});

test("expired: the sheet says so and Try again starts a fresh challenge", async () => {
  const a = authenticator();
  const v = vyred({ auth: a });
  let tries = 0;
  const f = async (/** @type {string} */ url, /** @type {any} */ init) => {
    if (init.headers["x-vyre-presence"] && tries++ === 0) return { status: 403, statusText: "", json: async () => ({ error: { code: "presence_required", message: "no such passkey challenge, or it expired", methods: ["passkey"] } }) };
    return v.f(url, init);
  };
  const s = sheet(x => { if (x.state === "ask") x.confirm(); if (x.state === "expired") x.retry(); });
  const r = await withPresence("learn.accept", { id: 7 }, { fetch: /** @type {any} */ (f), credentials: a.credentials, sheet: s });
  assert.equal(r.status, "active");
  assert.ok(states(s).includes("expired"));
  assert.equal(v.seen.filter(x => x.url === "/v1/presence/challenge").length, 2);
});

test("refused: the sheet shows vyred's words, and closing it rejects with them", async () => {
  const a = authenticator();
  const v = vyred({ auth: a, retryError: { code: "presence_required", message: "the passkey assertion does not check out: user not verified", methods: ["passkey"] } });
  const s = sheet(x => { if (x.state === "ask") x.confirm(); if (x.state === "refused") x.cancel(); });
  await assert.rejects(withPresence("learn.accept", { id: 7 }, { fetch: /** @type {any} */ (v.f), credentials: a.credentials, sheet: s }),
    e => e.state === "refused" && /user not verified/.test(e.message));
  const refused = s.views.find(x => x.state === "refused");
  assert.match(refused.text, /user not verified/);
  assert.equal(refused.retry, undefined, "a refusal is not retried blind");
});

test("another error after the proof comes back ApiError-shaped", async () => {
  const a = authenticator();
  const v = vyred({ auth: a, retryError: { code: "failed", message: "no such lesson" } });
  await assert.rejects(withPresence("learn.accept", { id: 7 }, { fetch: /** @type {any} */ (v.f), credentials: a.credentials, sheet: sheet() }),
    e => e.code === "failed" && e.module === "learning" && !e.state);
});

test("a tool vyred does not have goes to api.js's fallback (fixtures)", async () => {
  const f = async () => ({ status: 404, statusText: "", json: async () => ({ error: { code: "no_such_tool", message: "no tool" } }) });
  const r = await withPresence("learn.accept", { id: 1 }, { fetch: /** @type {any} */ (f), sheet: sheet(), fallback: async (t, i) => ({ t, i }) });
  assert.deepEqual(r, { t: "learn.accept", i: { id: 1 } });
});

test("isExpired reads vyred's two wordings", () => {
  assert.ok(isExpired("no such passkey challenge, or it expired"));
  assert.ok(!isExpired("that passkey is not enrolled"));
});

// ---- the words ---------------------------------------------------------------------------------

test("summaries: verb, the lesson in its words, level, where", () => {
  const l = { rule: "Never push to main without a review", level: "block", scope: "all" };
  assert.equal(lessonSummary("Accept", l), "Accept lesson “Never push to main without a review” · block · everywhere");
  assert.equal(lessonSummary("Relax", l, new Map(), "ask"), "Relax lesson “Never push to main without a review” · block to ask · everywhere");
  assert.equal(lessonSummary("Retire", { ...l, scope: { project: "harlow" } }, new Map([["harlow", "Harlow Legal"]])), "Retire lesson “Never push to main without a review” · block · only in Harlow Legal");
  assert.ok(lessonSummary("Accept", { ...l, rule: "x".repeat(300) }).length < 140);
  assert.equal(skillSummary("Install", { id: 2, name: "release-notes", steps: [1, 2, 3, 4] }), "Install skill release-notes · 4 steps");
  assert.equal(correctSummary("Dana Reyes works at Harlow Legal", "replace", "Northwind"), "Correct “Dana Reyes works at Harlow Legal” to Northwind · everywhere");
  assert.equal(correctSummary("Dana Reyes works at Harlow Legal", "ended", null, "harlow"), "Mark “Dana Reyes works at Harlow Legal” no longer true · only in harlow");
  assert.equal(presenceCommand("learn.accept", 7), "vyre learn accept 7");
  assert.equal(presenceCommand("memory.correct", 7), "vyre call memory.correct");
});
