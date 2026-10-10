// @ts-check
// siteops: run a learned website operation in the agent's own Chrome on the box (rung "box"). The agent's computer keeps its Chrome profile, so a login the person made once (through the
// screen view, where nothing attached can see the page) is still there on the next run, whether the Mac is on or not. The request is made by the page's own fetch, so the page's cookies sign
// it; the credential references are resolved here, from the page (lib/siteops/page.js, the same code the extension runs), and nothing that signs a request is returned.
//
// Pure of the module's tools: it takes a Cdp-shaped object ({ send, on, waitFor }) and a session, so it is tested without a Chrome.

import { runOperation } from "../../lib/siteops/run.js";
import { healOperation } from "../../lib/siteops/heal.js";
import { readOnly } from "../../lib/siteops/spec.js";
import { refsOf } from "../../lib/siteops/build.js";
import { fillTemplate } from "../../lib/siteops/codec.js";
import { STATE_EXPRESSION, fetchExpression, resolverFor, loginWall } from "../../lib/siteops/page.js";

const QUIET_MS = 800;
const IDLE_MAX_MS = 15_000;
const BODY_CAP = 1_000_000;
const MAX_BODIES = 80;
const TYPE = /** @type {Record<string, string>} */ ({ xhr: "xhr", fetch: "fetch", document: "document", script: "script", stylesheet: "stylesheet", image: "image", font: "font", media: "media", websocket: "websocket", ping: "ping" });
const lowerKeys = (/** @type {Record<string, any>} */ h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
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
 * Watch the page's own requests while something runs, newest first. Headers (cookies included) stay here: they are only ever used to resolve a reference. With `full` the answers are kept too
 * (their bodies, for the types that carry data), so a repair can relearn the operation from what the page really got; nothing of that leaves this file except as an exchange for the learner.
 * @param {CdpLike} cdp @param {string} sessionId @param {{ full?: boolean }} [o]
 */
function capture(cdp, sessionId, o = {}) {
  /** @type {Map<string, any>} */ const by = new Map();
  /** @type {any[]} */ const order = [];
  let pending = 0, last = Date.now(), bodies = 0;
  const off = cdp.on(m => {
    if (m.sessionId && m.sessionId !== sessionId) return;
    const p = m.params || {};
    if (m.method === "Network.requestWillBeSent") {
      const rec = { id: order.length + 1, requestId: String(p.requestId), type: String(p.type || "other").toLowerCase(), method: p.request && p.request.method || "GET", url: p.request && p.request.url || "", headers: { ...(p.request && p.request.headers || {}) }, ...(p.request && p.request.postData !== undefined ? { body: p.request.postData } : {}) };
      by.set(String(p.requestId), rec); order.push(rec); pending++; last = Date.now();
    } else if (m.method === "Network.requestWillBeSentExtraInfo") {
      const rec = by.get(String(p.requestId)); if (rec) Object.assign(rec.headers, p.headers || {});
    } else if (m.method === "Network.responseReceived") {
      const rec = by.get(String(p.requestId)); if (rec && o.full && p.response) Object.assign(rec, { status: p.response.status, resHeaders: p.response.headers || {}, mime: p.response.mimeType || "" });
    } else if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") {
      pending = Math.max(0, pending - 1); last = Date.now();
      const rec = by.get(String(p.requestId));
      if (rec && o.full) {
        if (m.method === "Network.loadingFailed") rec.failed = String(p.errorText || "failed");
        else if (/^(xhr|fetch|document)$/.test(rec.type) && (rec.status ?? 0) >= 200 && bodies < MAX_BODIES) {
          bodies++;
          rec.bodyP = Promise.resolve(cdp.send("Network.getResponseBody", { requestId: rec.requestId }, sessionId)).catch(() => null);
        }
      }
    }
  });
  return {
    stop: off,
    /** Newest first. */ recent: () => order.slice().reverse(),
    /** Wait until nothing is pending and nothing new has come for a moment. */
    async settle() { const end = Date.now() + IDLE_MAX_MS; while (Date.now() < end) { if (pending === 0 && Date.now() - last >= QUIET_MS) return; await sleep(100); } },
    /** What the page sent and got, in the learner's shape (lower-case headers, bodies as text). Needs `full`. */
    async exchanges() {
      /** @type {any[]} */ const out = [];
      for (const r of order) {
        let body;
        if (r.bodyP) { const b = await r.bodyP; if (b && !b.base64Encoded) body = String(b.body ?? "").slice(0, BODY_CAP); }
        out.push({
          id: r.id, resourceType: TYPE[r.type] || r.type,
          request: { method: r.method, url: r.url, headers: lowerKeys(r.headers), ...(r.body !== undefined ? { body: r.body } : {}) },
          ...(r.status !== undefined ? { response: { status: r.status, headers: lowerKeys(r.resHeaders), contentType: String(r.mime || ""), ...(body !== undefined ? { body } : {}) } } : {}),
          ...(r.failed && /BLOCKED_BY_CLIENT/i.test(r.failed) ? { aborted: true } : {}),
        });
      }
      return out;
    },
  };
}

/** One request made by the page itself (its cookies sign it), as the run and the repair both send it. @param {CdpLike} cdp @param {string} sessionId @param {string} origin */
const pageSend = (cdp, sessionId, origin) => async (/** @type {any} */ built) => {
  const v = await evaluate(cdp, sessionId, fetchExpression(built, origin));
  if (!v) throw new Error("the page returned nothing");
  if (v.originMismatch) throw new Error(`the browser is now on ${v.originMismatch}, not the site this operation belongs to`);
  return { status: v.status, headers: v.headers || {}, body: v.body ?? "" };
};

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
      send: pageSend(cdp, sessionId, origin),
    });
  } finally { cap.stop(); }
}

const HEAL_GUARD_MS = 10 * 60_000;
/** When each operation was last repaired or tried, so a site that keeps failing is not hammered. */
const lastHeal = new Map();

/** A trigger's click or fill, as the page runs it. The selector and the value are data in a literal, never joined into code. @param {{ action: string, selector?: string, value?: string }} step */
function stepExpression(step) {
  const sel = JSON.stringify(String(step.selector || ""));
  if (step.action === "click") return `(() => { const el = document.querySelector(${sel}); if (!el) return { missing: true }; el.click(); return { ok: true }; })()`;
  return `(() => { const el = document.querySelector(${sel}); if (!el) return { missing: true }; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(String(step.value ?? ""))}); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { ok: true }; })()`;
}

/**
 * Run an operation's trigger in this page and hand back what the page sent and got: the learner's exchanges, the page's storage and cookies (for the learner to tell a credential from an input) and
 * a sign-in wall if the trigger ended on one. The trigger must stay on the operation's own site.
 * @param {{ cdp: CdpLike, sessionId: string, trigger: any, inputs: Record<string, any>, origin: string }} q
 */
export async function runBoxTrigger({ cdp, sessionId, trigger, inputs, origin }) {
  if (!trigger || typeof trigger.url !== "string") throw new Error("this operation has no trigger to run");
  const enc = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v))]));
  const url = fillTemplate(trigger.url, enc);
  if (originOf(url) !== origin) throw new Error("the trigger must stay on the operation's own site");
  const cap = capture(cdp, sessionId, { full: true });
  try {
    await cdp.send("Network.enable", {}, sessionId);
    const goto = async (/** @type {string} */ to) => {
      if (originOf(to) !== origin) throw new Error("the trigger must stay on the operation's own site");
      const loaded = cdp.waitFor(m => m.method === "Page.loadEventFired" && m.sessionId === sessionId);
      await cdp.send("Page.navigate", { url: to }, sessionId);
      await loaded;
    };
    await goto(url);
    for (const step of trigger.steps || []) {
      if (step.action === "wait") await sleep(Math.min(10_000, Number(step.ms) || 500));
      else if (step.action === "goto") await goto(fillTemplate(String(step.value || ""), enc));
      else if (step.action === "click" || step.action === "fill") {
        const r = await evaluate(cdp, sessionId, stepExpression(step.action === "fill" ? { ...step, value: fillTemplate(String(step.value || ""), inputs) } : step));
        if (r && r.missing) throw new Error(`the page has no ${String(step.selector || "").slice(0, 60)} any more`);
      } else throw new Error(`the trigger step "${String(step.action).slice(0, 20)}" is not run on the box yet`);
    }
    await cap.settle();
    const state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
    const wall = loginWall(state.url, url);
    const out = { exchanges: await cap.exchanges(), storage: { ...state.session, ...state.local }, cookies: Object.entries(state.cookie || {}).map(([name, value]) => ({ name, value: String(value) })), ...(wall ? { loginWall: wall } : {}) };
    return { out, state, recent: cap.recent() };
  } finally { cap.stop(); }
}

/**
 * Repair a read that drifted: relearn it from what the page sends when its trigger runs, and keep the repair only after a replay of it answers (lib/siteops/heal.js). A write is never replayed to prove a
 * repair. Tried at most once in ten minutes per operation. The caller stores a healed operation as a new version.
 * @param {{ cdp: CdpLike, sessionId: string, op: any, inputs: Record<string, any>, verifyInputs?: Record<string, any>, force?: boolean, now?: () => number }} q
 */
export async function healBoxOperation({ cdp, sessionId, op, inputs, verifyInputs, force = false, now = Date.now }) {
  if (!readOnly(op)) return { outcome: "failed", reason: "a write is taught again from the page; it is never replayed to prove a repair" };
  if (!op.trigger) return { outcome: "failed", class: "drift", reason: "this operation has no trigger to relearn it from" };
  const origin = originOf(op.request.url);
  const key = `${origin}|${op.name}`;
  if (!force && now() - (lastHeal.get(key) || 0) < HEAL_GUARD_MS) return { outcome: "failed", class: "rate", reason: "this operation was repaired or tried less than ten minutes ago; not trying again yet" };
  lastHeal.set(key, now());
  /** @type {(ref: string) => string | undefined} */ let resolve = () => undefined;
  const out = await healOperation(op, inputs, {
    send: pageSend(cdp, sessionId, origin),
    gate: built => (/^(GET|HEAD)$/i.test(built.method) ? null : { held: true, why: "a repair is proven by a read only" }),
    resolveRef: ref => resolve(ref),
    runTrigger: async (o2, in2) => {
      const r = await runBoxTrigger({ cdp, sessionId, trigger: o2.trigger, inputs: in2, origin });
      resolve = resolverFor(r.state, r.recent, op);
      return r.out;
    },
    now: new Date().toISOString(),
  }, verifyInputs ? { verifyInputs } : {});
  return { ...out, op: op.name };
}

/**
 * Can this Chrome sign for the operation right now? Opens the site if the page is elsewhere, reports a sign-in wall as not signed in, and names which credential references the page can supply
 * (names only, never a value).
 * @param {{ cdp: CdpLike, sessionId: string, op: any }} q
 * @returns {Promise<{ ok: boolean, onSite: boolean, refs: Record<string, boolean>, reason?: string }>}
 */
export async function checkBoxOperation({ cdp, sessionId, op }) {
  const origin = originOf(op.request.url);
  const cap = capture(cdp, sessionId);
  try {
    await cdp.send("Network.enable", {}, sessionId);
    let state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
    if (!state || state.origin !== origin) {
      const loaded = cdp.waitFor(m => m.method === "Page.loadEventFired" && m.sessionId === sessionId);
      await cdp.send("Page.navigate", { url: `${origin}/` }, sessionId);
      await loaded; await cap.settle();
      state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
    }
    const wall = loginWall(state.url, `${origin}/`);
    if (wall) return { ok: false, onSite: true, refs: {}, reason: `the browser is on a sign-in page (${wall})` };
    const resolve = resolverFor(state, cap.recent(), op);
    /** @type {Record<string, boolean>} */ const refs = {};
    for (const r of refsOf(op)) refs[r] = resolve(r) !== undefined;
    return { ok: Object.values(refs).every(Boolean), onSite: true, refs };
  } finally { cap.stop(); }
}
