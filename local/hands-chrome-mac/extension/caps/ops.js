// @ts-check
// ops: learned website operations, run from inside the person's own page.
//
// An operation (shared/sk/siteops) is a named, typed call the site's own frontend makes, learned from two runs of the page and a diff, and kept as a TEMPLATE: slots for the inputs, and
// REFERENCES for the credentials (`cookie:<name>`, `session:<name>`). This file is where those references are resolved, and it is the only place: the login is read in this worker, handed to
// the page's own fetch, and the answer comes back as extracted data. Nothing that signs a request is ever returned, logged, stored or written to a file.
//
//   ops.learn   run the trigger twice (two different example inputs), diff the traffic, return the operation draft. A write is learned by BLOCKING its request (nothing is sent) and only
//               after the person's yes, because the page's own Send is clicked to make it fire.
//   ops.call    run a stored operation: inputs checked, refs resolved here, a send held at the Gate, ONE request from inside the page, the answer classified and cut.
//   ops.heal    after a drift: run the trigger with the failing call's inputs, relearn, keep the repair only if a replay answers ok. Reads only; a write is relearned by ops.learn.
//   ops.scout   the capture of the last run as a few lines per candidate request (what carries the example, what the answer looks like), so an agent chooses on few tokens.
//   ops.check   can this tab sign this operation right now: the right site, and which references resolve (names only).

import { learnOperation } from "../shared/sk/siteops/learn.js";
import { suggestPick } from "../shared/sk/siteops/pickfields.js";
import { parseBody } from "../shared/sk/siteops/extract.js";
import { STATE_EXPRESSION, resolverFor, loginWall } from "../shared/sk/siteops/page.js";
import { runOperation } from "../shared/sk/siteops/run.js";
import { healOperation } from "../shared/sk/siteops/heal.js";
import { scout } from "../shared/sk/siteops/outline.js";
import { parseOperation, readOnly } from "../shared/sk/siteops/spec.js";
import { refsOf } from "../shared/sk/siteops/build.js";
import { fillTemplate } from "../shared/sk/siteops/codec.js";
import * as redact from "../shared/sk/siteops/redact.js";
import { held, writeGate, digest } from "../shared/outbound.js";
import net, { records, target, refuse, pageFetch, start, runIn } from "./net.js";

const BODY_CAP = 1_000_000;
const MAX_BODIES = 80;
const QUIET_MS = 800;
const IDLE_MAX_MS = 15_000;
/** A heal is tried at most once per operation in this long: a site that keeps failing is not hammered. */
const HEAL_GUARD_MS = 10 * 60_000;
/** @type {Map<string, number>} */
const lastHeal = new Map();
/** The last capture of ops.learn, per tab, for ops.scout. @type {Map<number, any[]>} */
const lastCapture = new Map();

const TYPE = { xhr: "xhr", fetch: "fetch", document: "document", script: "script", stylesheet: "stylesheet", image: "image", font: "font", media: "media", websocket: "websocket", ping: "ping" };

/** @param {Record<string, any>|undefined} h */
const lowerKeys = h => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const originOf = (/** @type {string} */ u) => { try { return new URL(u).origin; } catch { return ""; } };

/** The operation from a call's args, checked. Never trusts its shape. @param {any} raw */
function opOf(raw) {
  const p = parseOperation(raw);
  if (!p.ok) throw refuse("bad_request", `not a valid operation: ${p.problems[0]}`);
  return p.op;
}

/** Raw records of a tab since a time, as the Exchanges learn.js reads, with response bodies fetched for the data requests. Raw stays in the worker. @param {any} ctx @param {number} tab @param {number} since */
async function exchanges(ctx, tab, since) {
  const recs = (await records(ctx, tab, { since })).sort((a, b) => a.seq - b.seq);
  /** @type {any[]} */ const out = [];
  let bodies = 0;
  for (const r of recs) {
    const rt = String(r.type || "other").toLowerCase();
    const ok = r.done && !r.failed;
    let body;
    if (ok && /^(xhr|fetch|document)$/.test(rt) && (r.status ?? 0) >= 200 && bodies < MAX_BODIES) {
      bodies++;
      try {
        const b = r.session ? await ctx.cdp.send(tab, "Network.getResponseBody", { requestId: r.requestId }, r.session) : await ctx.cdp.send(tab, "Network.getResponseBody", { requestId: r.requestId });
        if (b && !b.base64Encoded) body = String(b.body ?? "").slice(0, BODY_CAP);
      } catch { /* Chrome no longer holds it */ }
    }
    out.push({
      id: r.seq, resourceType: /** @type {any} */ (TYPE)[rt] || rt,
      request: { method: r.method, url: r.url, headers: lowerKeys(r.reqHeaders), ...(r.postData !== undefined ? { body: r.postData } : {}) },
      ...(ok || (r.status !== undefined) ? { response: { status: r.status ?? 0, headers: lowerKeys(r.resHeaders), contentType: String(r.mime || ""), ...(body !== undefined ? { body } : {}) } } : {}),
      ...(r.failed && /BLOCKED_BY_CLIENT/i.test(String(r.failed)) ? { aborted: true } : {}),
    });
  }
  return out;
}

/** Wait until the page has gone quiet: nothing pending and no new request for QUIET_MS. @param {any} ctx @param {number} tab @param {number} since */
async function settle(ctx, tab, since) {
  const end = Date.now() + IDLE_MAX_MS;
  let lastCount = -1, lastChange = Date.now();
  while (Date.now() < end) {
    const recs = await records(ctx, tab, { since });
    const pending = recs.some(r => !r.done);
    if (recs.length !== lastCount) { lastCount = recs.length; lastChange = Date.now(); }
    if (!pending && Date.now() - lastChange >= QUIET_MS) return;
    await sleep(100);
  }
}

/** The page's own storage, read here and never returned. @param {any} ctx @param {number} tab */
async function pageState(ctx, tab) {
  const res = await runIn(ctx, tab, null, STATE_EXPRESSION, { returnByValue: true });
  return /** @type {{ origin: string, url: string, cookie: Record<string, string>, local: Record<string, string>, session: Record<string, string> }} */ (res?.result?.value || { origin: "", url: "", cookie: {}, local: {}, session: {} });
}

/**
 * Resolve a credential reference where the request is signed (lib/siteops/page.js says how). The value stays in this closure; an unresolved reference is undefined and the caller says so.
 * @param {any} ctx @param {number} tab @param {string} origin @param {any} op
 */
async function makeResolver(ctx, tab, origin, op) {
  const st = await pageState(ctx, tab);
  if (st.origin !== origin) throw refuse("bad_request", `this tab is on ${redact.url(st.origin || "no page")}, not ${redact.url(origin)}: open the site's tab first`);
  const recent = (await records(ctx, tab, {})).filter(r => originOf(r.url) === origin).sort((a, b) => b.seq - a.seq).slice(0, 120)
    .map(r => ({ method: r.method, url: r.url, headers: r.reqHeaders || {}, ...(r.postData !== undefined ? { body: r.postData } : {}) }));
  return resolverFor(st, recent, op);
}

/** @param {string} v */
const clip = v => (v.length > 80 ? v.slice(0, 79) + "…" : v);

/**
 * The Gate's view of a call. A read passes (a GET or HEAD; any other method waits like a write). A send or a spend always waits for a yes. A change or a delete is a write made with the
 * person's login: the one write gate decides (asked, or covered by a plan they approved).
 * @param {any} op @param {Record<string, any>} inputs @param {any} trust
 * @returns {{ gate: (built: any) => any, pass: () => { pass?: symbol } }}
 */
function gateFor(op, inputs, trust) {
  /** @type {{ pass?: symbol }} */ let passed = {};
  const fields = Object.entries(inputs).slice(0, 8).map(([name, v]) => ({ name, value: clip(typeof v === "string" ? v : JSON.stringify(v)) }));
  return {
    pass: () => passed,
    gate: built => {
      const m = String(built.method).toUpperCase();
      const body = typeof built.body === "string" ? built.body : "";
      // The pass itself is the write gate's to give (net.js alone checks it): ask it, once this function has decided the call may go.
      const allow = () => { passed = writeGate(m, built.url, body, { asked: true }); return null; };
      if (op.kind === "read" && /^(GET|HEAD)$/.test(m)) return allow();
      if (trust && (trust.asked === true || trust.writeOk === true) && op.kind !== "send" && op.kind !== "spend") return allow();
      if (op.kind === "send" || op.kind === "spend") {
        if (trust && trust.asked === true) return allow();
        const h = held(m, built.url, op.kind === "spend" ? "this spends money" : "this sends something as the person", `${m} ${built.url} ${body}`);
        return { ...h, control: { role: "request", name: `${op.name} (${op.kind})` }, fields, op: op.name };
      }
      const g = writeGate(m, built.url, body, trust || {});
      if (g.held) return { ...g.held, control: { role: "request", name: `${op.name} (${op.kind})` }, fields, op: op.name };
      return allow();
    },
  };
}

/**
 * Run a trigger once: open the page with the example in its URL, do its steps, wait for quiet, return what the page sent. With `abortWrites` every write to the site is BLOCKED while it runs, so
 * clicking the page's own Send teaches the request and sends nothing.
 * @param {any} ctx @param {number} tab @param {any} trigger @param {Record<string, any>} inputs @param {{ abortWrites?: boolean, origin: string, trust?: any }} o
 */
async function runTrigger(ctx, tab, trigger, inputs, o) {
  const enc = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v))]));
  const url = fillTemplate(trigger.url, enc);
  if (originOf(url) !== o.origin) throw refuse("bad_request", "the trigger must stay on the operation's own site");
  const since = Date.now() - 50;
  /** @type {string[]} */ const rules = [];
  try {
    if (o.abortWrites) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await net.ops["net.on"]({ tab, filter: { method, url: o.origin }, then: { action: "block", reason: "BlockedByClient" }, ttlMs: 120_000 }, ctx);
        rules.push(r.ruleId);
      }
    }
    await ctx.call("tabs.navigate", { tabId: tab, url, timeoutMs: 20_000 }, {});
    for (const s of trigger.steps || []) {
      if (ctx.stopped()) throw refuse("stopped");
      if (s.action === "wait") await sleep(Math.min(10_000, Number(s.ms) || 500));
      else if (s.action === "goto") await ctx.call("tabs.navigate", { tabId: tab, url: fillTemplate(String(s.value || ""), enc), timeoutMs: 20_000 }, {});
      else if (s.action === "click") await ctx.call("page.act", { tab, kind: "click", selector: s.selector }, o.abortWrites ? { asked: true } : (o.trust || {}));
      else if (s.action === "fill") await ctx.call("page.act", { tab, kind: "type", selector: s.selector, value: fillTemplate(String(s.value || ""), inputs) }, o.trust || {});
      else if (s.action === "press") await ctx.call("page.act", { tab, kind: "press", selector: s.selector, value: s.value }, o.trust || {});
    }
    await settle(ctx, tab, since);
  } finally {
    for (const id of rules) { try { await net.ops["net.off"]({ tab, ruleId: id }, ctx); } catch { /* expired */ } }
  }
  const st = await pageState(ctx, tab);
  const wall = loginWall(st.url, new URL(trigger.url, o.origin).toString());
  return { exchanges: await exchanges(ctx, tab, since), storage: { ...st.session, ...st.local }, cookies: Object.entries(st.cookie).map(([name, value]) => ({ name, value })), ...(wall ? { loginWall: wall } : {}) };
}

/** @param {any} v */
const scrubData = v => redact.value(v);

/** @type {Record<string, (args: any, ctx: any, trust?: any) => Promise<any>>} */
const ops = {
  async "ops.learn"(args, ctx, trust = {}) {
    const kind = String(args?.kind || "read");
    const write = kind !== "read";
    const ex = Array.isArray(args?.examples) ? args.examples : [];
    if (ex.length < 1 || ex.length > 2) throw refuse("bad_request", "ops.learn needs one example input, or two different ones (two let it tell inputs from nonces)");
    const trigger = args?.trigger;
    if (!trigger || typeof trigger.url !== "string") throw refuse("bad_request", "ops.learn needs a trigger: { url, steps? }");
    const origin = originOf(fillTemplate(trigger.url, {}));
    if (!origin) throw refuse("bad_request", "the trigger url must be absolute");
    const tab = await target(ctx, args, write ? "api.call" : "api.catalog", write);
    // A write is taught by clicking the page's own Send with its request blocked. Nothing is sent, but the person says yes first, because the click is real.
    if (write && trust.asked !== true) {
      return { ok: false, held: true, why: `To teach "${String(args?.name || "this")}" Vyre will fill the page and press its Send with the request BLOCKED, twice. Nothing is sent. It waits for the person's yes.`,
        control: { role: "request", name: `Teach ${String(args?.name || "operation")} (${kind})` }, fields: [], sig: digest(`learn ${origin} ${args?.name} ${JSON.stringify(trigger)}`) };
    }
    await start(ctx, tab);
    const first = await runTrigger(ctx, tab, trigger, ex[0], { abortWrites: write, origin, trust });
    const second = ex[1] ? await runTrigger(ctx, tab, trigger, ex[1], { abortWrites: write, origin, trust }) : null;
    if (first.loginWall) return { ok: false, class: "auth", reason: `the trigger landed on a sign-in page (${first.loginWall}); sign in in this browser, then learn again`, next: "sign in, then retry" };
    lastCapture.set(tab, first.exchanges);
    /** @type {any} */ let learned;
    try {
      learned = learnOperation({ name: String(args?.name || ""), kind, exchanges: first.exchanges, ...(second ? { exchanges2: second.exchanges } : {}), examples: /** @type {any} */ (ex), cookies: first.cookies, storage: first.storage,
        trigger, ...(args?.match ? { match: args.match } : {}), ...(Number.isInteger(args?.id) ? { id: args.id } : {}), ...(Array.isArray(args?.public) ? { public: args.public } : {}),
        ...(args?.keepExamples === true ? { keepExamples: true } : {}), now: new Date().toISOString() });
    } catch (e) { return { ok: false, class: "input", reason: String(/** @type {any} */ (e).message || e), next: "pick the request that carries the example (ops.scout, then pass its id) or change the example" }; }
    // The fields the person wants back ("name, headline, location"): found in the answer the learned request got, so nobody writes a path by hand.
    /** @type {string[]|undefined} */ let missing;
    if (Array.isArray(args?.wants) && args.wants.length && learned.operation.kind === "read") {
      try {
        const body = String((first.exchanges.find((/** @type {any} */ e) => e.id === learned.exchange.id)?.response || {}).body || "");
        const sp = suggestPick(parseBody(body, learned.operation.response.xssiPrefix), args.wants.map(String), { extract: learned.operation.response.extract });
        if (sp.pick.length) learned.operation.response.pick = sp.pick;
        missing = sp.missing.length ? sp.missing : undefined;
      } catch { /* an answer that is not JSON has no fields to pick */ }
    }
    return { ok: true, operation: learned.operation, warnings: learned.warnings, ...(missing ? { missingFields: missing } : {}), origin, request: { id: learned.exchange.id }, aborted: write ? true : undefined };
  },

  async "ops.scout"(args, ctx) {
    const tab = await target(ctx, args, "api.catalog");
    const ex = args?.examples && typeof args.examples === "object" ? args.examples : {};
    const pool = lastCapture.get(tab) || (await exchanges(ctx, tab, Number(args?.since) || 0));
    return { candidates: scout(pool, ex, { limit: Math.min(Number(args?.limit) || 8, 20) }), captured: pool.length };
  },

  async "ops.check"(args, ctx) {
    const op = opOf(args?.op);
    const tab = await target(ctx, args, "api.catalog");
    const origin = originOf(op.request.url);
    await start(ctx, tab);
    /** @type {Record<string, boolean>} */ const refs = {};
    try {
      const resolve = await makeResolver(ctx, tab, origin, op);
      for (const r of refsOf(op)) refs[r] = resolve(r) !== undefined;
    } catch (e) { return { ok: false, onSite: false, reason: String(/** @type {any} */ (e).message || e) }; }
    return { ok: Object.values(refs).every(Boolean), onSite: true, refs };
  },

  async "ops.call"(args, ctx, trust = {}) {
    const op = opOf(args?.op);
    const inputs = args?.inputs && typeof args.inputs === "object" ? args.inputs : {};
    const acting = !(readOnly(op) && /^(GET|HEAD)$/.test(op.request.method));
    const tab = await target(ctx, args, acting ? "api.call" : "api.catalog", acting);
    const origin = originOf(op.request.url);
    await start(ctx, tab);
    const g = gateFor(op, inputs, trust);
    const resolveRef = await makeResolver(ctx, tab, origin, op);
    /** @param {any} built */
    const send = async built => {
      const r = await pageFetch(ctx, tab, built, { origin, gate: g.pass() });
      return { status: r.status, headers: r.headers || {}, body: r.body ?? "" };
    };
    let res = await runOperation(op, inputs, { resolveRef, send, gate: g.gate, maxChars: Number(args?.maxChars) || undefined });
    // A read whose credential reference found nothing: open the page the way the operation was learned (its trigger), which makes the page send them, then ask once more. A write never does this.
    if (!res.ok && res.missingRefs && res.missingRefs.length && readOnly(op) && args?.refresh !== false && op.trigger) {
      await runTrigger(ctx, tab, op.trigger, inputs, { origin, abortWrites: false, trust });
      const again = await makeResolver(ctx, tab, origin, op);
      res = await runOperation(op, inputs, { resolveRef: again, send, gate: g.gate, maxChars: Number(args?.maxChars) || undefined });
    }
    if (res.class === "held") return { ...res.held, op: op.name };
    return { ...res, ...(res.data !== undefined ? { data: scrubData(res.data) } : {}), ...(res.reason ? { reason: redact.text(String(res.reason)) } : {}), op: op.name };
  },

  async "ops.heal"(args, ctx, trust = {}) {
    const op = opOf(args?.op);
    if (!readOnly(op)) return { outcome: "failed", reason: "a write is relearned with ops.learn (the page's Send is pressed with its request blocked); it is never replayed to prove a repair" };
    const inputs = args?.inputs && typeof args.inputs === "object" ? args.inputs : {};
    const tab = await target(ctx, args, "api.catalog");
    const origin = originOf(op.request.url);
    const key = `${origin}|${op.name}`;
    if (args?.force !== true && Date.now() - (lastHeal.get(key) || 0) < HEAL_GUARD_MS) return { outcome: "failed", class: "rate", reason: "this operation was repaired or tried less than ten minutes ago; not trying again yet" };
    lastHeal.set(key, Date.now());
    await start(ctx, tab);
    const g = gateFor(op, inputs, trust);
    const pass = () => g.pass();
    /** @type {((ref: string) => string|undefined)|null} */ let cur = await makeResolver(ctx, tab, origin, op);
    // Read lazily: the trigger changes what the page holds, so the repair is proven with fresh values.
    const resolveRef = async (/** @type {string} */ ref) => { if (!cur) cur = await makeResolver(ctx, tab, origin, op); return cur(ref); };
    /** @param {any} built */
    const send = async built => { const r = await pageFetch(ctx, tab, built, { origin, gate: pass() }); return { status: r.status, headers: r.headers || {}, body: r.body ?? "" }; };
    const out = await healOperation(op, inputs, { send, gate: g.gate, resolveRef, runTrigger: async (o2, in2) => { const r = await runTrigger(ctx, tab, o2.trigger, in2, { origin, abortWrites: false, trust }); cur = null; return r; }, now: new Date().toISOString() },
      args?.verifyInputs && typeof args.verifyInputs === "object" ? { verifyInputs: args.verifyInputs } : {});
    return { ...out, op: op.name };
  },
};

export default { name: "ops", ops };
