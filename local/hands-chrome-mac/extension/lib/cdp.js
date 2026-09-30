// @ts-check
// cdp: chrome.debugger behind five calls, so no capability touches chrome.debugger itself.
//
//   attach(tabId)              idempotent; concurrent callers share one attach
//   send(tabId, method, p)     auto-attaches; rejects with code "detached" if Chrome (or the
//                              person, from the infobar) detaches while the call is in flight
//   on(fn(tabId, method, p, sessionId?))  every CDP event from every attached tab (and from the tab's child
//                              frame sessions: sessionId says which); returns unsubscribe
//   send(tabId, method, p, sessionId)  the same call, into a child session (a cross-origin iframe's own process)
//   children(tabId)            the child sessions (cross-origin iframes, nested too) the tab has right now
//   detach(tabId)              ours to give up; also what closing a tab does
//   attached()                 tab ids currently attached
//
// One attach per tab is kept for the life of the tab (ADR 0049): an attach costs a round trip and
// shows Chrome's debugging bar, so the bar appears once, not once per call.

import { err } from "./err.js";

const VERSION = "1.3";

/**
 * @param {{ chrome: any, emit?: (evt: any) => void }} o
 */
export function createCdp({ chrome, emit = () => {} }) {
  /** @type {Set<number>} */
  const attachedTabs = new Set();
  /** @type {Map<number, Promise<void>>} */
  const attaching = new Map();
  /** @type {Map<number, Set<(e: Error) => void>>} */
  const inflight = new Map();
  /** @type {Set<(tabId: number, method: string, params: any) => void>} */
  const listeners = new Set();

  /** Child sessions per tab: a cross-origin iframe lives in its own process and is reached through its own session (Chrome 125+, flat sessions). @type {Map<number, Map<string, { targetId: string, type: string, url: string }>>} */
  const kids = new Map();
  /** Whether auto-attach to child frames worked for a tab, and why not if it did not. @type {Map<number, { ok: boolean, why?: string }>} */
  const autoAttach = new Map();

  /** Ask a session to auto-attach its own children too (a cross-origin iframe inside a cross-origin iframe). @param {number} tabId @param {string} [sessionId] */
  async function watchChildren(tabId, sessionId) {
    try {
      await chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      if (!sessionId) autoAttach.set(tabId, { ok: true });
    } catch (e) {
      if (!sessionId) autoAttach.set(tabId, { ok: false, why: String(/** @type {any} */ (e)?.message || e).slice(0, 200) });
    }
  }

  chrome.debugger.onEvent.addListener((/** @type {any} */ source, /** @type {string} */ method, /** @type {any} */ params) => {
    if (typeof source?.tabId !== "number") return;
    const tabId = source.tabId;
    // Keep the table of child sessions: they appear and go as the page's frames do.
    if (method === "Target.attachedToTarget" && params && params.sessionId && params.targetInfo) {
      const m = kids.get(tabId) || new Map();
      m.set(params.sessionId, { targetId: params.targetInfo.targetId, type: params.targetInfo.type, url: params.targetInfo.url || "", ...(params.targetInfo.parentFrameId ? { parentFrameId: params.targetInfo.parentFrameId } : {}) });
      kids.set(tabId, m);
      void watchChildren(tabId, params.sessionId);
    } else if (method === "Target.detachedFromTarget" && params && params.sessionId) {
      kids.get(tabId)?.delete(params.sessionId);
    } else if (method === "Target.targetInfoChanged" && params && params.targetInfo) {
      for (const v of (kids.get(tabId) || new Map()).values()) if (v.targetId === params.targetInfo.targetId) v.url = params.targetInfo.url || v.url;
    }
    for (const fn of [...listeners]) { try { fn(tabId, method, params, source.sessionId); } catch { /* a listener must not break the others */ } }
  });

  chrome.debugger.onDetach.addListener((/** @type {any} */ source, /** @type {string} */ reason) => {
    const tabId = source?.tabId;
    if (typeof tabId !== "number") return;
    const was = attachedTabs.delete(tabId);
    kids.delete(tabId); autoAttach.delete(tabId);
    const pending = inflight.get(tabId);
    inflight.delete(tabId);
    if (pending) for (const reject of pending) reject(err("detached", `Chrome detached the debugger from that tab${reason ? ` (${reason})` : ""}`));
    if (was || pending) emit({ event: "detached", tabId, reason });
  });

  /** @param {number} tabId */
  async function attach(tabId) {
    if (attachedTabs.has(tabId)) return;
    const running = attaching.get(tabId);
    if (running) return running;
    const p = (async () => {
      try {
        await chrome.debugger.attach({ tabId }, VERSION);
      } catch (e) {
        // A leftover attach of ours (worker restarted) reports "already attached": that is fine.
        if (!/already attached/i.test(String(/** @type {any} */ (e)?.message || e))) {
          throw err("no_tab", String(/** @type {any} */ (e)?.message || e));
        }
      }
      attachedTabs.add(tabId);
      // Cross-origin iframes are separate processes: ask Chrome to hand us their sessions as they appear.
      await watchChildren(tabId);
    })().finally(() => attaching.delete(tabId));
    attaching.set(tabId, p);
    return p;
  }

  /** @param {number} tabId @param {string} method @param {any} [params] @param {string} [sessionId] a child session (a cross-origin iframe), or none for the tab itself */
  async function send(tabId, method, params = {}, sessionId) {
    await attach(tabId);
    /** @type {(e: Error) => void} */
    let onDetached = () => {};
    const dropped = new Promise((_, reject) => {
      onDetached = reject;
      if (!inflight.has(tabId)) inflight.set(tabId, new Set());
      /** @type {Set<(e: Error) => void>} */ (inflight.get(tabId)).add(reject);
    });
    dropped.catch(() => {}); // settled by whichever side loses the race; never an unhandled rejection
    try {
      return await Promise.race([chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params), dropped]);
    } catch (e) {
      if (/** @type {any} */ (e)?.code) throw e;
      throw err("error", String(/** @type {any} */ (e)?.message || e));
    } finally {
      inflight.get(tabId)?.delete(onDetached);
    }
  }

  /** @param {(tabId: number, method: string, params: any) => void} fn */
  function on(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  /** @param {number} tabId */
  async function detach(tabId) {
    const had = attachedTabs.delete(tabId);
    kids.delete(tabId); autoAttach.delete(tabId);
    const pending = inflight.get(tabId);
    inflight.delete(tabId);
    if (pending) for (const reject of pending) reject(err("detached", "the debugger was detached by Vyre"));
    if (!had) return;
    try { await chrome.debugger.detach({ tabId }); } catch { /* the tab may already be gone */ }
  }

  return {
    attach, send, on, detach, attached: () => [...attachedTabs],
    /** The child sessions of a tab now: [{ sessionId, targetId, type, url }]. @param {number} tabId */
    children: tabId => [...(kids.get(tabId) || new Map()).entries()].map(([sessionId, v]) => ({ sessionId, ...v })),
    /** Did Chrome accept auto-attach for the tab? (a wall would show here.) @param {number} tabId */
    autoAttachStatus: tabId => autoAttach.get(tabId) || null,
  };
}
