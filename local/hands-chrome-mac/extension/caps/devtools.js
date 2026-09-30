// @ts-check
// devtools: what Chrome's DevTools panel shows, as reads a model can ask for: the DOM of one node
// (html, attributes, box, computed and matched CSS, listeners), the scripts the page loaded and
// their source, the console, and the names of the page's cookies and storage.
//
// LAZY AND QUIET. A CDP domain costs the page something while it is enabled, so each group of
// domains is switched on the first time a reader needs it and switched off again after five
// minutes with no reader (one setTimeout per tab, no polling). Console and script rings fill only
// while a group is on.
//
// NOTHING RAW LEAVES. Every return path goes through shared/redact.js. Page HTML, script source,
// console text and eval results are page-controlled strings, so they are treated as hostile and
// as secret-bearing: they are redacted first and bounded after, so a cut can never leave half a
// token that no longer matches a pattern.

import * as redact from "../shared/redact.js";
import { classify } from "../shared/floor.js";
import { passwordFieldScript } from "../shared/guards.js";
import { guardInstall, guardCollect, held as heldRequest } from "../shared/outbound.js";
import { egressGuard } from "./net.js";
import { fail } from "../shared/proto.js";

const IDLE_MS = 5 * 60_000;
const HTML_MAX = 20_000;
const SOURCE_MAX = 200_000;
const CONSOLE_RING = 1000;
const SCRIPT_RING = 3000;
const PRECAP = 4;

const GROUPS = {
  console: { on: ["Runtime.enable", "Log.enable"], off: ["Log.disable", "Runtime.disable"] },
  sources: { on: ["Debugger.enable", "Debugger.setSkipAllPauses"], off: ["Debugger.disable"] },
  dom: { on: ["DOM.enable", "CSS.enable"], off: ["CSS.disable", "DOM.disable"] },
};
const GROUP_ARGS = { "Debugger.setSkipAllPauses": { skip: true } };

const STYLE_SUBSET = ["display", "position", "visibility", "opacity", "z-index", "width", "height", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "overflow", "pointer-events", "cursor", "flex-direction", "justify-content", "align-items", "grid-template-columns", "border-top-width", "border-top-style", "border-top-color", "transform", "top", "left"];

/** @typedef {{ enabled: Set<string>, pending: Map<string, Promise<void>>, scripts: any[], byId: Map<string, any>, console: any[], seq: number, timer: any }} TabState */
/** @type {WeakMap<object, { tabs: Map<number, TabState> }>} */
const perCtx = new WeakMap();

/** @param {string} code @param {string} [detail] */
function refuse(code, detail) {
  const error = fail(code, detail);
  return Object.assign(new Error(error.message), { code, error });
}

/** @param {any} ctx */
function root(ctx) {
  let r = perCtx.get(ctx);
  if (r) return r;
  r = { tabs: new Map() };
  perCtx.set(ctx, r);
  const tabs = r.tabs;
  ctx.cdp.on((/** @type {number} */ tab, /** @type {string} */ method, /** @type {any} */ params) => {
    const st = tabs.get(tab);
    if (!st) return;
    if (method === "Inspector.detached") return drop(tabs, tab);
    route(st, method, params || {});
  });
  return r;
}

/** @param {Map<number, TabState>} tabs @param {number} tab */
function drop(tabs, tab) {
  const st = tabs.get(tab);
  if (st) clearTimeout(st.timer);
  tabs.delete(tab);
}

/** @param {TabState} st @param {string} method @param {any} p */
function route(st, method, p) {
  // A page went away (navigation or reload): what it logged and loaded goes with it, so a page that
  // was blind for a moment leaves nothing behind in the rings (reviewer-2).
  if (method === "Runtime.executionContextsCleared") { st.scripts.length = 0; st.byId.clear(); st.console.length = 0; return; }
  if (method === "Debugger.scriptParsed") {
    if (st.byId.has(p.scriptId)) return;
    const rec = { scriptId: String(p.scriptId), rawUrl: String(p.url || ""), length: p.length ?? null, sourceMapURL: p.sourceMapURL ? String(p.sourceMapURL) : "", seq: ++st.seq };
    st.scripts.push(rec);
    st.byId.set(rec.scriptId, rec);
    if (st.scripts.length > SCRIPT_RING) st.byId.delete(st.scripts.shift().scriptId);
  } else if (method === "Runtime.consoleAPICalled") {
    const args = (p.args || []).map(serialize);
    const type = String(p.type || "log");
    push(st, { level: type === "warning" ? "warn" : type, source: "console", text: args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "), args, ts: p.timestamp ? Math.round(p.timestamp) : Date.now(), line: p.stackTrace?.callFrames?.[0] ? frame(p.stackTrace.callFrames[0]) : undefined });
  } else if (method === "Runtime.exceptionThrown") {
    const d = p.exceptionDetails || {};
    push(st, { level: "error", source: "exception", text: String(d.exception?.description || d.text || "exception"), ts: p.timestamp ? Math.round(p.timestamp) : Date.now(), line: d.url ? { url: d.url, line: d.lineNumber, column: d.columnNumber } : undefined });
  } else if (method === "Log.entryAdded") {
    const e = p.entry || {};
    const lvl = e.level === "verbose" ? "debug" : e.level === "warning" ? "warn" : String(e.level || "info");
    push(st, { level: lvl, source: "log:" + String(e.source || "other"), text: String(e.text || ""), ts: e.timestamp ? Math.round(e.timestamp) : Date.now(), line: e.url ? { url: e.url, line: e.lineNumber } : undefined });
  }
}

/** @param {any} f */
const frame = f => ({ url: f.url, line: f.lineNumber, column: f.columnNumber });

/** @param {TabState} st @param {any} e */
function push(st, e) {
  st.console.push({ seq: ++st.seq, ...e });
  if (st.console.length > CONSOLE_RING) st.console.shift();
}

/** A CDP RemoteObject as plain data. Objects with a preview become {name: value} so key-based redaction applies. @param {any} o @returns {any} */
function serialize(o) {
  if (!o) return null;
  if ("value" in o) return o.value;
  if (o.unserializableValue) return String(o.unserializableValue);
  if (o.preview?.properties) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const pr of o.preview.properties.slice(0, 30)) out[pr.name] = pr.type === "number" ? Number(pr.value) : pr.type === "boolean" ? pr.value === "true" : pr.value ?? pr.type;
    return out;
  }
  return o.description || o.className || o.type || "object";
}

/** @param {any} ctx @param {any} args @param {string} op @param {boolean} [acting] */
async function target(ctx, args, op, acting = false) {
  let tab = args?.tab;
  if (tab == null) {
    const a = await ctx.tabs.active();
    tab = a && typeof a === "object" ? a.id : a;
  }
  if (tab == null) throw refuse("no_tab");
  const f = await ctx.floorAllows(tab, op);
  if (!f || !f.allow) throw refuse("blocked", f?.why);
  if (acting && ctx.stopped()) throw refuse("stopped");
  return /** @type {number} */ (tab);
}

/** @param {any} ctx @param {number} tab */
async function attachOnce(ctx, tab) {
  const a = ctx.cdp.attached();
  const has = Array.isArray(a) ? a.includes(tab) : a instanceof Set ? a.has(tab) : false;
  if (!has) await ctx.cdp.attach(tab);
}

/** Switch a group on once (concurrent callers share the promise) and restart the idle clock. @param {any} ctx @param {number} tab @param {keyof typeof GROUPS} group */
async function ensure(ctx, tab, group) {
  const { tabs } = root(ctx);
  let st = tabs.get(tab);
  if (!st) {
    st = { enabled: new Set(), pending: new Map(), scripts: [], byId: new Map(), console: [], seq: 0, timer: null };
    tabs.set(tab, st);
  }
  const s = st;
  touch(ctx, tab, s);
  if (s.enabled.has(group)) return s;
  let p = s.pending.get(group);
  if (!p) {
    p = (async () => {
      await attachOnce(ctx, tab);
      for (const m of GROUPS[group].on) await ctx.cdp.send(tab, m, GROUP_ARGS[/** @type {keyof typeof GROUP_ARGS} */ (m)] || {});
      s.enabled.add(group);
    })().finally(() => s.pending.delete(group));
    s.pending.set(group, p);
  }
  await p;
  return s;
}

/** @param {any} ctx @param {number} tab @param {TabState} st */
function touch(ctx, tab, st) {
  clearTimeout(st.timer);
  st.timer = setTimeout(() => idleOff(ctx, tab, st), IDLE_MS);
  st.timer?.unref?.();
}

/** @param {any} ctx @param {number} tab @param {TabState} st */
async function idleOff(ctx, tab, st) {
  const groups = [...st.enabled];
  st.enabled.clear();
  st.scripts.length = 0;
  st.byId.clear();
  for (const g of groups) for (const m of GROUPS[/** @type {keyof typeof GROUPS} */ (g)].off) await Promise.resolve(ctx.cdp.send(tab, m, {})).catch(() => {});
}

/** @param {string} s @param {number} n */
function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s, truncated: false };
}

/** Page HTML: hidden and password inputs named like secrets lose their value attribute too. @param {string} html */
function redactHtml(html) {
  const cut = html.replace(/(<input\b[^>]*?(?:type\s*=\s*["']?password|name\s*=\s*["'][^"']*(?:token|csrf|xsrf|secret|pass|auth|key|session)[^"']*["'])[^>]*?\bvalue\s*=\s*)("[^"]*"|'[^']*')/gi, `$1"${redact.MASK}:input]"`);
  return redact.text(cut);
}

/** @param {any} ctx @param {number} tab @param {any} args */
async function nodeFor(ctx, tab, args) {
  const send = (/** @type {string} */ m, /** @type {any} */ p) => ctx.cdp.send(tab, m, p);
  if (args.nodeId != null) return Number(args.nodeId);
  if (args.backendNodeId != null) {
    const r = await send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [Number(args.backendNodeId)] });
    const id = r?.nodeIds?.[0];
    if (!id) throw refuse("not_found");
    return id;
  }
  if (typeof args.selector !== "string" || !args.selector) throw refuse("bad_request", "dev.inspect needs selector, nodeId or backendNodeId");
  const doc = await send("DOM.getDocument", { depth: 0 });
  const r = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: args.selector });
  if (!r?.nodeId) throw refuse("not_found");
  return r.nodeId;
}

/** @param {any} v */
const numList = v => Array.isArray(v) ? v : [];

/** @type {Record<string, (args: any, ctx: any) => Promise<any>>} */
const ops = {
  async "dev.inspect"(args, ctx) {
    const tab = await target(ctx, args, "dev.inspect");
    await ensure(ctx, tab, "dom");
    const send = (/** @type {string} */ m, /** @type {any} */ p) => ctx.cdp.send(tab, m, p);
    const nodeId = await nodeFor(ctx, tab, args || {});
    const [html, attrs, box, computed, matched] = await Promise.all([
      send("DOM.getOuterHTML", { nodeId }),
      send("DOM.getAttributes", { nodeId }),
      send("DOM.getBoxModel", { nodeId }).catch(() => null),
      send("CSS.getComputedStyleForNode", { nodeId }).catch(() => null),
      send("CSS.getMatchedStylesForNode", { nodeId }).catch(() => null),
    ]);
    const pre = String(html?.outerHTML ?? "").slice(0, HTML_MAX * PRECAP);
    const h = clip(redactHtml(pre), HTML_MAX);
    /** @type {Record<string, string>} */
    const attributes = {};
    const flat = numList(attrs?.attributes);
    for (let i = 0; i + 1 < flat.length; i += 2) attributes[flat[i]] = flat[i + 1];
    const want = args.styles === "all" ? null : new Set(Array.isArray(args.styles) ? args.styles : STYLE_SUBSET);
    const style = Object.fromEntries(numList(computed?.computedStyle).filter(x => !want || want.has(x.name)).map(x => [x.name, x.value]));
    const rules = numList(matched?.matchedCSSRules).slice(0, 50).map(m => ({
      selector: m.rule?.selectorList?.text ?? "",
      origin: m.rule?.origin ?? "",
      styleSheetId: m.rule?.style?.styleSheetId,
      properties: numList(m.rule?.style?.cssProperties).filter(p => p.name && p.value !== undefined && !p.disabled).map(p => ({ name: p.name, value: p.value })),
    }));
    let listeners = [];
    try {
      const o = await send("DOM.resolveNode", { nodeId });
      const objectId = o?.object?.objectId;
      if (objectId) {
        const l = await send("DOMDebugger.getEventListeners", { objectId });
        listeners = numList(l?.listeners).slice(0, 100).map(x => ({ type: x.type, useCapture: !!x.useCapture, passive: !!x.passive, once: !!x.once, scriptId: x.scriptId, line: x.lineNumber, column: x.columnNumber }));
        await send("Runtime.releaseObject", { objectId }).catch(() => {});
      }
    } catch { /* listeners are best effort */ }
    return redact.value({
      nodeId,
      outerHTML: h.text,
      truncated: h.truncated,
      attributes,
      boxModel: box?.model ?? null,
      computedStyle: style,
      matchedRules: rules,
      listeners,
    });
  },

  async "dev.sources.list"(args, ctx) {
    const tab = await target(ctx, args, "dev.sources.list");
    const st = await ensure(ctx, tab, "sources");
    const f = args?.filter;
    const needle = typeof f === "string" ? f : f?.url;
    const limit = Math.min(Number(args?.limit) || 200, 1000);
    const rows = st.scripts
      .filter(s => classify(s.rawUrl, undefined, {}).tier !== "blind")
      .filter(s => !needle || s.rawUrl.toLowerCase().includes(String(needle).toLowerCase()))
      .filter(s => !(f && typeof f === "object" && f.minSize) || (s.length ?? 0) >= f.minSize)
      .slice(-limit)
      .map(s => ({ scriptId: s.scriptId, url: redact.url(s.rawUrl), size: s.length, sourceMap: s.sourceMapURL ? mapName(s.sourceMapURL) : undefined }));
    return { count: rows.length, total: st.scripts.length, scripts: rows };
  },

  async "dev.sources.get"(args, ctx) {
    const tab = await target(ctx, args, "dev.sources.get");
    const st = await ensure(ctx, tab, "sources");
    const rec = scriptRec(st, args);
    const r = await ctx.cdp.send(tab, "Debugger.getScriptSource", { scriptId: rec.scriptId });
    let src = String(r?.scriptSource ?? "");
    const total = src.length;
    let sliced = false;
    if (args.range && (args.range.startLine != null || args.range.endLine != null)) {
      const lines = src.split("\n");
      const a = Math.max(1, Number(args.range.startLine) || 1);
      const b = Math.min(lines.length, Number(args.range.endLine) || lines.length);
      src = lines.slice(a - 1, b).join("\n");
      sliced = true;
    }
    const c = clip(redact.text(src.slice(0, SOURCE_MAX * PRECAP)), SOURCE_MAX);
    return { scriptId: rec.scriptId, url: redact.url(rec.rawUrl), length: total, ranged: sliced, source: c.text, truncated: c.truncated || src.length > SOURCE_MAX * PRECAP };
  },

  async "dev.sources.search"(args, ctx) {
    const tab = await target(ctx, args, "dev.sources.search");
    const st = await ensure(ctx, tab, "sources");
    if (typeof args?.query !== "string" || !args.query) throw refuse("bad_request", "query is required");
    const max = Math.min(Number(args.limit) || 100, 500);
    const list = args.scriptId ? [scriptRec(st, args)] : st.scripts.slice(-300);
    const matches = [];
    for (const s of list) {
      if (matches.length >= max) break;
      const r = await ctx.cdp.send(tab, "Debugger.searchInContent", { scriptId: s.scriptId, query: args.query, isRegex: !!args.regex, caseSensitive: !!args.caseSensitive }).catch(() => null);
      for (const m of numList(r?.result)) {
        if (matches.length >= max) break;
        matches.push({ scriptId: s.scriptId, url: redact.url(s.rawUrl), line: m.lineNumber, text: redact.text(clip(m.lineContent, 300).text) });
      }
    }
    return { count: matches.length, truncated: matches.length >= max, matches };
  },

  async "dev.console.read"(args, ctx) {
    const tab = await target(ctx, args, "dev.console.read");
    const st = await ensure(ctx, tab, "console");
    const since = Number(args?.since) || 0;
    const levels = args?.level ? new Set([].concat(args.level)) : null;
    const limit = Math.min(Number(args?.limit) || 100, CONSOLE_RING);
    const rows = st.console
      .filter(e => (since >= 1e11 ? e.ts > since : e.seq > since) && (!levels || levels.has(e.level)))
      .slice(-limit)
      .map(e => redact.value({ seq: e.seq, ts: e.ts, level: e.level, source: e.source, ...shown(e), at: e.line ? { ...e.line, url: e.line.url ? redact.url(e.line.url) : undefined } : undefined }));
    return { count: rows.length, last: st.seq, entries: rows };
  },

  async "dev.console.eval"(args, ctx) {
    const tab = await target(ctx, args, "dev.console.eval", true);
    if (typeof args?.expression !== "string" || !args.expression) throw refuse("bad_request", "expression is required");
    await ensure(ctx, tab, "console");
    // Same invisible rule as page.eval: a script is not run on a page with a visible password field.
    const pw = await ctx.cdp.send(tab, "Runtime.evaluate", { expression: passwordFieldScript, returnByValue: true });
    if (pw && pw.result && pw.result.value === true) throw refuse("blocked", "this page has a password field, so a script is not run on it");
    const guarded = args.asked !== true;
    const egress = guarded ? await egressGuard(ctx, tab) : null;
    if (guarded) await ctx.cdp.send(tab, "Runtime.evaluate", { expression: guardInstall, returnByValue: true });
    /** @type {any} */ let r;
    /** @type {any[]} */ let blocked = [];
    /** @type {any[]} */ let outside = [];
    try { r = await ctx.cdp.send(tab, "Runtime.evaluate", { expression: args.expression, returnByValue: true, awaitPromise: true, generatePreview: true, timeout: 5000, userGesture: false, replMode: true }); }
    finally {
      if (guarded) { const c = await ctx.cdp.send(tab, "Runtime.evaluate", { expression: guardCollect, returnByValue: true }).catch(() => null); blocked = (c && c.result && c.result.value) || []; }
      if (egress) outside = await egress.stop().catch(() => []);
    }
    if (outside.length) { const b = outside[0]; return heldRequest(b.method, b.origin, `the script tried to reach ${b.origin}, which is not this page or anything it already talks to`, `${args.expression}\n${b.method} ${b.origin}`); }
    if (blocked.length) { const b = blocked[0]; return heldRequest(b.method, b.url, b.why, `${args.expression}\n${b.method} ${b.url}`); }
    if (r?.exceptionDetails) return redact.value({ ok: false, error: clip(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "error"), 4000).text });
    const o = r?.result || {};
    const v = "value" in o ? o.value : o.unserializableValue ?? o.description ?? o.type;
    return redact.value({ ok: true, type: o.type, value: typeof v === "string" ? clip(v, 20_000).text : v, ...(egress && egress.contained === "partial" ? { contained: "partial", containedWhy: egress.why || "no browser-level guard" } : {}) });
  },

  async "dev.state"(args, ctx) {
    const tab = await target(ctx, args, "dev.state");
    await attachOnce(ctx, tab);
    const c = await ctx.cdp.send(tab, "Network.getCookies", {});
    const r = await ctx.cdp.send(tab, "Runtime.evaluate", { expression: "(()=>{const d=s=>{try{return Object.fromEntries(Object.keys(s).map(k=>[k,s.getItem(k)]))}catch{return {}}};return {origin:location.origin,local:d(localStorage),session:d(sessionStorage)}})()", returnByValue: true });
    const v = r?.result?.value || {};
    return { origin: v.origin ? redact.url(v.origin) : undefined, cookies: redact.cookies(c?.cookies), localStorage: redact.storage(v.local), sessionStorage: redact.storage(v.session) };
  },
};

/** Console text is rebuilt from the REDACTED args so a secret-named key in an object argument is masked in the text too. @param {any} e */
function shown(e) {
  if (!e.args) return { text: redact.text(clip(e.text, 4000).text) };
  const args = redact.value(e.args);
  return { text: clip(args.map((/** @type {any} */ a) => typeof a === "string" ? a : JSON.stringify(a)).join(" "), 4000).text, args };
}

/** @param {TabState} st @param {any} args */
function scriptRec(st, args) {
  const rec = args?.scriptId != null ? st.byId.get(String(args.scriptId)) : args?.url ? [...st.scripts].reverse().find(s => s.rawUrl === args.url || redact.url(s.rawUrl) === args.url) : null;
  if (!rec) throw refuse("not_found", "no such script (list scripts first)");
  return rec;
}

/** A source map's file name only, never its query or an inline data URL. @param {string} u */
function mapName(u) {
  if (/^data:/i.test(u)) return "(inline)";
  const p = u.split(/[?#]/)[0];
  return redact.text(p.slice(p.lastIndexOf("/") + 1));
}

export default {
  name: "dev",
  ops,
  /** Tab gone: forget its rings and timer. @param {any} evt @param {any} ctx */
  onEvent(evt, ctx) {
    const kind = String(evt?.event ?? evt?.type ?? "");
    const tab = evt?.tab ?? evt?.tabId;
    if (tab != null && /remov|clos|detach/i.test(kind)) drop(root(ctx).tabs, tab);
  },
};
