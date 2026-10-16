// @ts-check
// CDP network capture for chrome.net / chrome.api on the box (reuses siteops capture shape).

const QUIET_MS = 800;
const IDLE_MAX_MS = 15_000;
const BODY_CAP = 1_000_000;
const MAX_BODIES = 80;
const TYPE = /** @type {Record<string, string>} */ ({ xhr: "xhr", fetch: "fetch", document: "document", script: "script", stylesheet: "stylesheet", image: "image", font: "font", media: "media", websocket: "websocket", ping: "ping" });
const lowerKeys = (/** @type {Record<string, any>} */ h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/**
 * @typedef {{ send: (method: string, params?: any, sessionId?: string) => Promise<any>, on: (fn: (m: any) => void) => () => void, waitFor?: (pred: (m: any) => boolean, ms?: number) => Promise<any> }} CdpLike
 */

/** @param {CdpLike} cdp @param {string} sessionId @param {{ full?: boolean }} [o] */
export function captureNetwork(cdp, sessionId, o = {}) {
  /** @type {Map<string, any>} */ const by = new Map();
  /** @type {any[]} */ const order = [];
  let pending = 0, last = Date.now(), bodies = 0, seq = 0;
  const off = cdp.on(m => {
    if (m.sessionId && m.sessionId !== sessionId) return;
    const p = m.params || {};
    if (m.method === "Network.requestWillBeSent") {
      const rec = {
        seq: ++seq, id: String(p.requestId), requestId: String(p.requestId),
        type: String(p.type || "other").toLowerCase(), method: p.request && p.request.method || "GET",
        url: p.request && p.request.url || "", headers: { ...(p.request && p.request.headers || {}) },
        ...(p.request && p.request.postData !== undefined ? { postData: p.request.postData } : {}),
      };
      by.set(rec.requestId, rec); order.push(rec); pending++; last = Date.now();
    } else if (m.method === "Network.requestWillBeSentExtraInfo") {
      const rec = by.get(String(p.requestId)); if (rec) Object.assign(rec.headers, p.headers || {});
    } else if (m.method === "Network.responseReceived") {
      const rec = by.get(String(p.requestId));
      if (rec && p.response) Object.assign(rec, { status: p.response.status, resHeaders: p.response.headers || {}, mime: p.response.mimeType || "" });
    } else if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") {
      pending = Math.max(0, pending - 1); last = Date.now();
      const rec = by.get(String(p.requestId));
      if (rec && o.full && m.method === "Network.loadingFinished" && /^(xhr|fetch|document)$/.test(rec.type) && (rec.status ?? 0) >= 200 && bodies < MAX_BODIES) {
        bodies++;
        rec.bodyP = Promise.resolve(cdp.send("Network.getResponseBody", { requestId: rec.requestId }, sessionId)).catch(() => null);
      }
      if (rec && m.method === "Network.loadingFailed") rec.failed = String(p.errorText || "failed");
    }
  });
  return {
    stop: off,
    recent: () => order.slice().reverse(),
    async start() { await cdp.send("Network.enable", {}, sessionId); },
    async settle() { const end = Date.now() + IDLE_MAX_MS; while (Date.now() < end) { if (pending === 0 && Date.now() - last >= QUIET_MS) return; await sleep(100); } },
    async recordsForLearn() {
      /** @type {any[]} */ const out = [];
      for (const r of order) {
        let body;
        if (r.bodyP) { const b = await r.bodyP; if (b && !b.base64Encoded) body = String(b.body ?? "").slice(0, BODY_CAP); }
        out.push({
          method: r.method, url: r.url, status: r.status, type: TYPE[r.type] || r.type,
          requestHeaders: lowerKeys(r.headers), postData: r.postData,
          ...(body !== undefined ? { responseBody: body } : {}),
        });
      }
      return out;
    },
    async get(id) {
      const rec = order.find(r => r.id === id || r.seq === Number(id));
      if (!rec) return null;
      let reqBody = rec.postData;
      let resBody;
      if (rec.bodyP) { const b = await rec.bodyP; if (b && !b.base64Encoded) resBody = String(b.body ?? "").slice(0, 100_000); }
      return { ...rec, requestHeaders: lowerKeys(rec.headers), responseHeaders: lowerKeys(rec.resHeaders || {}), requestBody: reqBody, responseBody: resBody };
    },
  };
}
