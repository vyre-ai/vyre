// @ts-check
// frames: a tab is not one document. A modern app (GoHighLevel's workflow builder, embedded editors, payment forms) lives in iframes,
// often cross-origin ones that run in their own process. This is the one place that knows how to see them all:
//
//   list(tabId)               every frame of the tab, in tree order: {index, frameId, parentId, depth, url, origin, session, how, readable}
//   evalIn(tabId, frame, js)  Runtime.evaluate inside ONE frame (its own session if it is a separate process, else its own execution context)
//   offset(tabId, frame)      where that frame's viewport starts inside the top page's viewport, so a click found in a frame lands right
//   pick(tabId, ref)          a frame from what a model says: an index, a frame id, or a piece of the origin or URL
//
// A frame is `readable` when a script can run in it (its session is attached, or it shares the top page's process). A frame that is
// not (a session that failed to attach, or one that has gone) is listed as unreadable with the reason, never left out: the caller says
// so, so a snapshot can never silently be only the shell (real-use finding: the workflow builder is a cross-origin iframe).
//
// Chrome hands out a cross-origin iframe's session through Target.setAutoAttach (lib/cdp.js keeps them). An iframe target's targetId is the
// frame's own id, which is how a frame from Page.getFrameTree is matched to its session.

import { err } from "./err.js";

/** @typedef {{ index: number, frameId: string, parentId: string|null, depth: number, url: string, origin: string, name: string, session: string|null, how: "top"|"session"|"context"|"none", readable: boolean, why?: string }} Frame */

/** @param {any} f */
const originOf = f => { const o = String((f && f.securityOrigin) || ""); if (o && o !== "://" && o !== "null") return o; try { return new URL(String(f && f.url)).origin; } catch { return ""; } };

/**
 * @param {{ cdp: any }} o
 */
export function createFrames({ cdp }) {
  /** Execution contexts of same-process frames, by tab, hosting session ("" is the top page's own) and frame id. @type {Map<number, Map<string, Map<string, number>>>} */
  const contexts = new Map();
  /** @type {Set<string>} "<tab>:<session>" pairs whose Runtime is enabled for us */
  const runtimeOn = new Set();

  cdp.on((/** @type {number} */ tabId, /** @type {string} */ method, /** @type {any} */ p, /** @type {string|undefined} */ sessionId) => {
    const key = sessionId || "";
    if (method === "Runtime.executionContextCreated" && p && p.context && p.context.auxData && p.context.auxData.isDefault && p.context.auxData.frameId) {
      const tab = contexts.get(tabId) || new Map(); const bySession = tab.get(key) || new Map();
      bySession.set(String(p.context.auxData.frameId), p.context.id); tab.set(key, bySession); contexts.set(tabId, tab);
    } else if (method === "Runtime.executionContextDestroyed" && p) {
      for (const bySession of contexts.get(tabId)?.values() || []) for (const [f, id] of bySession) if (id === p.executionContextId) bySession.delete(f);
    } else if (method === "Runtime.executionContextsCleared") contexts.get(tabId)?.delete(key);
  });

  /** @param {number} tabId @param {string} [sessionId] */
  async function ensureRuntime(tabId, sessionId) {
    const k = `${tabId}:${sessionId || ""}`;
    if (runtimeOn.has(k)) return;
    runtimeOn.add(k);
    try { await cdp.send(tabId, "Runtime.enable", {}, sessionId); } catch { runtimeOn.delete(k); }
  }

  /** The iframe elements a document holds, so an iframe that never became a frame we can reach is still reported. */
  const IFRAMES = "(() => [...document.querySelectorAll('iframe, frame')].slice(0, 60).map(f => { let o = ''; try { o = new URL(f.getAttribute('src') || 'about:blank', location.href).origin; } catch (e) {} const r = f.getBoundingClientRect(); return { src: (f.getAttribute('src') || '').slice(0, 200), origin: o, sandbox: f.hasAttribute('sandbox'), w: Math.round(r.width), h: Math.round(r.height) }; }))()";

  /** @param {number} tabId @returns {Promise<Frame[]>} */
  async function list(tabId) {
    await ensureRuntime(tabId);
    const t = await cdp.send(tabId, "Page.getFrameTree", {});
    const kids = /** @type {Array<{ sessionId: string, targetId: string, type: string, url: string, parentFrameId?: string }>} */ (cdp.children(tabId)).filter(k => k.type === "iframe" || k.type === "page");
    // Chrome's top session lists only the frames in its own process. A cross-origin iframe is its own process with its own session and
    // its own tree (whose root is the iframe's frame): read each and graft it under the frame that owns it.
    /** @type {Array<{ session: string|null, tree: any }>} */
    const trees = [{ session: null, tree: t && t.frameTree }];
    // The trees are taken in the ORDER THE SESSIONS ATTACHED, whatever order they answer in: when a frame has been replaced (a navigation gave it a new session while the old one
    // lingers for a moment and still names the same frame id), the newest session wins. A session that answered last must never be the one input is sent to.
    const answers = await Promise.all(kids.map(async k => {
      await ensureRuntime(tabId, k.sessionId);
      try { const r = await cdp.send(tabId, "Page.getFrameTree", {}, k.sessionId); return r && r.frameTree ? { session: k.sessionId, tree: r.frameTree } : null; } catch { return null; /* the session went away */ }
    }));
    for (const a of answers) if (a) trees.push(a);
    /** @type {Map<string, { node: any, session: string|null, parentId: string|null }>} */ const all = new Map();
    /** @param {any} node @param {string|null} session @param {string|null} parentId */
    const collect = (node, session, parentId) => { const f = node.frame || {}; all.set(String(f.id), { node, session, parentId: parentId ?? (f.parentId ? String(f.parentId) : null) }); for (const c of node.childFrames || []) collect(c, session, String(f.id)); };
    collect(/** @type {any} */ (trees[0].tree), null, null);
    for (const tr of trees.slice(1)) {
      const root = tr.tree.frame || {};
      const k = kids.find(x => x.sessionId === tr.session);
      const parent = root.parentId ? String(root.parentId) : k && k.parentFrameId ? String(k.parentFrameId) : null;
      collect(tr.tree, tr.session, parent);
    }
    // Build one ordered tree: children by parent id; a subtree whose parent is not known hangs under the top page (never dropped).
    const topId = String(trees[0].tree && trees[0].tree.frame && trees[0].tree.frame.id);
    /** @type {Map<string, string[]>} */ const byParent = new Map();
    for (const [id, v] of all) { if (id === topId) continue; const p = v.parentId && all.has(v.parentId) ? v.parentId : topId; byParent.set(p, [...(byParent.get(p) || []), id]); }
    /** @type {Frame[]} */ const out = [];
    /** @param {string} id @param {string|null} parentId @param {number} depth */
    const walk = (id, parentId, depth) => {
      const v = /** @type {any} */ (all.get(id)); const f = v.node.frame || {};
      const isChildRoot = v.session !== null && !!kids.find(k => k.sessionId === v.session && k.targetId === id);
      const ctx = contexts.get(tabId)?.get(v.session || "")?.get(id);
      /** @type {Frame["how"]} */ let how = "none"; let readable = false; /** @type {string|undefined} */ let why;
      if (depth === 0) { how = "top"; readable = true; }
      else if (isChildRoot) { how = "session"; readable = true; }
      else if (ctx !== undefined) { how = "context"; readable = true; }
      else { why = "no way into this frame yet: Chrome has not given a script context for it (still loading, or it never attached)"; }
      out.push({ index: out.length, frameId: id, parentId, depth, url: String(f.url || ""), origin: originOf(f), name: String(f.name || ""), session: v.session, how, readable, ...(why ? { why } : {}) });
      for (const c of byParent.get(id) || []) walk(c, id, depth + 1);
    };
    walk(topId, null, 0);
    // An iframe ELEMENT in a readable frame that matches no frame we found is an iframe we cannot reach: say so, never leave it out.
    const known = out.slice();
    for (const f of known) {
      if (!f.readable) continue;
      let els = /** @type {any[]} */ ([]);
      try { const r = await evalIn(tabId, f, IFRAMES, { returnByValue: true }); const v = r && r.result && r.result.value; els = Array.isArray(v) ? v : []; } catch { continue; }
      const mine = known.filter(x => x.parentId === f.frameId);
      const used = new Set();
      for (const el of els) {
        const hit = mine.find(x => !used.has(x.frameId) && (x.origin === el.origin || (el.origin === "null" && x.origin === "null") || (el.sandbox && x.origin === "null")));
        if (hit) { used.add(hit.frameId); continue; }
        out.push({ index: out.length, frameId: `element:${f.frameId}:${out.length}`, parentId: f.frameId, depth: f.depth + 1, url: el.src || "", origin: el.origin || "", name: "", session: null, how: "none", readable: false, why: `an iframe (${el.origin || "no address"}${el.sandbox ? ", sandboxed" : ""}, ${el.w}x${el.h}) is on the page but Chrome has given no frame or session for it` });
      }
    }
    return out;
  }

  /**
   * A frame from what a caller said: a number (its index in list()), a frame id, "top"/"main", or a piece of its origin or URL.
   * @param {Frame[]} frames @param {unknown} ref @returns {Frame|null}
   */
  function pickFrom(frames, ref) {
    if (ref === undefined || ref === null || ref === "" || ref === "top" || ref === "main") return frames[0] || null;
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) return frames[Number(ref)] || null;
    const r = String(ref);
    return frames.find(f => f.frameId === r) || frames.find(f => f.origin === r) || frames.find(f => f.url.includes(r) || f.origin.includes(r)) || null;
  }
  const pick = async (/** @type {number} */ tabId, /** @type {unknown} */ ref) => pickFrom(await list(tabId), ref);

  /**
   * Run an expression inside one frame. `frame` is a Frame from list(), or omitted for the top page.
   * @param {number} tabId @param {Frame|null|undefined} frame @param {string} expression @param {any} [extra] Runtime.evaluate parameters
   */
  async function evalIn(tabId, frame, expression, extra = {}) {
    if (!frame || frame.how === "top") return cdp.send(tabId, "Runtime.evaluate", { expression, ...extra });
    if (frame.how === "session" && frame.session) return cdp.send(tabId, "Runtime.evaluate", { expression, ...extra }, frame.session);
    if (frame.how === "context") {
      const id = contexts.get(tabId)?.get(frame.session || "")?.get(frame.frameId);
      if (id !== undefined) return cdp.send(tabId, "Runtime.evaluate", { expression, contextId: id, ...extra }, frame.session || undefined);
    }
    throw err("not_found", `frame ${frame.index} (${frame.origin || frame.url || "?"}) is not readable: ${frame.why || "it has gone"}`);
  }

  /** The session that owns a frame's own document: the top page's, or a child's. @param {Frame} f */
  const sessionOf = f => f.session || undefined;

  /**
   * Where a frame's viewport starts inside the top page's viewport (CSS pixels): the sum, up the chain, of each iframe element's content box
   * in its parent's viewport. A control found inside the frame at (x, y) is at (x + dx, y + dy) in the top viewport, where input is dispatched.
   * @param {number} tabId @param {Frame} frame @param {Frame[]} [all]
   */
  async function offset(tabId, frame, all) {
    const frames = all || await list(tabId);
    let dx = 0, dy = 0;
    /** @type {Frame|undefined} */ let cur = frame;
    for (let guard = 0; cur && cur.parentId && guard < 20; guard++) {
      const parent = frames.find(f => f.frameId === cur?.parentId);
      if (!parent) break;
      const sid = sessionOf(parent);
      try { await cdp.send(tabId, "DOM.enable", {}, sid); } catch { /* already on */ }
      const owner = await cdp.send(tabId, "DOM.getFrameOwner", { frameId: cur.frameId }, sid);
      const box = await cdp.send(tabId, "DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, sid);
      const q = box && box.model && (box.model.content || box.model.border);
      if (!q || q.length < 2) throw err("not_found", `cannot place frame ${cur.index} inside its parent (no box model)`);
      dx += q[0]; dy += q[1];
      cur = parent;
    }
    return { dx, dy };
  }

  /**
   * Scroll a frame into view, outermost iframe first, so a point found inside it can be clicked in the top viewport (an iframe scrolled out of
   * view has its content at coordinates the top page cannot receive input at). Best effort: a frame that cannot be scrolled is left where it is.
   * @param {number} tabId @param {Frame} frame @param {Frame[]} [all]
   */
  async function reveal(tabId, frame, all) {
    const frames = all || await list(tabId);
    /** @type {Frame[]} */ const chain = [];
    /** @type {Frame|undefined} */ let cur = frame;
    for (let guard = 0; cur && cur.parentId && guard < 20; guard++) { chain.unshift(cur); cur = frames.find(f => f.frameId === cur?.parentId); }
    for (const f of chain) {
      const parent = frames.find(x => x.frameId === f.parentId);
      if (!parent) continue;
      const sid = sessionOf(parent);
      try {
        const owner = await cdp.send(tabId, "DOM.getFrameOwner", { frameId: f.frameId }, sid);
        await cdp.send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: owner.backendNodeId }, sid);
      } catch { /* leave it where it is */ }
    }
  }

  /** How many frames cannot be read, and which: what a snapshot must say instead of pretending the page is only what it could see. @param {Frame[]} frames */
  const unreadable = frames => frames.filter(f => !f.readable);

  return { list, pick, pickFrom, evalIn, offset, reveal, unreadable, sessionOf };
}
