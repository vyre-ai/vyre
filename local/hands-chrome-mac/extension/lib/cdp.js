// @ts-check
// cdp: chrome.debugger behind five calls, so no capability touches chrome.debugger itself.
//
//   attach(tabId)              idempotent; concurrent callers share one attach
//   send(tabId, method, p)     auto-attaches; rejects with code "detached" if Chrome (or the
//                              person, from the infobar) detaches while the call is in flight
//   on(fn(tabId, method, p))   every CDP event from every attached tab; returns unsubscribe
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

  chrome.debugger.onEvent.addListener((/** @type {any} */ source, /** @type {string} */ method, /** @type {any} */ params) => {
    if (typeof source?.tabId !== "number") return;
    for (const fn of [...listeners]) { try { fn(source.tabId, method, params); } catch { /* a listener must not break the others */ } }
  });

  chrome.debugger.onDetach.addListener((/** @type {any} */ source, /** @type {string} */ reason) => {
    const tabId = source?.tabId;
    if (typeof tabId !== "number") return;
    const was = attachedTabs.delete(tabId);
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
    })().finally(() => attaching.delete(tabId));
    attaching.set(tabId, p);
    return p;
  }

  /** @param {number} tabId @param {string} method @param {any} [params] */
  async function send(tabId, method, params = {}) {
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
      return await Promise.race([chrome.debugger.sendCommand({ tabId }, method, params), dropped]);
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
    const pending = inflight.get(tabId);
    inflight.delete(tabId);
    if (pending) for (const reject of pending) reject(err("detached", "the debugger was detached by Vyre"));
    if (!had) return;
    try { await chrome.debugger.detach({ tabId }); } catch { /* the tab may already be gone */ }
  }

  return { attach, send, on, detach, attached: () => [...attachedTabs] };
}
