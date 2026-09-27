// @ts-check
// js/person.js with api.js's person-session hook: a call the box answers with
// person_session_required opens one sign-in sheet, the passkey tap signs in, and the call goes
// again exactly once. Two calls at once share one sheet; "Not now" fails them; with no handler
// the error reaches the caller as before. No real passkey: navigator.credentials is a fake.

import test from "node:test";
import assert from "node:assert/strict";
import { install, $, $$ } from "../test/fake-dom.js";

const document = install();
const define = (/** @type {string} */ k, /** @type {any} */ v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
/** @type {any} */ (document).getElementById = () => null;
/** @type {any} */ (document).createElementNS = (/** @type {string} */ _ns, /** @type {string} */ tag) => document.createElement(tag);
define("requestAnimationFrame", (/** @type {() => void} */ f) => setImmediate(f));
define("matchMedia", () => ({ matches: true })); // Reduce Motion: a closed sheet goes at once
define("CustomEvent", class { constructor(/** @type {string} */ type, /** @type {any} */ o) { this.type = type; this.detail = o?.detail; } });
/** @type {any[]} */
const events = [];
define("dispatchEvent", (/** @type {any} */ e) => { events.push(e); return true; });
define("PublicKeyCredential", class {});
let passkeys = 0;
const bytes = (/** @type {string} */ s) => new TextEncoder().encode(s).buffer;
define("navigator", { userAgent: "iPhone", maxTouchPoints: 5, credentials: { get: async () => { passkeys++; return { rawId: bytes("cred"),
  response: { authenticatorData: bytes("ad"), clientDataJSON: bytes("cd"), signature: bytes("sig") } }; } } });

/** Calls per tool, and whether this device is signed in on the fake box. */
/** @type {Map<string, number>} */
const calls = new Map();
let signed = false;
/** The fake box refuses these tools until signed; `always` refuses even after. */
let always = false;
// @ts-ignore: a fake fetch for the challenge and the tool calls.
globalThis.fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
  const json = (/** @type {number} */ status, /** @type {any} */ body) => ({ ok: status < 300, status, statusText: "", headers: new Headers(), json: async () => body });
  if (url === "/v1/presence/challenge") {
    assert.deepEqual(JSON.parse(init.body), { tool: "presence.person.start", input: {}, method: "passkey" }, "the proof is bound to the sign-in and {}");
    return json(200, { data: { challenge: "c1", webauthn: { challenge: "AAAA", rpId: "localhost" } } });
  }
  const tool = decodeURIComponent(url.slice("/v1/tools/".length));
  calls.set(tool, (calls.get(tool) || 0) + 1);
  if (tool === "presence.person.start") {
    assert.match(init.headers["x-vyre-presence"], /^passkey id=c1 /);
    signed = true;
    return json(200, { data: { kind: "cookie", id: "p1", expires: Date.now() + 30 * 86_400_000 } });
  }
  if (!signed || always) return json(401, { error: { code: "person_session_required", message: "sign in on this device" } });
  return json(200, { data: { tool } });
};

const api = await import("./api.js");
const person = await import("./person.js");

const tick = () => new Promise(r => setImmediate(r));
async function until(/** @type {() => any} */ f) {
  for (let i = 0; i < 200; i++) { const v = f(); if (v) return v; await tick(); }
  throw new Error("timed out");
}
const sheets = () => $$(document.body, ".sheet");
const reset = () => { calls.clear(); signed = false; always = false; passkeys = 0; events.length = 0; };

test("person: with no handler, person_session_required reaches the caller as before", async () => {
  reset();
  api.setPersonHandler(null);
  await assert.rejects(api.call("threads.list"), (/** @type {any} */ e) => e.code === "person_session_required");
  assert.equal(calls.get("threads.list"), 1);
  assert.equal(sheets().length, 0);
});

test("person: a 401 opens the sheet, the passkey signs in, and the call goes again exactly once", async () => {
  reset();
  person.installPersonHandler();
  const p = api.call("threads.list", { limit: 3 });
  const go = await until(() => $(document.body, "button[data-act=sign-in]"));
  const sheet = sheets()[0];
  assert.match(sheet.textContent, /Sign in on this device/);
  assert.match(sheet.textContent, /One passkey, and this device stays signed in for 30 days\./);
  assert.equal(go.textContent, "Sign in with your passkey");
  assert.ok($(document.body, "button[data-act=not-now]"));
  assert.equal(passkeys, 0, "no passkey before the tap");
  await go.click();
  assert.deepEqual(await p, { tool: "threads.list" });
  assert.equal(passkeys, 1);
  assert.equal(calls.get("presence.person.start"), 1);
  assert.equal(calls.get("threads.list"), 2, "the first call and one retry");
  assert.equal(events.filter(e => e.type === "deck:person").length, 1);
  assert.equal(sheets().length, 0, "the sheet closed");
});

test("person: a box that still refuses after sign-in fails the call after one retry", async () => {
  reset();
  always = true;
  const p = api.call("threads.list");
  const go = await until(() => $(document.body, "button[data-act=sign-in]"));
  await go.click();
  await assert.rejects(p, (/** @type {any} */ e) => e.code === "person_session_required");
  assert.equal(calls.get("threads.list"), 2);
});

test("person: two calls at once share one sheet and both go again", async () => {
  reset();
  const a = api.call("threads.list");
  const b = api.call("projects.list");
  const go = await until(() => calls.get("projects.list") && $(document.body, "button[data-act=sign-in]"));
  await tick(); await tick();
  assert.equal(sheets().length, 1, "one sheet for both");
  await go.click();
  assert.deepEqual(await a, { tool: "threads.list" });
  assert.deepEqual(await b, { tool: "projects.list" });
  assert.equal(passkeys, 1);
  assert.equal(calls.get("threads.list"), 2);
  assert.equal(calls.get("projects.list"), 2);
});

test("person: Not now rejects every waiting call with its ApiError and signs nothing in", async () => {
  reset();
  const a = api.call("threads.list");
  const b = api.call("projects.list");
  const later = await until(() => calls.get("projects.list") && $(document.body, "button[data-act=not-now]"));
  await tick();
  await later.click();
  await assert.rejects(a, (/** @type {any} */ e) => e instanceof api.ApiError && e.code === "person_session_required" && e.tool === "threads.list");
  await assert.rejects(b, (/** @type {any} */ e) => e.code === "person_session_required" && e.tool === "projects.list");
  assert.equal(passkeys, 0);
  assert.equal(calls.get("presence.person.start"), undefined);
  assert.equal(calls.get("threads.list"), 1, "no retry after Not now");
  assert.equal(sheets().length, 0);
});

test("person: presence.person.* never waits on a sign-in", async () => {
  reset();
  await assert.rejects(api.call("presence.person.status"), (/** @type {any} */ e) => e.code === "person_session_required");
  assert.equal(sheets().length, 0);
  assert.equal(await person.personStatus(), null, "an unreadable status is no person sessions");
});
