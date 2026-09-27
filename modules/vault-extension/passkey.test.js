// @ts-check
// passkey tests: passkey-page.js (the page's world) and passkey-bridge.js (the isolated prompt)
// run in a vm with a fake window and a fake DOM; background.js runs in a vm with a fake `chrome`
// against a real fill listener over a real Vault in a temp folder. No browser runs. They check
// the page script's bytes both ways, what it leaves to the browser, abort and errors; that the
// worker signs for the sender's origin and refuses the popup; that the bridge acts only on
// trusted clicks; and one create and sign-in end to end, verified as a relying party would.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { open, migrate } from "../../core/store/index.js";
import { Vault, MIGRATIONS } from "../../core/vault/vault.js";
import { Fill, serveFill } from "../../core/vault/fill.js";
import { createCredential, getAssertion } from "../../core/vault/webauthn.js";
import { SCRATCH } from "../../test/scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_JS = fs.readFileSync(path.join(HERE, "passkey-page.js"), "utf8");
const BRIDGE_JS = fs.readFileSync(path.join(HERE, "passkey-bridge.js"), "utf8");
const ID = "abcdefghijklmnopabcdefghijklmnop";
const b64u = (/** @type {any} */ b) => Buffer.from(b instanceof ArrayBuffer || ArrayBuffer.isView(b) ? new Uint8Array(/** @type {any} */ (b).buffer ?? b, b.byteOffset ?? 0, b.byteLength) : b).toString("base64url");
const isBuffer = (/** @type {any} */ x) => Object.prototype.toString.call(x) === "[object ArrayBuffer]";
const bytesOf = (/** @type {any} */ x) => Buffer.from(new Uint8Array(x));

/** Wait until `pred()` is truthy (polling), or fail. */
async function until(pred, what = "condition", ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

// ---- a fake page: window, credentials, a little DOM ---------------------------------------

class El {
  /** @param {string} tag */
  constructor(tag) { this.tag = tag; /** @type {El[]} */ this.children = []; /** @type {Record<string, Function[]>} */ this.listeners = {}; this.style = {}; this.textContent = ""; this.className = ""; this.connected = false; }
  get isConnected() { return this.connected; }
  attachShadow(/** @type {any} */ o) { assert.equal(o.mode, "closed"); this.shadow = new El("#shadow"); return this.shadow; }
  append(/** @type {El[]} */ ...c) { this.children.push(...c); }
  replaceChildren(/** @type {El[]} */ ...c) { this.children = [...c]; }
  remove() { this.connected = false; }
  addEventListener(/** @type {string} */ t, /** @type {Function} */ fn) { (this.listeners[t] ||= []).push(fn); }
  /** All elements below, depth first. @returns {El[]} */
  all() { return this.children.flatMap(c => [c, ...c.all()]); }
  /** @param {boolean} isTrusted */
  click(isTrusted) { for (const fn of this.listeners.click || []) fn({ isTrusted, preventDefault() {}, stopPropagation() {} }); }
}

/**
 * @param {{ origin?: string, framed?: boolean, policy?: any, chrome?: any, page?: boolean, bridge?: boolean }} [o]
 */
function world({ origin = "https://harlow.test", framed = false, policy, chrome, page = true, bridge = false } = {}) {
  /** @type {Function[]} */
  const listeners = [];
  /** @type {any[]} */
  const posted = [];
  /** @type {any[][]} */
  const browserCalls = [];
  const illegal = () => { throw new TypeError("Illegal invocation"); };
  class CredentialsContainer {
    create(/** @type {any} */ o) { browserCalls.push(["create", this, o]); return Promise.resolve("the browser's own create"); }
    get(/** @type {any} */ o) { browserCalls.push(["get", this, o]); return Promise.resolve("the browser's own get"); }
  }
  // Native getters that throw on anything the browser did not make, as the real ones do.
  class PublicKeyCredential { get id() { return illegal(); } get rawId() { return illegal(); } get response() { return illegal(); } }
  class AuthenticatorResponse { get clientDataJSON() { return illegal(); } }
  class AuthenticatorAttestationResponse extends AuthenticatorResponse { get attestationObject() { return illegal(); } }
  class AuthenticatorAssertionResponse extends AuthenticatorResponse { get signature() { return illegal(); } }
  const hosts = /** @type {El[]} */ ([]);
  const docListeners = /** @type {Record<string, Function[]>} */ ({});
  const document = {
    createElement: (/** @type {string} */ t) => { const e = new El(t); if (t.startsWith("vyre-")) hosts.push(e); return e; },
    documentElement: { append: (/** @type {El} */ e) => { e.connected = true; } },
    addEventListener: (/** @type {string} */ t, /** @type {Function} */ fn) => { (docListeners[t] ||= []).push(fn); },
    ...(policy ? { permissionsPolicy: policy } : {}),
  };
  /** @type {any} */
  const win = {
    navigator: { credentials: new CredentialsContainer() },
    CredentialsContainer, PublicKeyCredential, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse,
    isSecureContext: true, document, location: { origin, hostname: new URL(origin).hostname },
    crypto: globalThis.crypto, btoa, atob, DOMException, setTimeout, clearTimeout, console,
    ...(chrome ? { chrome } : {}),
    addEventListener: (/** @type {string} */ t, /** @type {Function} */ fn) => { if (t === "message") listeners.push(fn); },
    postMessage: (/** @type {any} */ data) => {
      const copy = structuredClone(data);
      posted.push(copy);
      setTimeout(() => { for (const l of [...listeners]) l({ data: copy, source: self, origin }); }, 0);
    },
  };
  win.window = win;
  vm.createContext(win);
  // Inside the context `window` is the context's global, not the sandbox object: that is the
  // window a message's source must be.
  const self = vm.runInContext("globalThis", win);
  win.window = self;
  win.top = framed ? { other: true } : self;
  if (page) vm.runInContext(PAGE_JS, win);
  if (bridge) vm.runInContext(BRIDGE_JS, win);

  /** A stand-in bridge for page-script tests: acknowledge, then answer with `fn(request)`. */
  const answer = (/** @type {(d: any) => any} */ fn) => listeners.push((/** @type {any} */ e) => {
    const d = e.data;
    if (!d || d.vyre !== "passkey" || d.kind === "cancel") return;
    win.postMessage({ vyre: "passkey-reply", channel: d.channel, id: d.id, ack: true });
    Promise.resolve(fn(d)).then(reply => { if (reply) win.postMessage({ vyre: "passkey-reply", channel: d.channel, id: d.id, reply }); });
  });
  /** The prompt the bridge drew, if it is showing. */
  const prompt = () => {
    const h = hosts.find(x => x.isConnected);
    return h && h.shadow ? h.shadow : null;
  };
  const text = () => { const p = prompt(); return p ? p.all().filter(e => e.tag !== "style").map(e => e.textContent).filter(Boolean).join(" | ") : ""; };
  const buttonNamed = (/** @type {string} */ t) => { const p = prompt(); const b = p && p.all().find(e => e.tag === "button" && e.textContent === t); if (!b) throw new Error(`no button ${t} in: ${text()}`); return b; };
  const keydown = (/** @type {any} */ ev) => { for (const fn of docListeners.keydown || []) fn(ev); };
  return { win, global: self, posted, browserCalls, answer, prompt, text, buttonNamed, keydown, dispatch: (/** @type {any} */ data, source = self) => { for (const l of [...listeners]) l({ data, source, origin }); } };
}

/** Creation options as a site builds them, with every byte field in a different BufferSource shape. */
function creationOptions() {
  const challenge = crypto.randomBytes(32);
  const padded = new Uint8Array(40);
  padded.set(challenge, 4);
  const userId = crypto.randomBytes(16);
  const excluded = crypto.randomBytes(16);
  return {
    challenge, userId, excluded,
    options: {
      publicKey: {
        rp: { id: "harlow.test", name: "Harlow" },
        user: { id: userId.buffer.slice(userId.byteOffset, userId.byteOffset + 16), name: "alex@harlow.test", displayName: "Alex" },
        challenge: padded.subarray(4, 36),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        excludeCredentials: [{ type: "public-key", id: new DataView(excluded.buffer, excluded.byteOffset, 16), transports: ["internal"] }],
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        timeout: 60000,
      },
    },
  };
}

// ---- passkey-page.js ----------------------------------------------------------------------

test("page script: creation options go out as base64url and the answer comes back as ArrayBuffers on the page's own prototypes", async () => {
  const w = world();
  const { options, challenge, userId, excluded } = creationOptions();
  /** @type {any} */
  let seen = null, made = null;
  w.answer(d => {
    seen = d;
    made = createCredential({ rpId: "harlow.test", origin: "https://harlow.test", challenge: d.options.challenge, user: d.options.user, algs: [-7] });
    return { data: { name: "harlow-test-alex-harlow-test", response: made.response } };
  });
  const cred = await w.win.navigator.credentials.create(options);
  assert.equal(seen.kind, "create");
  assert.match(seen.channel, /^vyre-[0-9a-f]{32}$/);
  assert.equal(seen.options.challenge, challenge.toString("base64url"), "a subarray view: only its own bytes");
  assert.equal(seen.options.user.id, userId.toString("base64url"));
  assert.deepEqual(seen.options.excludeCredentials, [{ type: "public-key", id: excluded.toString("base64url"), transports: ["internal"] }]);
  assert.deepEqual(seen.options.pubKeyCredParams.map((/** @type {any} */ p) => p.alg), [-7, -257]);
  assert.equal(seen.options.rp.id, "harlow.test");

  assert.ok(cred instanceof w.win.PublicKeyCredential, "instanceof PublicKeyCredential passes");
  assert.ok(cred.response instanceof w.win.AuthenticatorAttestationResponse);
  assert.equal(cred.id, made.response.id);
  assert.equal(cred.type, "public-key");
  assert.equal(cred.authenticatorAttachment, "platform");
  for (const k of ["rawId"]) assert.ok(isBuffer(cred[k]), k);
  for (const k of ["clientDataJSON", "attestationObject", "authenticatorData"]) assert.ok(isBuffer(cred.response[k]), k);
  assert.equal(b64u(bytesOf(cred.rawId)), made.response.id);
  const cd = JSON.parse(bytesOf(cred.response.clientDataJSON).toString("utf8"));
  assert.deepEqual([cd.type, cd.challenge, cd.origin], ["webauthn.create", challenge.toString("base64url"), "https://harlow.test"]);
  assert.deepEqual(bytesOf(cred.response.getPublicKey()), Buffer.from(made.response.response.publicKey, "base64url"));
  assert.equal(cred.response.getPublicKeyAlgorithm(), -7);
  assert.deepEqual([...cred.response.getTransports()], ["internal", "hybrid"]);
  assert.deepEqual(bytesOf(cred.response.getAuthenticatorData()), Buffer.from(made.response.response.authenticatorData, "base64url"));
  assert.deepEqual(JSON.parse(JSON.stringify(cred.getClientExtensionResults())), { credProps: { rk: true } });
  // toJSON gives the WebAuthn JSON form: every byte field base64url, as vyred sent it.
  assert.deepEqual(JSON.parse(JSON.stringify(cred)), JSON.parse(JSON.stringify({ ...made.response, rawId: made.response.id })));
});

test("page script: a sign-in round-trips, with userHandle and signature as ArrayBuffers", async () => {
  const w = world();
  const user = { id: crypto.randomBytes(16).toString("base64url"), name: "juno@harlow.test", displayName: "Juno" };
  const made = createCredential({ rpId: "harlow.test", origin: "https://harlow.test", challenge: crypto.randomBytes(32).toString("base64url"), user, algs: [-7] });
  const challenge = crypto.randomBytes(32);
  /** @type {any} */
  let seen = null, signed = null;
  w.answer(d => {
    seen = d;
    signed = getAssertion({ credential: { ...made.credential, rpId: "harlow.test" }, origin: "https://harlow.test", challenge: d.options.challenge });
    return { data: { response: signed.response } };
  });
  const cred = await w.win.navigator.credentials.get({ publicKey: { challenge, rpId: "harlow.test", allowCredentials: [{ type: "public-key", id: Buffer.from(made.credential.id, "base64url") }], userVerification: "required" } });
  assert.equal(seen.kind, "get");
  assert.equal(seen.options.challenge, challenge.toString("base64url"));
  assert.deepEqual(seen.options.allowCredentials.map((/** @type {any} */ c) => c.id), [made.credential.id]);
  assert.ok(cred instanceof w.win.PublicKeyCredential);
  assert.ok(cred.response instanceof w.win.AuthenticatorAssertionResponse);
  for (const k of ["clientDataJSON", "authenticatorData", "signature", "userHandle"]) assert.ok(isBuffer(cred.response[k]), k);
  assert.equal(b64u(bytesOf(cred.response.userHandle)), user.id);
  const json = JSON.parse(JSON.stringify(cred));
  assert.deepEqual(json.response, signed.response.response);
  assert.equal(json.rawId, made.credential.id);
});

test("page script: anything but a modal publicKey request goes to the browser's own function untouched", async () => {
  const w = world();
  w.answer(() => assert.fail("the bridge must not be asked"));
  const creds = w.win.navigator.credentials;
  const pw = { password: { id: "alex", password: "x" } };
  const otp = { otp: { transport: ["sms"] } };
  const conditional = { mediation: "conditional", publicKey: { challenge: new Uint8Array(32) } };
  const securityKey = { publicKey: { ...creationOptions().options.publicKey, authenticatorSelection: { authenticatorAttachment: "cross-platform" } } };
  const rsaOnly = { publicKey: { ...creationOptions().options.publicKey, pubKeyCredParams: [{ type: "public-key", alg: -257 }] } };
  const broken = { publicKey: { rpId: "harlow.test" } }; // no challenge: the browser gives its own TypeError
  assert.equal(await creds.create(pw), "the browser's own create");
  assert.equal(await creds.get(otp), "the browser's own get");
  assert.equal(await creds.get(conditional), "the browser's own get");
  assert.equal(await creds.get(), "the browser's own get");
  assert.equal(await creds.create(securityKey), "the browser's own create");
  assert.equal(await creds.create(rsaOnly), "the browser's own create");
  assert.equal(await creds.get(broken), "the browser's own get");
  assert.deepEqual(w.browserCalls.map(c => c[2]), [pw, otp, conditional, undefined, securityKey, rsaOnly, broken], "the same objects, not copies");
  assert.ok(w.browserCalls.every(c => c[1] === creds), "called on navigator.credentials");
  assert.equal(w.posted.length, 0);
});

test("page script: { fallback } calls the browser's own function with the original options object and its signal", async () => {
  const w = world();
  w.answer(() => ({ fallback: true }));
  const ac = new AbortController();
  const { options } = creationOptions();
  const o = { ...options, signal: ac.signal };
  assert.equal(await w.win.navigator.credentials.create(o), "the browser's own create");
  assert.equal(w.browserCalls.length, 1);
  assert.equal(w.browserCalls[0][2], o, "the very object the page passed");
  assert.equal(w.browserCalls[0][2].signal, ac.signal);
});

test("page script: abort rejects with AbortError and tells the bridge to stop", async () => {
  const w = world();
  w.answer(() => new Promise(() => {})); // the person has not clicked yet
  const ac = new AbortController();
  const p = w.win.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) }, signal: ac.signal });
  await until(() => w.posted.some(m => m.ack), "the bridge's acknowledgement");
  ac.abort();
  await assert.rejects(p, (/** @type {any} */ e) => e instanceof DOMException && e.name === "AbortError");
  await until(() => w.posted.some(m => m.kind === "cancel"), "a cancel to the bridge");
  const req = w.posted.find(m => m.kind === "get");
  assert.equal(w.posted.find(m => m.kind === "cancel").id, req.id);

  const done = new AbortController();
  done.abort();
  const before = w.posted.length;
  await assert.rejects(w.win.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) }, signal: done.signal }), { name: "AbortError" });
  assert.equal(w.posted.length, before, "an already-aborted request never reaches the bridge");
  assert.equal(w.browserCalls.length, 0);
});

test("page script: vyred's errors become the DOMExceptions a browser throws", async () => {
  const cases = [
    ["InvalidStateError", "InvalidStateError"], ["SecurityError", "SecurityError"], ["NotAllowedError", "NotAllowedError"],
    ["NotSupportedError", "NotSupportedError"], ["session_expired", "NotAllowedError"], ["vault_locked", "NotAllowedError"],
  ];
  for (const [code, name] of cases) {
    const w = world();
    w.answer(() => ({ error: { code, message: `vyred said ${code}` } }));
    await assert.rejects(w.win.navigator.credentials.create(creationOptions().options),
      (/** @type {any} */ e) => e instanceof DOMException && e.name === name && e.message === `vyred said ${code}`, code);
  }
  const w = world();
  w.answer(() => ({ error: { code: "TypeError", message: "challenge is not base64url" } }));
  // The page's own TypeError (the vm's realm here), as the browser would throw.
  await assert.rejects(w.win.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } }),
    (/** @type {any} */ e) => e instanceof w.global.TypeError && !(e instanceof DOMException) && e.message === "challenge is not base64url");
});

test("page script: no bridge in the frame, or a frame the parent did not allow: the browser answers", async () => {
  const w = world();
  const t0 = Date.now();
  assert.equal(await w.win.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } }), "the browser's own get");
  assert.ok(Date.now() - t0 >= 900, "after the acknowledgement wait");

  const framed = world({ framed: true }); // Firefox: no permissions policy to read
  framed.answer(() => assert.fail("not asked"));
  assert.equal(await framed.win.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } }), "the browser's own get");
  const denied = world({ framed: true, policy: { allowsFeature: () => false } });
  assert.equal(await denied.win.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } }), "the browser's own get");
  const allowed = world({ framed: true, policy: { allowsFeature: (/** @type {string} */ f) => f === "publickey-credentials-get" } });
  allowed.answer(() => ({ fallback: true }));
  await allowed.win.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } });
  assert.ok(allowed.posted.some(m => m.kind === "get"), "an allowed frame asks Vyre");
});

// ---- passkey-bridge.js --------------------------------------------------------------------

/** A fake chrome.runtime for the bridge: `handler(msg)` answers each sendMessage. */
function bridgeChrome(/** @type {(msg: any) => any} */ handler) {
  /** @type {any[]} */
  const sent = [];
  return { sent, chrome: { runtime: { lastError: undefined, sendMessage: (/** @type {any} */ msg, /** @type {Function} */ cb) => { sent.push(JSON.parse(JSON.stringify(msg))); Promise.resolve(handler(msg)).then(r => cb(r)); } } } };
}

const request = (/** @type {any} */ w, /** @type {string} */ kind, /** @type {any} */ options, id = 1) =>
  w.dispatch({ vyre: "passkey", channel: "vyre-test", id, kind, options });
const replyFor = (/** @type {any} */ w, id = 1) => w.posted.find((/** @type {any} */ m) => m.vyre === "passkey-reply" && m.id === id && m.reply);

test("bridge: a save happens only on a trusted click; a synthetic click does nothing", async () => {
  const c = bridgeChrome(msg => (msg.type === "passkey-create" ? { data: { name: "harlow-test-alex", response: { id: "abc" } } } : null));
  const w = world({ page: false, bridge: true, chrome: c.chrome });
  request(w, "create", { rp: { id: "harlow.test" }, user: { name: "alex@harlow.test" }, challenge: "Y2hhbGxlbmdl" });
  await until(() => w.prompt(), "the prompt");
  assert.match(w.text(), /^Save a passkey for harlow\.test in Vyre\? \| alex@harlow\.test \| Continue/);
  assert.ok(w.posted.some(m => m.ack && m.id === 1), "acknowledged at once");

  w.buttonNamed("Continue").click(false);
  w.buttonNamed("Use another device").click(false);
  w.buttonNamed("Cancel").click(false);
  w.keydown({ isTrusted: false, key: "Escape" });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(c.sent.length, 0, "nothing reached the worker");
  assert.equal(replyFor(w), undefined, "nothing reached the page");

  w.buttonNamed("Continue").click(true);
  await until(() => replyFor(w), "the reply");
  assert.deepEqual(c.sent, [{ type: "passkey-create", options: { rp: { id: "harlow.test" }, user: { name: "alex@harlow.test" }, challenge: "Y2hhbGxlbmdl" } }]);
  assert.deepEqual(replyFor(w).reply, { data: { name: "harlow-test-alex", response: { id: "abc" } } });
  assert.equal(w.prompt(), null, "the prompt is gone");
});

test("bridge: a sign-in with no Vyre passkey falls back without a prompt; one passkey names the account", async () => {
  const none = bridgeChrome(() => ({ data: { passkeys: [] } }));
  const w = world({ page: false, bridge: true, chrome: none.chrome });
  request(w, "get", { challenge: "Y2hhbGxlbmdl", rpId: "harlow.test" });
  await until(() => replyFor(w), "the reply");
  assert.deepEqual(replyFor(w).reply, { fallback: true });
  assert.equal(w.prompt(), null);
  assert.deepEqual(none.sent.map(m => m.type), ["passkey-list"]);

  const one = bridgeChrome(msg => (msg.type === "passkey-list"
    ? { data: { passkeys: [{ id: "k1", name: "harlow-test-alex-harlow-test", description: "alex@harlow.test · harlow.test" }] } }
    : { data: { response: { id: "k1" } } }));
  const w2 = world({ page: false, bridge: true, chrome: one.chrome });
  request(w2, "get", { challenge: "Y2hhbGxlbmdl", rpId: "harlow.test" });
  await until(() => w2.prompt(), "the prompt");
  assert.match(w2.text(), /^Sign in to harlow\.test as alex@harlow\.test with Vyre\?/);
  w2.buttonNamed("Continue").click(true);
  await until(() => replyFor(w2), "the reply");
  assert.deepEqual(one.sent[1], { type: "passkey-get", options: { challenge: "Y2hhbGxlbmdl", rpId: "harlow.test" }, id: "k1" });
});

test("bridge: several accounts are a picker; locked asks to unlock; another device and Cancel answer the page", async () => {
  let locked = true;
  const c = bridgeChrome(msg => {
    if (msg.type === "passkey-list") return { data: { passkeys: [
      { id: "k1", name: "a", description: "alex@harlow.test · harlow.test" }, { id: "k2", name: "j", description: "juno@harlow.test · harlow.test" }] } };
    if (locked) return { error: { code: "session_required", message: "unlock first" } };
    return { data: { response: { id: msg.id } } };
  });
  const w = world({ page: false, bridge: true, chrome: c.chrome });
  request(w, "get", { challenge: "Y2hhbGxlbmdl" });
  await until(() => w.prompt(), "the picker");
  assert.match(w.text(), /Sign in to harlow\.test with Vyre \| Choose an account\. \| alex@harlow\.test \| juno@harlow\.test/);
  w.buttonNamed("juno@harlow.test").click(true);
  await until(() => /Vyre is locked/.test(w.text()), "the locked prompt");
  assert.match(w.text(), /toolbar/);
  locked = false;
  w.buttonNamed("Try again").click(true);
  await until(() => replyFor(w), "the reply");
  assert.deepEqual(replyFor(w).reply, { data: { response: { id: "k2" } } });

  // A second request while one is up is refused; then Use another device and Cancel.
  const c2 = bridgeChrome(() => null);
  const w2 = world({ page: false, bridge: true, chrome: c2.chrome });
  request(w2, "create", { rp: { id: "harlow.test" }, user: { name: "alex@harlow.test" } }, 1);
  await until(() => w2.prompt(), "the prompt");
  request(w2, "create", { rp: { id: "harlow.test" } }, 2);
  await until(() => replyFor(w2, 2), "the refusal");
  assert.equal(replyFor(w2, 2).reply.error.code, "NotAllowedError");
  w2.buttonNamed("Use another device").click(true);
  await until(() => replyFor(w2, 1), "the fallback");
  assert.deepEqual(replyFor(w2, 1).reply, { fallback: true });

  request(w2, "create", { rp: { id: "harlow.test" } }, 3);
  await until(() => w2.prompt(), "the prompt again");
  w2.buttonNamed("Cancel").click(true);
  await until(() => replyFor(w2, 3), "the cancel");
  assert.equal(replyFor(w2, 3).reply.error.code, "NotAllowedError");
  assert.equal(c2.sent.length, 0, "neither way out asks the worker");

  // A message from another window (a frame posting to this one) is not a request.
  request(w2, "create", {}, 4);
  w2.dispatch({ vyre: "passkey", channel: "vyre-test", id: 5, kind: "create", options: {} }, /** @type {any} */ ({}));
  await until(() => w2.prompt(), "the prompt for 4");
  await new Promise(r => setTimeout(r, 20));
  assert.equal(w2.posted.filter(m => m.id === 5).length, 0);
});

// ---- background.js ------------------------------------------------------------------------

/**
 * background.js in a vm against a real fill listener, paired and unlocked unless told otherwise.
 * @param {any} t @param {{ paired?: boolean, unlocked?: boolean, pages?: boolean, browserInfo?: any, url?: string }} [o]
 */
async function background(t, { paired = true, unlocked = true, pages = true, browserInfo, url } = {}) {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-ext-pk-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  await vault.key();
  const fill = new Fill({ vault });
  const srv = await serveFill({ host: "127.0.0.1", port: 0, fill });
  t.after(async () => { await srv.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const post = async (route, body, headers = {}) => (await fetch(`${srv.url}/v1/fill/${route}`, { method: "POST", headers: { "content-type": "application/json", origin: `chrome-extension://${ID}`, ...headers }, body: JSON.stringify(body) })).json();
  /** @type {any} */
  const local = { url: url || srv.url };
  /** @type {any} */
  const sess = {};
  if (paired) {
    const p = (await post("pair", { code: fill.code({ name: "vm browser" }).code })).data;
    Object.assign(local, { device: p.device, token: p.token, deviceName: p.name });
    if (unlocked) {
      await fill.setUnlockPassphrase({ passphrase: "a long unlock passphrase" });
      const s = (await post("unlock", { passphrase: "a long unlock passphrase" }, { authorization: `Bearer ${p.token}` })).data;
      Object.assign(sess, { session: s.session, expires: s.expires });
    }
  }
  /** @type {any[]} */
  const registered = [];
  let listener = /** @type {any} */ (null);
  const store = (/** @type {any} */ obj) => ({
    get: async (/** @type {string[]} */ keys) => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]])),
    set: async (/** @type {any} */ v) => { Object.assign(obj, v); }, remove: async (/** @type {string[]} */ keys) => { for (const k of keys) delete obj[k]; },
    setAccessLevel: () => {},
  });
  const chrome = {
    runtime: { id: ID, getURL: (/** @type {string} */ p) => `chrome-extension://${ID}/${p}`, onMessage: { addListener: (/** @type {any} */ fn) => { listener = fn; } },
      ...(browserInfo ? { getBrowserInfo: async () => browserInfo } : {}) },
    storage: { local: store(local), session: store(sess) },
    tabs: { query: async () => [], onRemoved: { addListener: () => {} }, sendMessage: async () => {} },
    commands: { onCommand: { addListener: () => {} } },
    scripting: {
      executeScript: async () => [],
      getRegisteredContentScripts: async (/** @type {any} */ f) => registered.filter(s => !f || !f.ids || f.ids.includes(s.id)),
      registerContentScripts: async (/** @type {any[]} */ list) => {
        for (const s of list) if (registered.some(r => r.id === s.id)) throw new Error(`duplicate ${s.id}`);
        registered.push(...JSON.parse(JSON.stringify(list)));
      },
      unregisterContentScripts: async (/** @type {any} */ f) => { for (const id of f.ids) { const i = registered.findIndex(r => r.id === id); if (i < 0) throw new Error(`no ${id}`); registered.splice(i, 1); } },
    },
    permissions: { contains: async () => pages },
  };
  vm.runInNewContext(fs.readFileSync(path.join(HERE, "background.js"), "utf8"), { chrome, fetch, URL, Date, console, setTimeout });
  const send = (/** @type {any} */ msg, /** @type {any} */ sender) => new Promise(resolve => { listener(msg, sender, (/** @type {any} */ r) => resolve(JSON.parse(JSON.stringify(r)))); });
  /** A sender for a frame of a tab: `url` is the frame's page, `top` the tab's. */
  const frame = (/** @type {string} */ u, frameId = 0, top = u) => ({ id: ID, tab: { id: 7, url: top }, frameId, origin: new URL(u).origin, url: u });
  const popup = { id: ID, url: `chrome-extension://${ID}/popup.html` };
  return { vault, send, frame, popup, registered, local, db };
}

/** What a site sends for a new passkey, as the bridge relays it (already JSON). */
const createJSON = (/** @type {string} */ name) => ({
  rp: { id: "harlow.test", name: "Harlow" }, challenge: crypto.randomBytes(32).toString("base64url"),
  user: { id: crypto.randomBytes(16).toString("base64url"), name, displayName: name.split("@")[0] },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [],
});
const clientData = (/** @type {any} */ r) => JSON.parse(Buffer.from(r.response.clientDataJSON, "base64url").toString("utf8"));

test("background: a passkey is made for the SENDER's origin, whatever the message claims", async t => {
  const { vault, send, frame } = await background(t);
  const opts = { ...createJSON("alex@harlow.test"), origin: "https://northwind.test" };
  const r = await send({ type: "passkey-create", options: opts, url: "https://northwind.test", origin: "https://northwind.test" }, frame("https://harlow.test/signup"));
  assert.ok(r.data, JSON.stringify(r));
  const cd = clientData(r.data.response);
  assert.equal(cd.origin, "https://harlow.test", "the browser's word for the page");
  assert.equal(cd.crossOrigin, false);
  const row = vault.row(r.data.name);
  assert.deepEqual(JSON.parse(row.hosts), ["https://harlow.test"]);

  // A page on another site claiming harlow.test as its rpId gets the browser's SecurityError.
  const evil = await send({ type: "passkey-get", options: { challenge: crypto.randomBytes(32).toString("base64url"), rpId: "harlow.test" }, url: "https://harlow.test" }, frame("https://harlow-test.northwind.test/"));
  assert.equal(evil.error.code, "SecurityError");
  const evilCreate = await send({ type: "passkey-create", options: createJSON("juno@harlow.test") }, frame("https://northwind.test/"));
  assert.equal(evilCreate.error.code, "SecurityError");
  // The list for that lookalike is empty: nothing to show, the browser answers.
  assert.deepEqual((await send({ type: "passkey-list", options: { rpId: "harlow.test" } }, frame("https://harlow-test.northwind.test/"))).data.passkeys, []);
});

test("background: list, choose and sign in; a framed request says so with the tab's top origin", async t => {
  const { send, frame } = await background(t);
  const a = await send({ type: "passkey-create", options: createJSON("alex@harlow.test") }, frame("https://harlow.test/"));
  const j = await send({ type: "passkey-create", options: createJSON("juno@harlow.test") }, frame("https://harlow.test/"));
  const listed = await send({ type: "passkey-list", options: { rpId: "harlow.test" } }, frame("https://harlow.test/login"));
  assert.deepEqual(listed.data.passkeys.map((/** @type {any} */ p) => p.description).sort(), ["alex@harlow.test · harlow.test", "juno@harlow.test · harlow.test"]);
  const only = await send({ type: "passkey-list", options: { rpId: "harlow.test", allowCredentials: [{ type: "public-key", id: j.data.response.id }] } }, frame("https://harlow.test/login"));
  assert.deepEqual(only.data.passkeys.map((/** @type {any} */ p) => p.id), [j.data.response.id], "allowCredentials narrows the list");

  const ch = crypto.randomBytes(32).toString("base64url");
  const choose = await send({ type: "passkey-get", options: { challenge: ch, rpId: "harlow.test" } }, frame("https://harlow.test/login"));
  assert.equal(choose.data.choose.length, 2);
  const got = await send({ type: "passkey-get", options: { challenge: ch, rpId: "harlow.test" }, id: a.data.response.id }, frame("https://harlow.test/login"));
  assert.equal(got.data.response.id, a.data.response.id);
  assert.deepEqual([clientData(got.data.response).origin, clientData(got.data.response).challenge], ["https://harlow.test", ch]);

  // In a frame of another site: crossOrigin, topOrigin from the tab. In a same-site frame: not cross-origin.
  const framed = await send({ type: "passkey-get", options: { challenge: ch, rpId: "harlow.test" }, id: a.data.response.id }, frame("https://harlow.test/widget", 4, "https://northwind.test/checkout"));
  assert.deepEqual([clientData(framed.data.response).crossOrigin, clientData(framed.data.response).topOrigin], [true, "https://northwind.test"]);
  const same = await send({ type: "passkey-get", options: { challenge: ch, rpId: "harlow.test" }, id: a.data.response.id }, frame("https://harlow.test/widget", 4, "https://harlow.test/"));
  assert.equal(clientData(same.data.response).crossOrigin, false);
});

test("background: passkey requests from the popup, another extension or no tab are refused", async t => {
  const { send, frame, popup } = await background(t);
  for (const type of ["passkey-list", "passkey-create", "passkey-get"]) {
    const msg = { type, options: createJSON("alex@harlow.test") };
    assert.equal((await send(msg, popup)).error.code, "refused", `${type} from the popup`);
    assert.equal((await send(msg, { ...frame("https://harlow.test/"), id: "another-extension" })).error.code, "refused", `${type} from another extension`);
    assert.equal((await send(msg, { id: ID, url: "https://harlow.test/" })).error.code, "refused", `${type} with no tab`);
    assert.equal((await send(msg, { ...frame("https://harlow.test/"), origin: "null", url: "about:blank" })).error.code, "refused", `${type} from an opaque frame`);
  }
});

test("background: not paired, unreachable or locked", async t => {
  const unpaired = await background(t, { paired: false });
  assert.deepEqual(await unpaired.send({ type: "passkey-create", options: createJSON("alex@harlow.test") }, unpaired.frame("https://harlow.test/")), { fallback: true });
  assert.deepEqual(await unpaired.send({ type: "passkey-list", options: {} }, unpaired.frame("https://harlow.test/")), { fallback: true });

  const down = await background(t, { url: "http://127.0.0.1:9" });
  down.local.token = "tok";
  assert.deepEqual(await down.send({ type: "passkey-get", options: { challenge: crypto.randomBytes(32).toString("base64url") } }, down.frame("https://harlow.test/")), { fallback: true });

  const locked = await background(t, { unlocked: false });
  const r = await locked.send({ type: "passkey-create", options: createJSON("alex@harlow.test") }, locked.frame("https://harlow.test/"));
  assert.equal(r.error.code, "session_required", "the bridge shows the unlock prompt for this one");
});

test("background: the passkey scripts follow pairing, page access and the popup toggle", async t => {
  const b = await background(t);
  const st = await b.send({ type: "passkeys-state" }, b.popup);
  assert.deepEqual(st.data, { passkeys: true, wanted: true, supported: true }, "on by default once paired and allowed on pages");
  const page = b.registered.find(s => s.id === "vyre-passkey-page");
  const bridge = b.registered.find(s => s.id === "vyre-passkey-bridge");
  assert.deepEqual([page.world, page.runAt, page.allFrames, page.matchOriginAsFallback, page.js], ["MAIN", "document_start", true, false, ["passkey-page.js"]]);
  assert.deepEqual([bridge.world, bridge.runAt, bridge.allFrames, bridge.js], [undefined, "document_start", true, ["passkey-bridge.js"]]);
  assert.deepEqual(page.matches, ["https://*/*", "http://*/*"]);

  assert.deepEqual((await b.send({ type: "passkeys-disable" }, b.popup)).data.passkeys, false);
  assert.equal(b.registered.length, 0);
  assert.equal(b.local.passkeys, false);
  assert.deepEqual(await b.send({ type: "passkey-list", options: {} }, b.frame("https://harlow.test/")), { fallback: true }, "off: pages that have not reloaded get the browser's own");
  assert.equal((await b.send({ type: "passkeys-enable" }, b.popup)).data.passkeys, true);
  assert.equal(b.registered.length, 2);
  await b.send({ type: "forget" }, b.popup);
  assert.equal(b.registered.length, 0, "unpaired: gone");

  const noPages = await background(t, { pages: false });
  assert.equal((await noPages.send({ type: "passkeys-state" }, noPages.popup)).data.passkeys, false);
  assert.equal((await noPages.send({ type: "passkeys-enable" }, noPages.popup)).error.code, "no_permission");
  assert.equal(noPages.registered.length, 0);

  const oldFirefox = await background(t, { browserInfo: { name: "Firefox", version: "127.0" } });
  assert.deepEqual((await oldFirefox.send({ type: "passkeys-state" }, oldFirefox.popup)).data, { passkeys: false, wanted: true, supported: false });
  assert.equal((await oldFirefox.send({ type: "passkeys-enable" }, oldFirefox.popup)).error.code, "unsupported");
  const firefox = await background(t, { browserInfo: { name: "Firefox", version: "128.0" } });
  assert.equal((await firefox.send({ type: "passkeys-state" }, firefox.popup)).data.passkeys, true);
});

// ---- end to end ---------------------------------------------------------------------------

test("end to end: a site makes a passkey and signs in with it through page script, bridge, worker and vyred", async t => {
  const b = await background(t);
  const sender = b.frame("https://harlow.test/account");
  const relay = { runtime: { lastError: undefined, sendMessage: (/** @type {any} */ msg, /** @type {Function} */ cb) => { b.send(JSON.parse(JSON.stringify(msg)), sender).then(r => cb(r)); } } };
  const w = world({ bridge: true, chrome: relay });

  const { options } = creationOptions();
  options.publicKey.excludeCredentials = [];
  const made = w.win.navigator.credentials.create(options);
  await until(() => w.prompt(), "the save prompt");
  w.buttonNamed("Continue").click(false);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(b.db.prepare("SELECT count(*) AS n FROM vault_items WHERE kind = 'passkey'").get().n, 0, "a synthetic click saves nothing");
  w.buttonNamed("Continue").click(true);
  const cred = await made;
  assert.ok(cred instanceof w.win.PublicKeyCredential);
  const spki = bytesOf(cred.response.getPublicKey());

  const challenge = crypto.randomBytes(32);
  const signing = w.win.navigator.credentials.get({ publicKey: { challenge, rpId: "harlow.test", allowCredentials: [{ type: "public-key", id: cred.rawId }] } });
  await until(() => /Sign in to harlow\.test as alex@harlow\.test with Vyre\?/.test(w.text()), "the sign-in prompt");
  w.buttonNamed("Continue").click(true);
  const got = await signing;

  // The relying party's checks.
  const cd = JSON.parse(bytesOf(got.response.clientDataJSON).toString("utf8"));
  assert.deepEqual([cd.type, cd.challenge, cd.origin], ["webauthn.get", challenge.toString("base64url"), "https://harlow.test"]);
  const auth = bytesOf(got.response.authenticatorData);
  assert.deepEqual(auth.subarray(0, 32), crypto.createHash("sha256").update("harlow.test").digest());
  const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const signed = Buffer.concat([auth, crypto.createHash("sha256").update(bytesOf(got.response.clientDataJSON)).digest()]);
  assert.equal(crypto.verify("sha256", signed, { key, dsaEncoding: "der" }, bytesOf(got.response.signature)), true);
  assert.deepEqual(bytesOf(got.response.userHandle), Buffer.from(new Uint8Array(options.publicKey.user.id)));
  assert.equal(w.browserCalls.length, 0, "Vyre answered both; the browser's own was never called");
});

// ---- the files --------------------------------------------------------------------------

test("the passkey scripts keep their promises", () => {
  const bridge = fs.readFileSync(path.join(HERE, "passkey-bridge.js"), "utf8");
  assert.match(bridge, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(bridge, /if \(!e\.isTrusted\) return;/);
  assert.ok(!/innerHTML/.test(bridge), "text only, never markup from a page or vyred");
  for (const src of [PAGE_JS, BRIDGE_JS]) {
    assert.ok(!/createElement\(["']script/.test(src), "no script tags: the page world is reached only by registration");
    assert.ok(!/\u2014|\u00a7/.test(src));
  }
  assert.ok(!/chrome\.|browser\./.test(PAGE_JS.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n")), "the page script has no extension API");
});
