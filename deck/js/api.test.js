// @ts-check
// api.js's presence session: one passkey for a sessionable tool opens a session on this device,
// the next calls send it instead of asking again, a refusal forgets it and asks for the passkey,
// and a relaunched app finds it in localStorage until it expires. Also the app badge (needs.js).

import "../../scripts/mac-test-guard.mjs";
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

test("presence session: a passkey for gate.approve asks to keep one, and your server's header is stored", async () => {
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

test("presence session: refused by your server, it is forgotten and the passkey is asked for (and keeps a new one)", async () => {
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

test("presence session: your server's word on an item wins; the time is this device's own", () => {
  const until = api.presenceCovered();
  assert.ok(until > Date.now());
  assert.equal(api.coveredUntil({ required: true, covered: true }), until);
  assert.equal(api.coveredUntil({ required: true, covered: false }), 0);
  assert.equal(api.coveredUntil({ required: false, covered: true }), 0, "nothing to prove, nothing to cover");
  assert.equal(api.coveredUntil(null), until, "an older box says nothing: the local session");
});

test("presence session: a header your server never sends, or one past its time, is not kept", async () => {
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

test("presence \"asked\": relay.join goes without proof first, and only passkeys once your server actually asks",
  async () => {
    // deck/onboard/onboard.js's live() screen calls relay.join this way (presence:"asked"), so a
    // box from before ADR 0004 (no presence_required) pairs in one round trip, and a box that
    // does require it gets exactly the retry api.js promises — never a passkey up front. This is
    // the sequence reviewer-2 flagged as uncovered: onboard-page.test.js's "pair with a code"
    // test only ever hits the fixture fallback (relay.join is not a real tool yet, so a
    // "missing" answer short-circuits before presence enters into it at all), so nothing
    // committed had actually driven a real presence_required round trip for this call.
    sent.length = 0;
    passkeys = 0;
    const input = { url: "relay://pair/abc123", becomeDevice: true };
    box = h => (h["x-vyre-presence"] ? { body: { data: { relay: true, box: { name: "kit" }, device: { id: "dev_1" } } } } : refused);
    const r = await api.call("relay.join", input, { presence: "asked" });
    assert.deepEqual(r, { relay: true, box: { name: "kit" }, device: { id: "dev_1" } });
    const tool = sent.filter(s => s.url === "/v1/tools/relay.join");
    assert.equal(tool.length, 2, "no proof first, then the real send once your server asks");
    assert.equal(tool[0].headers["x-vyre-presence"], undefined);
    assert.deepEqual(tool[0].body, input, "the same url/becomeDevice both times, not re-typed");
    assert.match(tool[1].headers["x-vyre-presence"], /^passkey id=c1 cred=\S+ ad=\S+ cd=\S+ sig=\S+$/);
    assert.deepEqual(tool[1].body, input);
    assert.equal(passkeys, 1);
  });

test("presence \"asked\": a server with no presence_required pairs in one round trip, no passkey shown",
  async () => {
    sent.length = 0;
    passkeys = 0;
    box = () => ({ body: { data: { relay: true, box: { name: "kit" } } } });
    await api.call("relay.join", { url: "relay://pair/def456", becomeDevice: true }, { presence: "asked" });
    assert.equal(sent.filter(s => s.url === "/v1/tools/relay.join").length, 1, "the no-nag rule: never asks a server that never asked");
    assert.equal(passkeys, 0);
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
  assert.equal(coverLine({ required: true, covered: true, since: Date.now() - 6 * 60_000 }, "Face ID"), `Face ID covers sends until ${clock(until)}, confirmed 6 min ago`);
});

test("device_removed on a 4xx tells the phone it was removed; a network error or a 5xx never does", async () => {
  let heard = 0;
  const off = api.onDeviceRemoved(() => { heard++; });
  const real = globalThis.fetch;
  try {
    box = () => ({ body: { error: { code: "device_removed", message: "this device was removed" } } });
    await assert.rejects(api.call("threads.list", {}), /removed/);
    assert.equal(heard, 1, "your server's own answer wipes");
    // A 5xx carrying the same words, a different code, and a dropped network: none of these wipe.
    // @ts-ignore
    globalThis.fetch = async () => ({ ok: false, status: 503, statusText: "", headers: new Headers(), json: async () => ({ error: { code: "device_removed", message: "x" } }) });
    await assert.rejects(api.call("threads.list", {}));
    // @ts-ignore
    globalThis.fetch = async () => ({ ok: false, status: 403, statusText: "", headers: new Headers(), json: async () => ({ error: { code: "denied", message: "x" } }) });
    await assert.rejects(api.call("threads.list", {}));
    globalThis.fetch = async () => { throw new Error("network"); };
    await api.attempt("threads.list", {});
    assert.equal(heard, 1);
    // Plain http over a network is not the box's own answer, however it is worded.
    globalThis.fetch = real;
    box = () => ({ body: { error: { code: "device_removed", message: "x" } } });
    const was = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", { value: { protocol: "http:", hostname: "192.168.1.5" }, configurable: true });
    await assert.rejects(api.call("threads.list", {}));
    assert.equal(heard, 1, "plain http never wipes");
    Object.defineProperty(globalThis, "location", { value: { protocol: "https:", hostname: "alex.vyre.run" }, configurable: true });
    await assert.rejects(api.call("threads.list", {}));
    assert.equal(heard, 2, "https to your server's own address does");
    if (was) Object.defineProperty(globalThis, "location", was); else delete globalThis.location;
  } finally { globalThis.fetch = real; off(); box = () => ({ body: { data: { state: "sent" } } }); }
});

test("ifPresent: a tool your server does not list is never called; one it lists, or an unreadable list, is", async () => {
  const seen = /** @type {string[]} */ ([]);
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => {
    seen.push(String(url));
    if (String(url) === "/v1/tools") return { status: 200, json: async () => ({ data: [{ name: "agents.list" }, { name: "projects.list" }] }) };
    return { status: 200, statusText: "", json: async () => ({ data: [] }) };
  });
  const { attempt } = await import("./api.js");
  const gone = await attempt("github.accounts", {}, { ifPresent: true });
  assert.equal(gone.error?.missing, true);
  assert.ok(!seen.some(u => u.includes("github.accounts")), "no request for a tool your server lacks");
  const there = await attempt("agents.list", {}, { ifPresent: true });
  assert.deepEqual(there.data, []);
  assert.equal(seen.filter(u => u === "/v1/tools").length, 1, "the list is asked once");
});
