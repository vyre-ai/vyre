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
//
// FRAMES. A cross-origin iframe (nested too) is its own CDP session. The console and sources groups are switched on
// for every child session as well (and for ones that attach later), so the rings hold what the frames logged and
// loaded; each entry carries `frame` (the origin it came from) and readers take a `frame` filter. A script id is
// per session, so a child's script is addressed as "<session>:<id>". dev.inspect and dev.console.eval take a `frame`
// and run in that frame's session (or its execution context, for a same-process frame).

import * as redact from "../shared/redact.js";
import { classify } from "../shared/floor.js";
import { passwordFieldScript, CREDENTIAL_STORE } from "../shared/guards.js";
import { guardInstallWrites, guardCollect, held as heldRequest } from "../shared/outbound.js";
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

/** @typedef {{ enabled: Set<string>, pending: Map<string, Promise<void>>, scripts: any[], byId: Map<string, any>, console: any[], seq: number, timer: any, on: Set<string>, topOrigin: string }} TabState */
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
  ctx.cdp.on((/** @type {number} */ tab, /** @type {string} */ method, /** @type {any} */ params, /** @type {string|undefined} */ session) => {
    const st = tabs.get(tab);
    if (!st) return;
    if (method === "Inspector.detached") { if (!session) drop(tabs, tab); return; }
    route(ctx, tab, st, method, params || {}, session || undefined);
  });
  return r;
}

/** @param {Map<number, TabState>} tabs @param {number} tab */
function drop(tabs, tab) {
  const st = tabs.get(tab);
  if (st) clearTimeout(st.timer);
  tabs.delete(tab);
}

/** An origin from a url, or "". @param {string} u */
const originOf = u => { try { const o = new URL(String(u)).origin; return o === "null" ? "" : o; } catch { return ""; } };

/** A child session worth reading: a frame. @param {any} k */
const isFrameTarget = k => k && (k.type === "iframe" || k.type === "page");

/** The origin of the frame a session belongs to: a child's target url (lib/cdp.js keeps it current), or the tab's top page. @param {any} ctx @param {number} tab @param {TabState} st @param {string|undefined} session */
function frameOfSession(ctx, tab, st, session) {
  if (!session) return st.topOrigin;
  const k = typeof ctx.cdp.children === "function" ? ctx.cdp.children(tab).find((/** @type {any} */ c) => c.sessionId === session) : null;
  return originOf(k ? k.url : "");
}

/** Drop what one session holds in the rings. @param {TabState} st @param {string} session */
function dropSession(st, session) {
  st.scripts = st.scripts.filter(s => { if (s.session === session) { st.byId.delete(s.scriptId); return false; } return true; });
  st.console = st.console.filter(e => e.session !== session);
}

/** @param {any} ctx @param {number} tab @param {TabState} st @param {string} method @param {any} p @param {string} [session] */
function route(ctx, tab, st, method, p, session) {
  if (method === "Target.attachedToTarget") {
    // A frame that attaches later gets the same groups the tab has on.
    if (p.sessionId && isFrameTarget(p.targetInfo)) for (const g of st.enabled) if (g !== "dom") void enableOn(ctx, tab, st, /** @type {keyof typeof GROUPS} */ (g), p.sessionId);
    return;
  }
  if (method === "Target.detachedFromTarget") { if (p.sessionId) for (const k of [...st.on]) if (k.endsWith("|" + p.sessionId)) st.on.delete(k); return; }
  // A page went away (navigation or reload): what it logged and loaded goes with it, so a page that
  // was blind for a moment leaves nothing behind in the rings (reviewer-2). A child frame clears only its own.
  if (method === "Runtime.executionContextsCleared") { if (session) return dropSession(st, session); st.scripts.length = 0; st.byId.clear(); st.console.length = 0; return; }
  const frame = frameOfSession(ctx, tab, st, session);
  const where = { ...(session ? { session } : {}), ...(frame ? { frame } : {}) };
  if (method === "Debugger.scriptParsed") {
    const id = session ? `${session}:${p.scriptId}` : String(p.scriptId);
    if (st.byId.has(id)) return;
    const rec = { scriptId: id, rawScriptId: String(p.scriptId), ...where, rawUrl: String(p.url || ""), length: p.length ?? null, sourceMapURL: p.sourceMapURL ? String(p.sourceMapURL) : "", seq: ++st.seq };
    st.scripts.push(rec);
    st.byId.set(rec.scriptId, rec);
    if (st.scripts.length > SCRIPT_RING) st.byId.delete(st.scripts.shift().scriptId);
  } else if (method === "Runtime.consoleAPICalled") {
    const args = (p.args || []).map(serialize);
    const type = String(p.type || "log");
    push(st, { ...where, level: type === "warning" ? "warn" : type, source: "console", text: args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "), args, ts: p.timestamp ? Math.round(p.timestamp) : Date.now(), line: p.stackTrace?.callFrames?.[0] ? frame(p.stackTrace.callFrames[0]) : undefined });
  } else if (method === "Runtime.exceptionThrown") {
    const d = p.exceptionDetails || {};
    push(st, { ...where, level: "error", source: "exception", text: String(d.exception?.description || d.text || "exception"), ts: p.timestamp ? Math.round(p.timestamp) : Date.now(), line: d.url ? { url: d.url, line: d.lineNumber, column: d.columnNumber } : undefined });
  } else if (method === "Log.entryAdded") {
    const e = p.entry || {};
    const lvl = e.level === "verbose" ? "debug" : e.level === "warning" ? "warn" : String(e.level || "info");
    push(st, { ...where, level: lvl, source: "log:" + String(e.source || "other"), text: String(e.text || ""), ts: e.timestamp ? Math.round(e.timestamp) : Date.now(), line: e.url ? { url: e.url, line: e.lineNumber } : undefined });
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
    st = { enabled: new Set(), pending: new Map(), scripts: [], byId: new Map(), console: [], seq: 0, timer: null, on: new Set(), topOrigin: "" };
    tabs.set(tab, st);
  }
  const s = st;
  touch(ctx, tab, s);
  if (!s.enabled.has(group)) {
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
  }
  if (group !== "dom") {
    // Every frame the tab has now (cdp.children), and the top page's own origin for tagging.
    try { const tb = await ctx.tabs.get(tab); s.topOrigin = originOf(tb && (tb.url || tb.pendingUrl)); } catch { /* the tab went away */ }
    const kids = typeof ctx.cdp.children === "function" ? ctx.cdp.children(tab) : [];
    await Promise.all(kids.filter(isFrameTarget).map((/** @type {any} */ k) => enableOn(ctx, tab, s, group, k.sessionId)));
  }
  return s;
}

/** Switch a group on for one child session, once. @param {any} ctx @param {number} tab @param {TabState} st @param {keyof typeof GROUPS} group @param {string} session */
async function enableOn(ctx, tab, st, group, session) {
  const key = `${group}|${session}`;
  if (st.on.has(key)) return;
  st.on.add(key);
  try { for (const m of GROUPS[group].on) await ctx.cdp.send(tab, m, GROUP_ARGS[/** @type {keyof typeof GROUP_ARGS} */ (m)] || {}, session); }
  catch { st.on.delete(key); /* gone, or not ours: tried again on the next read */ }
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
  const kids = [...st.on];
  st.on.clear();
  for (const k of kids) {
    const [g, session] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    for (const m of GROUPS[/** @type {keyof typeof GROUPS} */ (g)].off) await Promise.resolve(ctx.cdp.send(tab, m, {}, session)).catch(() => {});
  }
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

/**
 * The frame a caller named, as a lib/frames.js Frame; null for the top page (the default).
 * @param {any} ctx @param {number} tab @param {unknown} ref
 */
async function frameFor(ctx, tab, ref) {
  if (ref === undefined || ref === null || ref === "" || ref === "top" || ref === "main" || ref === 0 || ref === "0") return null;
  const frames = ctx.frames && typeof ctx.frames.list === "function" ? await ctx.frames.list(tab) : [];
  if (!frames.length) throw refuse("bad_request", "this tab's frames cannot be listed, so a frame cannot be chosen");
  const f = ctx.frames.pickFrom(frames, ref);
  if (!f) throw refuse("not_found", `no frame matches ${JSON.stringify(ref)}; the frames are ${frames.map((/** @type {any} */ x) => `${x.index} ${x.origin || "top"}`).join(", ")}`);
  if (!f.readable) throw refuse("not_found", `frame ${f.index} (${f.origin || "?"}) is not readable: ${f.why || "it has gone"}`);
  return f.how === "top" ? null : f;
}

/** Run a script in a frame (null: the top page). @param {any} ctx @param {number} tab @param {any} frame @param {string} expression @param {any} [params] */
const runIn = (ctx, tab, frame, expression, params = {}) => (frame && ctx.frames ? ctx.frames.evalIn(tab, frame, expression, params) : ctx.cdp.send(tab, "Runtime.evaluate", { expression, ...params }));

/** @param {any} ctx @param {number} tab @param {any} args @param {any} [frame] */
async function nodeFor(ctx, tab, args, frame) {
  const session = frame && frame.how === "session" ? frame.session : undefined;
  const send = (/** @type {string} */ m, /** @type {any} */ p) => (session ? ctx.cdp.send(tab, m, p, session) : ctx.cdp.send(tab, m, p));
  if (args.nodeId != null) return Number(args.nodeId);
  if (args.backendNodeId != null) {
    const r = await send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [Number(args.backendNodeId)] });
    const id = r?.nodeIds?.[0];
    if (!id) throw refuse("not_found");
    return id;
  }
  if (typeof args.selector !== "string" || !args.selector) throw refuse("bad_request", "dev.inspect needs selector, nodeId or backendNodeId");
  const doc = await send("DOM.getDocument", { depth: 0 });
  if (frame && frame.how === "context") {
    // A same-process frame: find the element in that frame's own context, then hand it to the DOM domain as a node.
    const o = await runIn(ctx, tab, frame, `document.querySelector(${JSON.stringify(args.selector)})`, {});
    const objectId = o && o.result && o.result.objectId;
    if (!objectId) throw refuse("not_found");
    const n = await send("DOM.requestNode", { objectId });
    if (!n || !n.nodeId) throw refuse("not_found");
    return n.nodeId;
  }
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
    const st0 = await ensure(ctx, tab, "dom");
    const frame = await frameFor(ctx, tab, args?.frame);
    const session = frame && frame.how === "session" ? frame.session : undefined;
    if (session) await enableOn(ctx, tab, st0, "dom", session);
    const send = (/** @type {string} */ m, /** @type {any} */ p) => (session ? ctx.cdp.send(tab, m, p, session) : ctx.cdp.send(tab, m, p));
    const nodeId = await nodeFor(ctx, tab, args || {}, frame);
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
      ...(frame ? { frame: frame.index, frameOrigin: frame.origin } : {}),
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
    const fneedle = args?.frame != null && args.frame !== "" ? String(args.frame).toLowerCase() : (f && typeof f === "object" && f.frame ? String(f.frame).toLowerCase() : "");
    const rows = st.scripts
      .filter(s => classify(s.rawUrl, undefined, {}).tier !== "blind")
      .filter(s => !fneedle || String(s.frame || "").toLowerCase().includes(fneedle))
      .filter(s => !needle || s.rawUrl.toLowerCase().includes(String(needle).toLowerCase()))
      .filter(s => !(f && typeof f === "object" && f.minSize) || (s.length ?? 0) >= f.minSize)
      .slice(-limit)
      .map(s => ({ scriptId: s.scriptId, ...(s.frame ? { frame: s.frame } : {}), url: redact.url(s.rawUrl), size: s.length, sourceMap: s.sourceMapURL ? mapName(s.sourceMapURL) : undefined }));
    return { count: rows.length, total: st.scripts.length, scripts: rows };
  },

  async "dev.sources.get"(args, ctx) {
    const tab = await target(ctx, args, "dev.sources.get");
    const st = await ensure(ctx, tab, "sources");
    const rec = scriptRec(st, args);
    const r = await sendTo(ctx, tab, rec.session, "Debugger.getScriptSource", { scriptId: rec.rawScriptId ?? rec.scriptId });
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
    return { scriptId: rec.scriptId, ...(rec.frame ? { frame: rec.frame } : {}), url: redact.url(rec.rawUrl), length: total, ranged: sliced, source: c.text, truncated: c.truncated || src.length > SOURCE_MAX * PRECAP };
  },

  async "dev.sources.search"(args, ctx) {
    const tab = await target(ctx, args, "dev.sources.search");
    const st = await ensure(ctx, tab, "sources");
    if (typeof args?.query !== "string" || !args.query) throw refuse("bad_request", "query is required");
    const max = Math.min(Number(args.limit) || 100, 500);
    const fneedle = args?.frame != null && args.frame !== "" ? String(args.frame).toLowerCase() : "";
    const list = args.scriptId ? [scriptRec(st, args)] : st.scripts.filter(s => !fneedle || String(s.frame || "").toLowerCase().includes(fneedle)).slice(-300);
    const matches = [];
    for (const s of list) {
      if (matches.length >= max) break;
      const r = await sendTo(ctx, tab, s.session, "Debugger.searchInContent", { scriptId: s.rawScriptId ?? s.scriptId, query: args.query, isRegex: !!args.regex, caseSensitive: !!args.caseSensitive }).catch(() => null);
      for (const m of numList(r?.result)) {
        if (matches.length >= max) break;
        matches.push({ scriptId: s.scriptId, ...(s.frame ? { frame: s.frame } : {}), url: redact.url(s.rawUrl), line: m.lineNumber, text: redact.text(clip(m.lineContent, 300).text) });
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
    const fneedle = args?.frame != null && args.frame !== "" ? String(args.frame).toLowerCase() : "";
    const rows = st.console
      .filter(e => (since >= 1e11 ? e.ts > since : e.seq > since) && (!levels || levels.has(e.level)))
      .filter(e => !fneedle || String(e.frame || "").toLowerCase().includes(fneedle))
      .slice(-limit)
      .map(e => redact.value({ seq: e.seq, ts: e.ts, level: e.level, source: e.source, ...(e.frame ? { frame: e.frame } : {}), ...shown(e), at: e.line ? { ...e.line, url: e.line.url ? redact.url(e.line.url) : undefined } : undefined }));
    return { count: rows.length, last: st.seq, entries: rows };
  },

  async "dev.console.eval"(args, ctx, trust = {}) {
    const tab = await target(ctx, args, "dev.console.eval", true);
    if (typeof args?.expression !== "string" || !args.expression) throw refuse("bad_request", "expression is required");
    await ensure(ctx, tab, "console");
    // Same invisible rule as page.eval: a script is not run on a page with a visible password field, and that means every frame
    // of the tab Vyre can read (a login form in an iframe counts). A frame Vyre cannot read is blind here, as a closed shadow root always was.
    const frame = await frameFor(ctx, tab, args?.frame);
    const all = ctx.frames && typeof ctx.frames.list === "function" ? await ctx.frames.list(tab).catch(() => []) : [];
    for (const f of all.length ? all.filter((/** @type {any} */ x) => x.readable) : [null]) {
      /** @type {any} */ let pw;
      try { pw = await runIn(ctx, tab, f && f.how !== "top" ? f : null, passwordFieldScript, { returnByValue: true }); }
      catch (e) { throw refuse("blocked", `could not check frame ${f ? f.index : 0} (${(f && f.origin) || "top"}) for a password field, so a script is not run on this page: ${String(/** @type {any} */ (e)?.message || e).slice(0, 100)}`); }
      if (pw && pw.result && pw.result.value === true) throw refuse("blocked", !f || f.index === 0 ? "this page has a password field, so a script is not run on it" : `frame ${f.index} (${f.origin || "?"}) has a password field, so a script is not run on this page`);
    }
    if (CREDENTIAL_STORE.test(String(args.expression))) throw refuse("blocked", "the script reads the page's stored login (IndexedDB or storage auth tokens). Vyre does not hand a login to a script, and a script should not hold one. Use chrome_api (action \"call\"): it signs the request with the page's own login inside the page, and the token is never in your hands. Prefer api.call over eval-fetch.");
    const guarded = trust.asked !== true;
    const egress = guarded ? await egressGuard(ctx, tab) : null;
    // The send-hold shim goes into the SAME frame as the script, and is read back from there.
    if (guarded) await runIn(ctx, tab, frame, `window.__vyreAllow = ${JSON.stringify(egress && egress.allowed || [])};` + guardInstallWrites, { returnByValue: true });
    /** @type {any} */ let r;
    /** @type {any[]} */ let blocked = [];
    /** @type {any[]} */ let outside = [];
    try { r = await runIn(ctx, tab, frame, args.expression, { returnByValue: true, awaitPromise: true, generatePreview: true, timeout: 5000, userGesture: false, replMode: true }); }
    finally {
      if (guarded) { const c = await runIn(ctx, tab, frame, guardCollect, { returnByValue: true }).catch(() => null); const bv = c && c.result && c.result.value; blocked = Array.isArray(bv) ? bv : []; }
      if (egress) outside = await egress.stop().catch(() => []);
    }
    if (outside.length) { const b = outside[0]; return heldRequest(b.method, b.origin, (b.method === "GUARD" ? `${b.origin}. A request MAY HAVE BEEN SENT` : `the script tried to reach ${b.origin}, which is not this page or anything it already talks to${b.leaked ? ". The request could not be stopped in time and MAY HAVE BEEN SENT" : ""}`), `${args.expression}\n${b.method} ${b.origin}`); }
    const wrote = blocked.find(b => b.write);
    if (wrote) throw refuse("blocked", `the script tried to ${wrote.method} ${redact.url(wrote.url)} with the page's own login. Nothing was sent. A script may read with the page's login but not write with it: use chrome_api (action "call"), which makes the same request from inside the page, names it, and is asked first. Prefer api.call over eval-fetch.`);
    if (blocked.length) { const b = blocked[0]; return heldRequest(b.method, b.url, b.why, `${args.expression}\n${b.method} ${b.url}`); }
    if (r?.exceptionDetails) return redact.value({ ok: false, error: clip(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "error"), 4000).text });
    const o = r?.result || {};
    const v = "value" in o ? o.value : o.unserializableValue ?? o.description ?? o.type;
    return redact.value({ ok: true, ...(frame ? { frame: frame.index, frameOrigin: frame.origin } : {}), type: o.type, value: typeof v === "string" ? clip(v, 20_000).text : v, ...(egress && egress.contained === "partial" ? { contained: "partial", containedWhy: egress.why || "no browser-level guard" } : {}) });
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

/** Send into a child session, or the tab's own when there is none. @param {any} ctx @param {number} tab @param {string|undefined} session @param {string} method @param {any} params */
const sendTo = (ctx, tab, session, method, params) => (session ? ctx.cdp.send(tab, method, params, session) : ctx.cdp.send(tab, method, params));

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
