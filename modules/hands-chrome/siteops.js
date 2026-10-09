// @ts-check
// siteops: run a learned website operation in the agent's own Chrome on the box (rung "box"). The agent's computer keeps its Chrome profile, so a login the person made once (through the
// screen view, where nothing attached can see the page) is still there on the next run, whether the Mac is on or not. The request is made by the page's own fetch, so the page's cookies sign
// it; the credential references are resolved here, from the page (lib/siteops/page.js, the same code the extension runs), and nothing that signs a request is returned.
//
// Pure of the module's tools: it takes a Cdp-shaped object ({ send, on, waitFor }) and a session, so it is tested without a Chrome.

import { runOperation } from "../../lib/siteops/run.js";
import { readOnly } from "../../lib/siteops/spec.js";
import { refsOf } from "../../lib/siteops/build.js";
import { fillTemplate } from "../../lib/siteops/codec.js";
import { STATE_EXPRESSION, fetchExpression, resolverFor, loginWall } from "../../lib/siteops/page.js";

const QUIET_MS = 800;
const IDLE_MAX_MS = 15_000;
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const originOf = (/** @type {string} */ u) => { try { return new URL(u).origin; } catch { return ""; } };

/**
 * @typedef {{ send: (method: string, params?: any, sessionId?: string) => Promise<any>, on: (fn: (m: any) => void) => () => void, waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any> }} CdpLike
 */

/** Evaluate in the page and return its value. @param {CdpLike} cdp @param {string} sessionId @param {string} expression */
async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r && r.exceptionDetails) throw Object.assign(new Error(`the page could not run that: ${String(r.exceptionDetails.text || "error").split("\n")[0]}`), { code: "page" });
  return r && r.result ? r.result.value : undefined;
}

/**
 * Watch the page's own requests while something runs, newest first. Headers (cookies included) stay here: they are only ever used to resolve a reference.
 * @param {CdpLike} cdp @param {string} sessionId
 */
function capture(cdp, sessionId) {
  /** @type {Map<string, any>} */ const by = new Map();
  /** @type {any[]} */ const order = [];
  let pending = 0, last = Date.now();
  const off = cdp.on(m => {
    if (m.sessionId && m.sessionId !== sessionId) return;
    const p = m.params || {};
    if (m.method === "Network.requestWillBeSent") {
      const rec = { method: p.request && p.request.method || "GET", url: p.request && p.request.url || "", headers: { ...(p.request && p.request.headers || {}) }, ...(p.request && p.request.postData !== undefined ? { body: p.request.postData } : {}) };
      by.set(String(p.requestId), rec); order.push(rec); pending++; last = Date.now();
    } else if (m.method === "Network.requestWillBeSentExtraInfo") {
      const rec = by.get(String(p.requestId)); if (rec) Object.assign(rec.headers, p.headers || {});
    } else if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") { pending = Math.max(0, pending - 1); last = Date.now(); }
  });
  return {
    stop: off,
    /** Newest first. */ recent: () => order.slice().reverse(),
    /** Wait until nothing is pending and nothing new has come for a moment. */
    async settle() { const end = Date.now() + IDLE_MAX_MS; while (Date.now() < end) { if (pending === 0 && Date.now() - last >= QUIET_MS) return; await sleep(100); } },
  };
}

/**
 * Run one operation in this page. Returns what runOperation returns (ok, class, data, next ...). A sign-in wall or a challenge page is class auth or blocked, and the caller raises the card.
 * @param {{ cdp: CdpLike, sessionId: string, op: any, inputs: Record<string, any>, approved?: boolean }} q
 */
export async function runBoxOperation({ cdp, sessionId, op, inputs, approved = false }) {
  const origin = originOf(op.request.url);
  const cap = capture(cdp, sessionId);
  try {
    await cdp.send("Network.enable", {}, sessionId);
    /** Open the site (or the operation's own trigger page) and let it settle, so the page has made the requests a reference may come from. @param {string} url */
    const open = async url => {
      const loaded = cdp.waitFor(m => m.method === "Page.loadEventFired" && m.sessionId === sessionId);
      await cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
      await cap.settle();
    };
    let state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
    if (!state || state.origin !== origin) { await open(`${origin}/`); state = await evaluate(cdp, sessionId, STATE_EXPRESSION); }
    const wall0 = loginWall(state.url, `${origin}/`);
    if (wall0) return { ok: false, class: "auth", reason: `the browser is on a sign-in page (${wall0})`, next: "sign in again in the browser that runs this operation; then retry once", executed: false };
    let resolve = resolverFor(state, cap.recent(), op);
    // A reference nothing holds yet: the page makes it when the operation's own trigger runs (a read only: a trigger may click).
    const missing = () => refsOf(op).filter(r => resolve(r) === undefined);
    if (missing().length && readOnly(op) && op.trigger) {
      const enc = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v))]));
      const url = fillTemplate(op.trigger.url, enc);
      if (originOf(url) === origin) { await open(url); state = await evaluate(cdp, sessionId, STATE_EXPRESSION); resolve = resolverFor(state, cap.recent(), op); }
      const wall1 = loginWall(state.url, url);
      if (wall1) return { ok: false, class: "auth", reason: `the browser landed on a sign-in page (${wall1})`, next: "sign in again in the browser that runs this operation; then retry once", executed: false };
    }
    return await runOperation(op, inputs, {
      resolveRef: ref => resolve(ref),
      // reads run; anything else only with the person's yes already given (the kernel's approval, passed on by the connectors module)
      gate: built => (readOnly(op) && /^(GET|HEAD)$/i.test(built.method)) || approved ? null : { held: true, why: "an outward call waits for the person's yes" },
      send: async built => {
        const v = await evaluate(cdp, sessionId, fetchExpression(built, origin));
        if (!v) throw new Error("the page returned nothing");
        if (v.originMismatch) throw new Error(`the browser is now on ${v.originMismatch}, not the site this operation belongs to`);
        return { status: v.status, headers: v.headers || {}, body: v.body ?? "" };
      },
    });
  } finally { cap.stop(); }
}
