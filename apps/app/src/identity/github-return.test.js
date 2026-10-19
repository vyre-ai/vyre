// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { RETURN_KEY, START_KEY, START_MS, claimTicket, githubWay, landReturn, parseReturn, rememberStart, returnWaiting, safeBack, startUrl, takeReturn } from "./github-return.js";

const TICKET = "T".repeat(43);
const CV = "v".repeat(43);
const T0 = 1_760_000_000_000;

/** A browser's storage, or one that refuses everything (a private window that keeps nothing). */
function store({ refuse = false } = {}) {
  const m = new Map();
  return {
    m,
    getItem: (/** @type {string} */ k) => { if (refuse) throw new Error("denied"); return m.has(k) ? m.get(k) : null; },
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => { if (refuse) throw new Error("denied"); m.set(k, String(v)); },
    removeItem: (/** @type {string} */ k) => { if (refuse) throw new Error("denied"); m.delete(k); },
  };
}

test("a browser tab goes to GitHub itself, the Mac app claims, a phone uses the system sheet", () => {
  assert.equal(githubWay({ web: true, mac: false }), "redirect");
  assert.equal(githubWay({ web: true, mac: true }), "claim");
  assert.equal(githubWay({ web: false, mac: false }), "sheet");
  assert.equal(startUrl("https://relay.vyre.run/", "C".repeat(43), "https://web.vyre.run", false), `https://relay.vyre.run/v1/github/start?cc=${"C".repeat(43)}&app=https%3A%2F%2Fweb.vyre.run`);
  assert.equal(startUrl("https://relay.vyre.run", "C".repeat(43), "vyreapp://box", true), `https://relay.vyre.run/v1/github/start?cc=${"C".repeat(43)}&app=vyreapp%3A%2F%2Fbox&claim=1`);
});

test("the return fragment gives the ticket, or a denial, or a failure", () => {
  assert.equal(parseReturn(`#ticket=${TICKET}`), TICKET);
  assert.deepEqual(parseReturn("#error=denied"), { code: "denied" });
  assert.deepEqual(parseReturn("#error=failed"), { code: "failed" });
  assert.deepEqual(parseReturn("#ticket=short"), { code: "failed" });
  assert.deepEqual(parseReturn(""), { code: "failed" });
});

test("the page to come back to is always a path on this site", () => {
  for (const ok of ["/", "/onboard", "/settings/account?tab=1"]) assert.equal(safeBack(ok), ok);
  for (const bad of ["https://evil.test/", "//evil.test/x", "/\\evil.test", "javascript:alert(1)", "", null, "/a b"]) assert.equal(safeBack(bad), "/", String(bad));
});

test("the redirect round trip: start, land on the return page, back to the starting page, the ticket taken once with the kept verifier", () => {
  const s = store();
  assert.equal(rememberStart(s, { cv: CV, back: "/onboard", now: T0 }), true);
  assert.equal(returnWaiting(s, T0 + 1000), false, "nothing is back from GitHub yet");
  assert.equal(takeReturn(s, T0 + 1000), null);
  // GitHub sends the tab to /github-return, which keeps the fragment and goes back to /onboard.
  assert.equal(landReturn(s, `#ticket=${TICKET}`, T0 + 30_000), "/onboard");
  assert.equal(returnWaiting(s, T0 + 31_000), true);
  assert.deepEqual(takeReturn(s, T0 + 31_000), { ticket: TICKET, cv: CV });
  assert.equal(takeReturn(s, T0 + 32_000), null, "taken once");
  assert.equal(s.m.has(START_KEY) || s.m.has(RETURN_KEY), false, "nothing left behind");
});

test("a denial comes back as a denial; a return that is too late, or with no start in this browser, gives no ticket", () => {
  const s = store();
  rememberStart(s, { cv: CV, back: "/", now: T0 });
  landReturn(s, "#error=denied", T0 + 1000);
  assert.deepEqual(takeReturn(s, T0 + 1000), { code: "denied" });
  rememberStart(s, { cv: CV, back: "/", now: T0 });
  assert.equal(landReturn(s, `#ticket=${TICKET}`, T0 + START_MS + 1), null, "the start ran out: the page closes instead of going back");
  assert.equal(returnWaiting(s, T0 + START_MS + 1), false);
  assert.deepEqual(takeReturn(s, T0 + START_MS + 1), { code: "expired" });
  const fresh = store();
  assert.equal(landReturn(fresh, `#ticket=${TICKET}`, T0), null, "an older popup with no start here just closes");
  assert.deepEqual(takeReturn(fresh, T0), { code: "expired" });
  // A new start clears an old return, so a stale ticket is never taken for a new sign-in.
  const old = store();
  old.setItem(RETURN_KEY, `#ticket=${TICKET}`);
  rememberStart(old, { cv: CV, back: "https://evil.test", now: T0 });
  assert.equal(returnWaiting(old, T0), false);
  assert.equal(landReturn(old, `#ticket=${TICKET}`, T0 + 1), "/", "a start's page is kept only as a path on this site");
});

test("a browser that keeps nothing says so at the start rather than losing the sign-in at GitHub", () => {
  const s = store({ refuse: true });
  assert.equal(rememberStart(s, { cv: CV, back: "/", now: T0 }), false);
  assert.equal(returnWaiting(s, T0), false);
  assert.equal(takeReturn(s, T0), null);
  assert.equal(landReturn(s, `#ticket=${TICKET}`, T0), null);
  assert.equal(returnWaiting(null, T0), false);
  assert.equal(takeReturn(null, T0), null);
});

test("the Mac app asks until the ticket is there, keeps asking through a busy relay, and stops on a denial, a refusal or the time limit", async () => {
  const sleep = async () => {};
  /** @param {{ status: number, json: any }[]} answers */
  const relay = (answers) => { const seen = []; return { seen, ask: async (/** @type {string} */ cv) => { seen.push(cv); return answers.shift() || { status: 202, json: { waiting: true } }; } }; };
  const a = relay([{ status: 202, json: { waiting: true } }, { status: 0, json: null }, { status: 429, json: {} }, { status: 503, json: null }, { status: 200, json: { ticket: TICKET } }]);
  assert.equal(await claimTicket(a.ask, CV, { sleep }), TICKET);
  assert.deepEqual(a.seen, [CV, CV, CV, CV, CV], "always with the verifier");
  assert.deepEqual(await claimTicket(relay([{ status: 200, json: { error: "denied" } }]).ask, CV, { sleep }), { code: "denied" });
  assert.deepEqual(await claimTicket(relay([{ status: 200, json: { error: "failed" } }]).ask, CV, { sleep }), { code: "failed" });
  assert.deepEqual(await claimTicket(relay([{ status: 400, json: { error: "bad request" } }]).ask, CV, { sleep }), { code: "failed" });
  const slow = relay([]);
  assert.deepEqual(await claimTicket(slow.ask, CV, { sleep, every: 2000, until: 10_000 }), { code: "timeout" });
  assert.equal(slow.seen.length, 5);
});
