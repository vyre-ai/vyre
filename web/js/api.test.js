// @ts-check
// api.js and the one yes: a tool that needs the person's yes answers presence_required with the exact request; the Deck asks a card for it, says it waits on the phone (deck:yes-wait),
// polls until the phone answers and calls again with the approved card. A reveal's card asks for the five-minute reuse. Signing in is the one call that still carries a passkey.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { install } from "../test/fake-dom.js";

install();
const define = (/** @type {string} */ k, /** @type {any} */ v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

/** @type {any[]} */
const events = [];
define("dispatchEvent", (/** @type {any} */ e) => { events.push(e); return true; });
define("PublicKeyCredential", class {});
let passkeys = 0;
const bytes = (/** @type {string} */ s) => new TextEncoder().encode(s).buffer;
define("navigator", { userAgent: "iPhone", maxTouchPoints: 5, credentials: { get: async () => { passkeys++; return { rawId: bytes("cred"),
  response: { authenticatorData: bytes("ad"), clientDataJSON: bytes("cd"), signature: bytes("sig") } }; } } });

/** @type {{ url: string, headers: Record<string, string>, body: any }[]} */
const sent = [];
/** What the box does with the next call to a tool: its body. */
/** @type {(url: string, h: Record<string, string>, body: any) => { body: any }} */
let box = () => ({ body: { data: { state: "sent" } } });
// @ts-ignore: a fake fetch for the challenge and the tool calls.
globalThis.fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
  const body = JSON.parse(init.body || "{}");
  sent.push({ url, headers: init.headers, body });
  if (url === "/v1/presence/challenge") return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: { challenge: "c1", webauthn: { challenge: "AAAA", rpId: "localhost" } } }) };
  const r = box(url, init.headers, body);
  const failed = !!r.body.error;
  return { ok: !failed, status: failed ? 403 : 200, statusText: "", headers: new Headers(), json: async () => r.body };
};

const api = await import("./api.js");
api.setYesPollMs(1);
const needs = (/** @type {string} */ moment, /** @type {string} */ op, /** @type {any} */ fields) => ({ body: { error: { code: "presence_required", message: `${op} needs your yes`, methods: [], moment, request: { op, fields } } } });

test("a send that needs the yes asks a card, waits on the phone, and calls again with the approved card", async () => {
  sent.length = 0; events.length = 0;
  let polls = 0;
  box = (url, h) => {
    if (url === "/v1/tools/gate.approve") return h["x-vyre-approval"] === "ap_1" ? { body: { data: { state: "sent" } } } : needs("outward", "gate.approve", { id: "g1" });
    if (url === "/v1/tools/approvals.ask") return { body: { data: { id: "ap_1", line: "Send the draft to Dana" } } };
    if (url === "/v1/tools/approvals.local-yes") return { body: { error: { code: "presence_required", message: "approve it in Vyre on your phone" } } };
    if (url === "/v1/tools/approvals.status") return { body: { data: { state: ++polls < 3 ? "waiting" : "approved" } } };
    return { body: { error: { code: "no_such_tool", message: url } } };
  };
  const r = await api.call("gate.approve", { id: "g1" }, { presence: true });
  assert.deepEqual(r, { state: "sent" });
  assert.deepEqual(sent.map(s => s.url.replace("/v1/tools/", "")), ["gate.approve", "approvals.ask", "approvals.local-yes", "approvals.status", "approvals.status", "approvals.status", "gate.approve"]);
  assert.deepEqual(sent[1].body, { moment: "outward", request: { op: "gate.approve", fields: { id: "g1" } } }, "exactly what the box named");
  assert.equal(sent.at(-1)?.headers["x-vyre-approval"], "ap_1");
  assert.equal(sent.some(s => s.headers["x-vyre-presence"]), false, "no old proof header");
  assert.equal(passkeys, 0, "no passkey for a send");
  const waits = events.filter(e => e.type === "deck:yes-wait").map(e => e.detail.state);
  assert.deepEqual(waits, ["waiting", "done"]);
});

test("on a computer that can confirm, Touch ID gives the yes at once and the phone is never asked", async () => {
  sent.length = 0;
  box = (url, h) => {
    if (url === "/v1/tools/vault.reveal") return h["x-vyre-approval"] === "ap_9" ? { body: { data: { value: "v" } } } : needs("vault", "vault.reveal", { name: "k" });
    if (url === "/v1/tools/approvals.ask") return { body: { data: { id: "ap_9", line: "Show k" } } };
    if (url === "/v1/tools/approvals.local-yes") return { body: { data: { answered: "approved" } } };
    return { body: { error: { code: "no_such_tool", message: url } } };
  };
  assert.deepEqual(await api.call("vault.reveal", { name: "k" }), { value: "v" });
  assert.deepEqual(sent.map(s => s.url.replace("/v1/tools/", "")), ["vault.reveal", "approvals.ask", "approvals.local-yes", "vault.reveal"]);
});

test("a reveal's card asks for the five-minute reuse, and a refusal on the phone rejects", async () => {
  sent.length = 0;
  box = (url, h) => {
    if (url === "/v1/tools/vault.reveal") return needs("vault", "vault.reveal", { name: "kit-token" });
    if (url === "/v1/tools/approvals.ask") return { body: { data: { id: "ap_2", line: "Show kit-token" } } };
    if (url === "/v1/tools/approvals.local-yes") return { body: { error: { code: "presence_required", message: "phone" } } };
    if (url === "/v1/tools/approvals.status") return { body: { data: { state: "refused" } } };
    return { body: { error: { code: "no_such_tool", message: url } } };
  };
  await assert.rejects(api.call("vault.reveal", { name: "kit-token" }, { presence: true }), (/** @type {any} */ e) => e.code === "presence_required" && /not approved/.test(e.message));
  assert.equal(sent.find(s => s.url === "/v1/tools/approvals.ask")?.body.reuse, true);
  sent.length = 0;
  box = (url) => (url === "/v1/tools/gate.approve" ? needs("outward", "gate.approve", { id: "g2" }) : url === "/v1/tools/approvals.ask" ? { body: { data: { id: "ap_3" } } } : url === "/v1/tools/approvals.local-yes" ? { body: { error: { code: "presence_required", message: "phone" } } } : { body: { data: { state: "refused" } } });
  await assert.rejects(api.call("gate.approve", { id: "g2" }), /not approved/);
  assert.equal(sent.find(s => s.url === "/v1/tools/approvals.ask")?.body.reuse, undefined, "a send asks for no window");
});

test("a refusal that is not a yes to give, and a tool that needs none, go through as they are", async () => {
  sent.length = 0;
  box = url => (url === "/v1/tools/agents.create" ? { body: { error: { code: "presence_required", message: "the person's own action", methods: [] } } } : { body: { data: { ok: 1 } } });
  await assert.rejects(api.call("agents.create", { name: "kit" }, { presence: "asked" }), (/** @type {any} */ e) => e.code === "presence_required");
  assert.deepEqual(sent.map(s => s.url), ["/v1/tools/agents.create"], "no card for a refusal that names no moment");
  sent.length = 0;
  assert.deepEqual(await api.call("projects.list"), { ok: 1 });
  assert.equal(sent.length, 1);
});

test("signing in still carries the passkey proof", async () => {
  sent.length = 0;
  box = () => ({ body: { data: { kind: "cookie", id: "p1", expires: 1 } } });
  await api.call("presence.person.start", {}, { presence: true });
  assert.deepEqual(sent.map(s => s.url), ["/v1/presence/challenge", "/v1/tools/presence.person.start"]);
  assert.match(sent[1].headers["x-vyre-presence"], /^passkey id=c1 cred=\S+ ad=\S+ cd=\S+ sig=\S+$/);
  assert.equal(passkeys, 1);
});
