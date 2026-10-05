// @ts-check
// A fake Stripe for the connector tests: customers, payment intents and refunds in memory, the bearer key checked, form bodies parsed the way Stripe reads them (`metadata[a]=b`),
// idempotency keys honoured as Stripe does (the same key and body answers the first answer again; the same key with another body is a 400), and a switch to answer 429 with Retry-After.
// `handle` takes a request already shaped like the vault's transport call; `serve` puts the same handler on a local port for tests that want a real socket.

import http from "node:http";

export const KEY = "sk_test_fake_connector_key";

export function fakeStripe() {
  const s = { customers: new Map(), intents: [], refunds: [], seen: new Map(), calls: /** @type {any[]} */ ([]), n: 0, limitNext: 0, corrupt: /** @type {null | ((c: any) => any)} */ (null) };
  const id = (/** @type {string} */ p) => `${p}_${String(++s.n).padStart(4, "0")}`;
  const reply = (/** @type {number} */ status, /** @type {any} */ body, /** @type {Record<string, string>} */ headers = {}) => ({ status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  /** a form body as nested fields */
  const fields = (/** @type {string} */ text) => {
    const out = /** @type {any} */ ({});
    for (const [k, v] of new URLSearchParams(text)) {
      const path = k.replace(/\]/g, "").split("[");
      let cur = out;
      path.slice(0, -1).forEach(p => { cur = cur[p] = cur[p] || {}; });
      cur[path[path.length - 1]] = v;
    }
    return out;
  };
  /** @param {{ method: string, url: URL, headers: Record<string, string>, body?: string }} r */
  function handle(r) {
    s.calls.push({ method: r.method, path: r.url.pathname, search: r.url.search, headers: r.headers, body: r.body });
    if (r.headers.authorization !== `Bearer ${KEY}`) return reply(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
    if (s.limitNext > 0) { s.limitNext--; return reply(429, { error: { type: "rate_limit_error" } }, { "retry-after": "1" }); }
    const p = r.url.pathname, m = r.method;
    const idem = r.headers["idempotency-key"];
    if (m === "POST" && idem) {
      const prior = s.seen.get(idem);
      if (prior) return prior.body === r.body && prior.path === p ? { ...prior.res, headers: { ...prior.res.headers, "idempotent-replayed": "true" } } : reply(400, { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } });
    }
    let res;
    let hit;
    if (m === "POST" && p === "/v1/customers") {
      const f = fields(r.body || "");
      const c = { id: id("cus"), object: "customer", email: f.email ?? null, name: f.name ?? null, phone: f.phone ?? null, description: f.description ?? null, metadata: f.metadata || {}, created: 1791000000 + s.n };
      s.customers.set(c.id, c); res = reply(200, c);
    } else if (m === "GET" && (hit = /^\/v1\/customers\/([^/]+)$/.exec(p))) {
      const c = s.customers.get(hit[1]);
      res = c ? reply(200, s.corrupt ? s.corrupt(c) : c) : reply(404, { error: { type: "invalid_request_error", message: "No such customer" } });
    } else if (m === "GET" && p === "/v1/customers") {
      const email = r.url.searchParams.get("email");
      res = reply(200, { object: "list", data: [...s.customers.values()].filter(c => !email || c.email === email), has_more: false });
    } else if (m === "GET" && p === "/v1/payment_intents") {
      const since = Number(r.url.searchParams.get("created[gte]") || 0);
      res = reply(200, { object: "list", data: s.intents.filter((/** @type {any} */ i) => i.created >= since), has_more: false });
    } else if (m === "POST" && p === "/v1/refunds") {
      const f = fields(r.body || "");
      if (!f.payment_intent) res = reply(400, { error: { type: "invalid_request_error", message: "Missing required param: payment_intent." } });
      else { const x = { id: id("re"), object: "refund", payment_intent: f.payment_intent, amount: Number(f.amount || 0), status: "succeeded" }; s.refunds.push(x); res = reply(200, x); }
    } else res = reply(404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${m} ${p})` } });
    if (m === "POST" && idem && res.status < 500) s.seen.set(idem, { body: r.body, path: p, res });
    return res;
  }
  /** a payment the poll should see */
  const addIntent = (/** @type {any} */ o) => { const i = { id: id("pi"), object: "payment_intent", status: "succeeded", currency: "usd", amount: 350000, created: 1791000100, description: "Trust package", customer: null, ...o }; s.intents.push(i); return i; };
  /** @param {number} [port] */
  async function serve(port = 0) {
    const server = http.createServer((req, res) => {
      const chunks = /** @type {Buffer[]} */ ([]);
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        const out = handle({ method: req.method || "GET", url: new URL(req.url || "/", "http://x"), headers: /** @type {any} */ (req.headers), body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(out.status, out.headers); res.end(out.body);
      });
    });
    await new Promise(ok => server.listen(port, "127.0.0.1", () => ok(undefined)));
    return { url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, close: () => new Promise(ok => server.close(() => ok(undefined))) };
  }
  return Object.assign(s, { handle, addIntent, serve });
}
