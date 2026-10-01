// @ts-check
// login: the wall is found, the tab is handed to the person once, and the run resumes when they are in.
import test from "node:test";
import assert from "node:assert/strict";
import login, { check, onFailure, appName, highlightScript } from "./extension/caps/login.js";
import { T } from "./test-support/trust.js";

/** @param {{ url?: string, wall?: string|null }} [o] */
function world(o = {}) {
  const st = { url: o.url ?? "https://app.gohighlevel.com/v2/location/L/automation/workflows", wall: o.wall ?? null, sent: /** @type {any[]} */ ([]), events: /** @type {any[]} */ ([]), updates: /** @type {any[]} */ ([]), presence: /** @type {any[]} */ ([]), stopped: false };
  const ctx = {
    tabs: { get: async () => ({ id: 5, windowId: 2, url: st.url }), update: async (/** @type {number} */ id, /** @type {any} */ p) => { st.updates.push(["update", id, p]); }, focusWindow: async (/** @type {number} */ w) => { st.updates.push(["focus", w]); } },
    cdp: { send: async (/** @type {number} */ _t, /** @type {string} */ m, /** @type {any} */ p) => { st.sent.push(String(p.expression)); const x = String(p.expression); if (x.includes("isPassword")) return { result: { value: st.wall === "password" } }; if (x.includes("verification code")) return { result: { value: st.wall === "code" } }; if (x.includes("data-vyre-hl")) return { result: { value: true } }; return { result: { value: false } }; } },
    frames: undefined,
    emit: (/** @type {any} */ e) => st.events.push(e),
    stopped: () => st.stopped,
    presence: { state: async (/** @type {any} */ s) => { st.presence.push(s); } },
  };
  return { st, ctx };
}

test("a visible password field, a code prompt and a sign-in host are all walls; an ordinary page is not", async () => {
  assert.equal((await check(world({ wall: "password" }).ctx, 5)).kind, "password");
  assert.equal((await check(world({ wall: "code" }).ctx, 5)).kind, "code");
  const g = await check(world({ url: "https://accounts.google.com/v3/signin/identifier" }).ctx, 5);
  assert.deepEqual([g.wall, g.kind], [true, "sign-in host"]);
  const p = await check(world({ url: "https://crm.example.com/login?next=/" }).ctx, 5);
  assert.equal(p.wall, true);
  assert.equal((await check(world().ctx, 5)).wall, false);
  assert.equal((await check(world({ url: "about:blank" }).ctx, 5)).wall, false);
});

test("the app is named the way a person knows it", () => {
  assert.equal(appName("app.gohighlevel.com"), "GoHighLevel");
  assert.equal(appName("client-app.leadconnectorhq.com"), "GoHighLevel");
  assert.equal(appName("accounts.google.com"), "Google");
  assert.equal(appName("login.acme.example"), "login.acme.example", "an unknown site is named by its host");
  // a look-alike host is never announced as the vendor
  for (const evil of ["google-login.evil.example", "accounts.google.com.evil.example", "evilgoogle.com", "notgohighlevel.com", "microsoftonline.com.phish.example"]) assert.equal(appName(evil), evil, evil);
  assert.equal(appName("app.gohighlevel.com:443"), "GoHighLevel");
});

test("a failed step on a login page: the tab comes to the front, the form is outlined, the person is told once, and the error is login_required", async () => {
  const w = world({ wall: "password" });
  const e1 = await onFailure("page.act", { tabId: 5 }, { code: "not_found" }, w.ctx);
  assert.equal(e1 && e1.code, "login_required");
  assert.match(String(e1 && e1.message), /chrome_login/);
  assert.match(String(e1 && e1.message), /Do not type a password/);
  assert.deepEqual(w.st.updates, [["update", 5, { active: true }], ["focus", 2]]);
  assert.ok(w.st.sent.some(s => s.includes("data-vyre-hl")), "outlined");
  assert.equal(w.st.events.filter(e => e.event === "login.wall").length, 1);
  assert.equal(w.st.events[0].message, "Sign in to GoHighLevel (app.gohighlevel.com) in the window I opened. I'll carry on when you're in.");
  assert.deepEqual(w.st.presence[0], { waiting: "sign in to GoHighLevel (app.gohighlevel.com)", login: { site: "GoHighLevel (app.gohighlevel.com)" } });
  // a second failure while they are signing in does not tell them again
  await onFailure("page.act", { tabId: 5 }, { code: "timeout" }, w.ctx);
  assert.equal(w.st.events.filter(e => e.event === "login.wall").length, 1);
});

test("a failure on an ordinary page is left alone, and so are codes that are not about the page finding things", async () => {
  const w = world();
  assert.equal(await onFailure("page.act", { tabId: 5 }, { code: "not_found" }, w.ctx), null);
  const x = world({ wall: "password" });
  assert.equal(await onFailure("page.act", { tabId: 5 }, { code: "stopped" }, x.ctx), null);
  assert.equal(await onFailure("tabs.list", { tabId: 5 }, { code: "not_found" }, x.ctx), null);
  assert.equal(x.st.events.length, 0);
});

test("login.wait resumes by itself: the wall must be gone for two looks, then the outline and the waiting state are cleared and the person is not asked again", async () => {
  const w = world({ wall: "password" });
  await T(login.ops["login.handoff"])({ tabId: 6 }, w.ctx);
  setTimeout(() => { w.st.wall = null; }, 30);
  const r = await T(login.ops["login.wait"])({ tabId: 6, timeoutMs: 5000, pollMs: 20 }, w.ctx);
  assert.equal(r.ok, true);
  assert.equal(r.signedIn, true);
  assert.equal(w.st.events.filter(e => e.event === "login.done").length, 1);
  assert.deepEqual(w.st.presence[w.st.presence.length - 1], { waiting: null });
  assert.ok(w.st.sent.filter(s => s.includes("data-vyre-hl")).length >= 2, "outlined, then cleared");
});

test("login.wait times out honestly and stops when the person presses stop; it never types", async () => {
  const w = world({ wall: "code" });
  const r = await T(login.ops["login.wait"])({ tabId: 7, timeoutMs: 1000, pollMs: 10 }, w.ctx);
  assert.equal(r.ok, false);
  assert.match(String(r.why), /still waiting/);
  const s = world({ wall: "password" });
  s.st.stopped = true;
  await assert.rejects(T(login.ops["login.wait"])({ tabId: 8, timeoutMs: 3000, pollMs: 10 }, s.ctx), { code: "stopped" });
  for (const m of [w, s]) assert.ok(!m.st.sent.some(x => /Input\.|insertText|\.value\s*=/.test(x)));
  assert.ok(!/\.value\s*=|insertText|dispatchKeyEvent/.test(highlightScript(true)), "the highlight script types nothing");
});

test("the pill's Continue re-checks at once and Skip gives up; neither can make a wall that is still there count as signed in", async () => {
  const { signal } = await import("./extension/caps/login.js");
  const w = world({ wall: "password" });
  setTimeout(() => signal(11, "continue"), 20);
  const r = await T(login.ops["login.wait"])({ tabId: 11, timeoutMs: 400, pollMs: 100000 }, w.ctx);
  assert.equal(r.signedIn, false, "Continue with the wall still up is not signed in");
  const k = world({ wall: "password" });
  setTimeout(() => signal(12, "skip"), 20);
  const sk = await T(login.ops["login.wait"])({ tabId: 12, timeoutMs: 5000, pollMs: 100000 }, k.ctx);
  assert.equal(sk.skipped, true);
  assert.deepEqual(k.st.presence[k.st.presence.length - 1], { waiting: null });
});

test("a phishing page with a password field is announced by its own host, never as a vendor", async () => {
  const w = world({ url: "https://google-login.evil.example/signin", wall: "password" });
  const e = await onFailure("page.act", { tabId: 21 }, { code: "not_found" }, w.ctx);
  assert.match(String(e && e.message), /google-login\.evil\.example/);
  assert.doesNotMatch(String(e && e.message), /^Google /);
  assert.equal(w.st.events[0].message, "Sign in to google-login.evil.example in the window I opened. I'll carry on when you're in.");
});
