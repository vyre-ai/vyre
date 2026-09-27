// @ts-check
// api.js's presence session: one passkey for a sessionable tool opens a session on this device,
// the next calls send it instead of asking again, a refusal forgets it and asks for the passkey,
// and a relaunched app finds it in localStorage until it expires. Also the app badge (needs.js).

import test from "node:test";
import assert from "node:assert/strict";
import { install } from "../test/fake-dom.js";

install();
const define = (/** @type {string} */ k, /** @type {any} */ v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

/** @type {Map<string, string>} */
const kept = new Map();
define("localStorage", { getItem: (/** @type {string} */ k) => kept.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { kept.set(k, String(v)); },
  removeItem: (/** @type {string} */ k) => { kept.delete(k); } });
/** @type {any[]} */
const events = [];
define("dispatchEvent", (/** @type {any} */ e) => { events.push(e); return true; });
define("PublicKeyCredential", class {});
let passkeys = 0;
const bytes = (/** @type {string} */ s) => new TextEncoder().encode(s).buffer;
define("navigator", { userAgent: "iPhone", maxTouchPoints: 5, credentials: { get: async () => { passkeys++; return { rawId: bytes("cred"),
  response: { authenticatorData: bytes("ad"), clientDataJSON: bytes("cd"), signature: bytes("sig") } }; } } });

/** @type {{ url: string, headers: Record<string, string>, body: any, keepalive?: boolean }[]} */
const sent = [];
/** What the box does with the next tool call: its body and the session header it returns. */
/** @type {(h: Record<string, string>) => { body: any, session?: string }} */
let box = () => ({ body: { data: { state: "sent" } } });
// @ts-ignore: a fake fetch for the challenge and the tool calls.
globalThis.fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
  sent.push({ url, headers: init.headers, body: JSON.parse(init.body || "{}"), keepalive: init.keepalive });
  if (url === "/v1/presence/challenge") return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: { challenge: "c1", webauthn: { challenge: "AAAA", rpId: "localhost" } } }) };
  const r = box(init.headers);
  const failed = !!r.body.error;
  return { ok: !failed, status: failed ? 403 : 200, statusText: "", headers: new Headers(r.session ? { "x-vyre-presence-session": r.session } : {}), json: async () => r.body };
};

const api = await import("./api.js");
const refused = { body: { error: { code: "presence_required", message: "no such session, or it ended" } } };

test("presence session: a passkey for gate.approve asks to keep one, and the box's header is stored", async () => {
  const until = Date.now() + 30 * 60_000;
  box = h => ({ body: { data: { state: "sent" } }, session: h["x-vyre-presence-keep"] === "1" ? `session id=s1 secret=k1 expires=${until}` : undefined });
  assert.equal(api.presenceCovered(), 0);
  await api.call("gate.approve", { id: "g1" }, { presence: true });
  const tool = sent.filter(s => s.url === "/v1/tools/gate.approve");
  assert.equal(tool.length, 1);
  assert.match(tool[0].headers["x-vyre-presence"], /^passkey id=c1 cred=\S+ ad=\S+ cd=\S+ sig=\S+$/);
  assert.equal(tool[0].headers["x-vyre-presence-keep"], "1");
  assert.equal(passkeys, 1);
  assert.equal(api.presenceCovered(), until);
  assert.deepEqual(JSON.parse(kept.get("vyre.presence.session") || "null"), { id: "s1", secret: "k1", expires: until });
  assert.equal(events.filter(e => e.type === "deck:presence").at(-1)?.detail, until);
});

test("presence session: the next send carries the session and asks for no passkey", async () => {
  sent.length = 0;
  box = () => ({ body: { data: { state: "sent" } } });
  await api.call("gate.approve", { id: "g2" }, { presence: true });
  assert.deepEqual(sent.map(s => s.url), ["/v1/tools/gate.approve"], "no challenge");
  assert.equal(sent[0].headers["x-vyre-presence"], "session id=s1 secret=k1");
  assert.equal(sent[0].headers["x-vyre-presence-keep"], undefined);
  assert.equal(passkeys, 1);
});

test("presence session: refused by the box, it is forgotten and the passkey is asked for (and keeps a new one)", async () => {
  sent.length = 0;
  const until = Date.now() + 30 * 60_000;
  box = h => (String(h["x-vyre-presence"]).startsWith("session ") ? refused : { body: { data: { state: "sent" } }, session: `session id=s2 secret=k2 expires=${until}` });
  await api.call("gate.approve", { id: "g3" }, { presence: true });
  assert.deepEqual(sent.map(s => s.url), ["/v1/tools/gate.approve", "/v1/presence/challenge", "/v1/tools/gate.approve"]);
  assert.match(sent[2].headers["x-vyre-presence"], /^passkey /);
  assert.equal(sent[2].headers["x-vyre-presence-keep"], "1");
  assert.equal(passkeys, 2);
  assert.equal(api.presenceCovered(), until);
  assert.equal(JSON.parse(kept.get("vyre.presence.session") || "{}").id, "s2");
});

test("presence session: a refused session with a cancelled passkey leaves nothing covered", async () => {
  box = () => refused;
  const get = navigator.credentials.get;
  /** @type {any} */ (navigator.credentials).get = async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); };
  await assert.rejects(api.call("gate.approve", { id: "g4" }, { presence: true }), (/** @type {any} */ e) => e.code === "cancelled");
  /** @type {any} */ (navigator.credentials).get = get;
  assert.equal(api.presenceCovered(), 0);
  assert.equal(kept.has("vyre.presence.session"), false);
  assert.equal(events.at(-1).detail, 0, "deck:presence says it ended");
});

test("presence session: a tool that is not sessionable never sends one and never asks to keep one", async () => {
  const until = Date.now() + 30 * 60_000;
  box = () => ({ body: { data: {} }, session: `session id=s3 secret=k3 expires=${until}` });
  await api.call("gate.approve", { id: "g5" }, { presence: true });
  sent.length = 0;
  await api.call("vault.put", { name: "kit-token" }, { presence: true });
  const tool = sent.filter(s => s.url === "/v1/tools/vault.put");
  assert.match(tool[0].headers["x-vyre-presence"], /^passkey /);
  assert.equal(tool[0].headers["x-vyre-presence-keep"], undefined);
  assert.equal(api.presenceCovered(), until, "the session is still there for the next send");
});

test("presence session: the box's word on an item wins; the time is this device's own", () => {
  const until = api.presenceCovered();
  assert.ok(until > Date.now());
  assert.equal(api.coveredUntil({ required: true, covered: true }), until);
  assert.equal(api.coveredUntil({ required: true, covered: false }), 0);
  assert.equal(api.coveredUntil({ required: false, covered: true }), 0, "nothing to prove, nothing to cover");
  assert.equal(api.coveredUntil(null), until, "an older box says nothing: the local session");
});

test("presence session: a header the box never sends, or one past its time, is not kept", async () => {
  for (const session of ["session id=s9 secret=k9", "passkey id=s9 secret=k9 expires=9999999999999", `session id=s9 secret=k9 expires=${Date.now() - 1}`]) {
    box = h => (String(h["x-vyre-presence"]).startsWith("session ") ? refused : { body: { data: {} }, session });
    await api.call("vault.reveal", { name: "kit-token" }, { presence: true });
    assert.equal(api.presenceCovered(), 0, session);
  }
  // A box whose clock runs ahead is trusted for at most 30 minutes.
  box = () => ({ body: { data: {} }, session: `session id=s8 secret=k8 expires=${Date.now() + 86_400_000}` });
  await api.call("vault.copy", { name: "kit-token" }, { presence: true });
  assert.ok(api.presenceCovered() <= Date.now() + 30 * 60_000);
});

test("presence session: a relaunched app finds a live session in localStorage, and drops an expired one", async () => {
  const until = Date.now() + 10 * 60_000;
  kept.set("vyre.presence.session", JSON.stringify({ id: "s5", secret: "k5", expires: until }));
  const again = await import("./api.js?relaunch");
  assert.equal(again.presenceCovered(), until);
  kept.set("vyre.presence.session", JSON.stringify({ id: "s6", secret: "k6", expires: Date.now() - 1 }));
  const later = await import("./api.js?later");
  assert.equal(later.presenceCovered(), 0);
  assert.equal(kept.has("vyre.presence.session"), false);
});

test("keepalive: a report sent as the page goes away asks the browser to finish it", async () => {
  sent.length = 0;
  box = () => ({ body: { error: { code: "no_such_tool", message: "no tool push.seen" } } });
  await assert.rejects(api.call("push.seen", { surface: "phone:abc123", visible: false }, { keepalive: true }), (/** @type {any} */ e) => e.missing);
  assert.equal(sent[0].keepalive, true);
  assert.equal(sent[0].headers["x-vyre-presence"], undefined);
});

test("app badge: the count goes on the icon only in the installed app, only when it changes", async () => {
  const needs = await import("./needs.js");
  /** @type {any[]} */ const calls = [];
  const nav = /** @type {any} */ (navigator);
  nav.setAppBadge = async (/** @type {number} */ n) => { calls.push(["set", n]); };
  nav.clearAppBadge = async () => { calls.push(["clear"]); };
  let standalone = false;
  define("matchMedia", () => ({ matches: standalone }));
  needs.badge(2);
  assert.deepEqual(calls, [], "a browser tab has no icon of its own");
  standalone = true;
  needs.badge(2);
  needs.badge(2);
  needs.badge(0);
  assert.deepEqual(calls, [["set", 2], ["clear"]]);
  nav.setAppBadge = () => { throw new Error("no"); };
  needs.badge(3); // a badge that throws is nothing to show
  delete nav.setAppBadge;
  needs.badge(4);
});

test("cover line: the device's own word and the time, or nothing", async () => {
  /** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); return { documentElement: s }; } };
  const { coverLine } = await import("./need-sheet.js");
  const { clock } = await import("./fmt.js");
  // need-sheet reads the same api.js as the tests above, which left a session open.
  const until = api.presenceCovered();
  assert.ok(until > Date.now());
  assert.equal(coverLine({ required: true, covered: true }, "Face ID"), `Face ID covers sends until ${clock(until)}`);
  assert.equal(coverLine(null, "passkey"), `Your passkey covers sends until ${clock(until)}`);
  assert.equal(coverLine({ required: true, covered: false }, "Face ID"), "");
  assert.equal(coverLine({ required: false }, "Face ID"), "");
  assert.equal(coverLine(null, "Face ID", until + 1), "", "past its time, nothing");
});
