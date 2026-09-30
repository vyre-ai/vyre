// @ts-check
// devtools-kit: a small fake ctx for the devtools, net and api capabilities. It stands in for the
// extension shell so their tests need no Chrome and none of the shell's files: a cdp whose answers
// a test sets per method, a way to push CDP events, and recorders for emit and every send.

import { classify } from "./extension/shared/floor.js";

/**
 * @param {{ respond?: Record<string, any>, floor?: (tab: number, op: string) => { allow: boolean, why?: string }, stopped?: () => boolean, active?: number }} [o]
 */
export function makeCtx(o = {}) {
  /** @type {Array<{ tab: number, method: string, params: any }>} */
  const sent = [];
  /** @type {any[]} */
  const emitted = [];
  /** @type {Set<Function>} */
  const listeners = new Set();
  const attachedSet = new Set();
  const respond = o.respond || {};
  const state = { floor: o.floor || (() => ({ allow: true })), stopped: o.stopped || (() => false) };
  const ctx = {
    cdp: {
      async attach(/** @type {number} */ t) { attachedSet.add(t); },
      async send(/** @type {number} */ tab, /** @type {string} */ method, /** @type {any} */ params) {
        sent.push({ tab, method, params });
        const r = respond[method];
        return typeof r === "function" ? r(params, tab) : r ?? {};
      },
      on(/** @type {Function} */ fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async detach(/** @type {number} */ t) { attachedSet.delete(t); },
      attached() { return [...attachedSet]; },
    },
    tabs: { async active() { return { id: o.active ?? 1 }; }, async get(/** @type {number} */ id) { return { id, url: /** @type {any} */ (o).tabUrl || "https://app.example.com/dashboard" }; } },
    emit(/** @type {any} */ e) { emitted.push(e); },
    stopped: () => state.stopped(),
    floorTier: async () => (/** @type {string} */ u) => classify(u, undefined, {}).tier,
    floorUrl: async (/** @type {string} */ u, /** @type {string} */ op) => classify(u, op, {}),
    floorAllows: async (/** @type {number} */ t, /** @type {string} */ op) => state.floor(t, op),
  };
  return {
    ctx,
    sent,
    emitted,
    respond,
    state,
    attachedSet,
    /** Push a CDP event as Chrome would. */
    push(/** @type {number} */ tab, /** @type {string} */ method, /** @type {any} */ params) { for (const l of [...listeners]) l(tab, method, params); },
    calls: (/** @type {string} */ m) => sent.filter(s => s.method === m),
  };
}

/** Feed one complete request through Network events. */
export function request(/** @type {ReturnType<typeof makeCtx>} */ k, tab = 1, /** @type {any} */ r = {}) {
  const id = r.id || "r1";
  k.push(tab, "Network.requestWillBeSent", { requestId: id, type: r.type || "XHR", wallTime: r.wallTime || Date.now() / 1000, request: { url: r.url || "https://bakery.example/api/orders/1001", method: r.method || "GET", headers: r.headers || {}, postData: r.postData }, initiator: { type: "script", url: "https://bakery.example/app.js", lineNumber: 4 } });
  if (r.extra) k.push(tab, "Network.requestWillBeSentExtraInfo", { requestId: id, headers: r.extra });
  if (r.failed) return k.push(tab, "Network.loadingFailed", { requestId: id, errorText: r.failed });
  k.push(tab, "Network.responseReceived", { requestId: id, type: r.type || "XHR", response: { status: r.status ?? 200, mimeType: r.mime || "application/json", headers: r.resHeaders || {}, timing: { requestTime: 100 } } });
  if (r.resExtra) k.push(tab, "Network.responseReceivedExtraInfo", { requestId: id, headers: r.resExtra, statusCode: r.status ?? 200 });
  k.push(tab, "Network.dataReceived", { requestId: id, dataLength: r.size || 120 });
  k.push(tab, "Network.loadingFinished", { requestId: id, timestamp: 100.25, encodedDataLength: 80 });
}
