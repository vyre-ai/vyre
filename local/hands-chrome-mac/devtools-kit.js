// @ts-check
// devtools-kit: a small fake ctx for the devtools, net and api capabilities. It stands in for the
// extension shell so their tests need no Chrome and none of the shell's files: a cdp whose answers
// a test sets per method, a way to push CDP events, and recorders for emit and every send.

import { classify } from "./extension/shared/floor.js";

/**
 * @param {{ respond?: Record<string, any>, floor?: (tab: number, op: string) => { allow: boolean, why?: string }, stopped?: () => boolean, active?: number }} [o]
 */
export function makeCtx(o = {}) {
  /** @type {Array<{ tab: number, method: string, params: any, session?: string }>} */
  const sent = [];
  /** @type {any[]} */
  const emitted = [];
  /** @type {Set<Function>} */
  const listeners = new Set();
  const attachedSet = new Set();
  /** Child sessions the fake tab has (what lib/cdp.js children() would list); a test pushes into it. @type {Array<{ sessionId: string, targetId: string, type: string, url: string }>} */
  const children = [];
  const respond = o.respond || {};
  const state = { floor: o.floor || (() => ({ allow: true })), stopped: o.stopped || (() => false) };
  const ctx = {
    cdp: {
      async attach(/** @type {number} */ t) { attachedSet.add(t); },
      async send(/** @type {number} */ tab, /** @type {string} */ method, /** @type {any} */ params, /** @type {string} [session] */ session) {
        sent.push(session ? { tab, method, params, session } : { tab, method, params });
        // The guard's readiness probe (an Image and a fetch to a nonce path on the frame's own origin): Chrome would pause both, so the fake does too.
        const pm = method === "Runtime.evaluate" && typeof params?.expression === "string" && !/** @type {any} */ (o).blindProbe ? /__vyre_probe_([a-z0-9]+_\d+)/.exec(params.expression) : null;
        if (pm) {
          for (const type of ["Image", "Fetch"]) for (const l of [...listeners]) l(tab, "Fetch.requestPaused", { requestId: "probe-" + type + pm[1], resourceType: type, request: { url: "https://app.example.com/__vyre_probe_" + pm[1], method: "GET", headers: {} } }, session);
          return { result: { value: 1 } };
        }
        const r = respond[method];
        return typeof r === "function" ? r(params, tab, session) : r ?? {};
      },
      children(/** @type {number} */ _tab) { return children.slice(); },
      on(/** @type {Function} */ fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async detach(/** @type {number} */ t) { attachedSet.delete(t); },
      attached() { return [...attachedSet]; },
    },
    dnr: { rules: /** @type {any[]} */ ([]), removed: /** @type {any[]} */ ([]), async block(/** @type {any} */ o) { const id = 1000 + this.rules.length; if (/** @type {any} */ (this).fail) return { id: null, ok: false, why: "refused" }; this.rules.push({ id, ...o }); return { id, ids: [id], ok: true, tested: /** @type {any} */ (this).tested === true }; }, async unblock(/** @type {any} */ id) { this.removed.push(id); } },
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
    children,
    state,
    attachedSet,
    /** Push a CDP event as Chrome would. */
    push(/** @type {number} */ tab, /** @type {string} */ method, /** @type {any} */ params, /** @type {string} [session] */ session) { for (const l of [...listeners]) l(tab, method, params, session); },
    calls: (/** @type {string} */ m) => sent.filter(s => s.method === m),
    /** Calls made into one child session. */
    callsIn: (/** @type {string} */ m, /** @type {string} */ session) => sent.filter(s => s.method === m && s.session === session),
  };
}

/** Feed one complete request through Network events. */
export function request(/** @type {ReturnType<typeof makeCtx>} */ k, tab = 1, /** @type {any} */ r = {}) {
  const id = r.id || "r1";
  const S = r.session;
  const push = (/** @type {string} */ m, /** @type {any} */ p) => k.push(tab, m, p, S);
  push("Network.requestWillBeSent", { requestId: id, ...(r.documentURL ? { documentURL: r.documentURL } : {}), type: r.type || "XHR", wallTime: r.wallTime || Date.now() / 1000, request: { url: r.url || "https://bakery.example/api/orders/1001", method: r.method || "GET", headers: r.headers || {}, postData: r.postData }, initiator: { type: "script", url: "https://bakery.example/app.js", lineNumber: 4 } });
  if (r.extra) push("Network.requestWillBeSentExtraInfo", { requestId: id, headers: r.extra });
  if (r.failed) return push("Network.loadingFailed", { requestId: id, errorText: r.failed });
  push("Network.responseReceived", { requestId: id, type: r.type || "XHR", response: { status: r.status ?? 200, mimeType: r.mime || "application/json", headers: r.resHeaders || {}, timing: { requestTime: 100 } } });
  if (r.resExtra) push("Network.responseReceivedExtraInfo", { requestId: id, headers: r.resExtra, statusCode: r.status ?? 200 });
  push("Network.dataReceived", { requestId: id, dataLength: r.size || 120 });
  push("Network.loadingFinished", { requestId: id, timestamp: 100.25, encodedDataLength: 80 });
}

/**
 * Page.getFrameTree the way Chrome answers it: each session lists only the frames of ITS process. The top session's tree leaves out every
 * cross-origin iframe (a frame with a session in `kids`) and what is inside it; a child session's tree is rooted at its own frame.
 * @param {any} tree the whole logical tree {frame, childFrames} @param {Array<{ sessionId: string, targetId: string }>} kids the child sessions
 */
export function realisticFrameTree(tree, kids) {
  const isSession = (/** @type {string} */ id) => kids.some(k => k.targetId === id);
  /** @param {any} n @param {boolean} root */
  const prune = (n, root) => ({ frame: n.frame, childFrames: (n.childFrames || []).filter((/** @type {any} */ c) => !isSession(c.frame.id)).map((/** @type {any} */ c) => prune(c, false)) });
  /** @param {any} n @param {string} id */
  const find = (n, id) => n.frame.id === id ? n : (n.childFrames || []).map((/** @type {any} */ c) => find(c, id)).find(Boolean);
  return (/** @type {any} */ _p, /** @type {number} */ _tab, /** @type {string|undefined} */ session) => {
    if (!session) return { frameTree: prune(tree, true) };
    const k = kids.find(x => x.sessionId === session);
    const n = k && find(tree, k.targetId);
    if (!n) throw new Error("Session with given id not found.");
    return { frameTree: prune(n, true) };
  };
}
