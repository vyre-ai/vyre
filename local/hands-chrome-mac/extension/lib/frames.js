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
  /** Execution contexts of same-process frames, by tab and frame id. @type {Map<number, Map<string, number>>} */
  const contexts = new Map();
  /** @type {Set<number>} tabs whose main session has Runtime enabled for us */
  const runtimeOn = new Set();

  cdp.on((/** @type {number} */ tabId, /** @type {string} */ method, /** @type {any} */ p, /** @type {string|undefined} */ sessionId) => {
    if (sessionId) return; // a child session's own contexts are its main world: reached without a context id
    if (method === "Runtime.executionContextCreated" && p && p.context && p.context.auxData && p.context.auxData.isDefault && p.context.auxData.frameId) {
      const m = contexts.get(tabId) || new Map(); m.set(String(p.context.auxData.frameId), p.context.id); contexts.set(tabId, m);
    } else if (method === "Runtime.executionContextDestroyed" && p) {
      for (const m of contexts.values()) for (const [f, id] of m) if (id === p.executionContextId) m.delete(f);
    } else if (method === "Runtime.executionContextsCleared") contexts.delete(tabId);
  });

  /** @param {number} tabId */
  async function ensureRuntime(tabId) {
    if (runtimeOn.has(tabId)) return;
    runtimeOn.add(tabId);
    try { await cdp.send(tabId, "Runtime.enable", {}); } catch { runtimeOn.delete(tabId); }
  }

  /** @param {number} tabId @returns {Promise<Frame[]>} */
  async function list(tabId) {
    await ensureRuntime(tabId);
    const t = await cdp.send(tabId, "Page.getFrameTree", {});
    const kids = /** @type {Array<{ sessionId: string, targetId: string, type: string, url: string }>} */ (cdp.children(tabId));
    const bySession = new Map(kids.filter(k => k.type === "iframe" || k.type === "page").map(k => [k.targetId, k.sessionId]));
    /** @type {Frame[]} */ const out = [];
    /** @param {any} node @param {string|null} parentId @param {number} depth */
    const walk = (node, parentId, depth) => {
      const f = node.frame || {};
      const id = String(f.id);
      const session = depth === 0 ? null : bySession.get(id) || null;
      const ctx = contexts.get(tabId)?.get(id);
      /** @type {Frame["how"]} */ let how = "none"; let readable = false; /** @type {string|undefined} */ let why;
      if (depth === 0) { how = "top"; readable = true; }
      else if (session) { how = "session"; readable = true; }
      else if (ctx !== undefined) { how = "context"; readable = true; }
      else { why = "no way into this frame yet: it is in another process and Chrome has not handed over its session (still loading, or it never attached)"; }
      out.push({ index: out.length, frameId: id, parentId, depth, url: String(f.url || ""), origin: originOf(f), name: String(f.name || ""), session, how, readable, ...(why ? { why } : {}) });
      for (const c of node.childFrames || []) walk(c, id, depth + 1);
    };
    if (t && t.frameTree) walk(t.frameTree, null, 0);
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
      const id = contexts.get(tabId)?.get(frame.frameId);
      if (id !== undefined) return cdp.send(tabId, "Runtime.evaluate", { expression, contextId: id, ...extra });
    }
    throw err("not_found", `frame ${frame.index} (${frame.origin || frame.url || "?"}) is not readable: ${frame.why || "it has gone"}`);
  }

  /** The session that owns a frame's own document: the top page's, or a child's. @param {Frame} f */
  const sessionOf = f => (f.how === "session" ? f.session : undefined);

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

  /** How many frames cannot be read, and which: what a snapshot must say instead of pretending the page is only what it could see. @param {Frame[]} frames */
  const unreadable = frames => frames.filter(f => !f.readable);

  return { list, pick, pickFrom, evalIn, offset, unreadable, sessionOf };
}
