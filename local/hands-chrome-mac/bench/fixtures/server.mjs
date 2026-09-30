// @ts-check
// Fixture server for the Chrome proof and bench. Why: the bench must never touch a real site, so
// this serves two local pages and a fake GoHighLevel-shaped backend on 127.0.0.1:
//   GET  /checkout            12-field checkout-like form with a submit button
//   GET  /ghl                 single-page CRM: contacts table, workflow builder, action modal, save
//   GET  /api/contacts        needs `Authorization: Bearer <token>` AND the `sid` cookie (set by /ghl)
//   GET  /api/workflows       same auth; POST creates one (201), GET /api/workflows/<id> reads it
//   GET  /healthz             no auth
// The auth pair mirrors a real app: a bearer header the page's JS adds, plus a session cookie the
// browser adds, so the API-learning path (bench/api-learn.mjs) has both kinds to classify.
// Run standalone: node server.mjs --port 8123. Sample world only (Harlow Legal, Northwind Bakery).
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TOKEN = "fixture-token-123";
export const SESSION = "fixture-session-abc";

const here = new URL("./", import.meta.url);
const page = (/** @type {string} */ name) => fs.readFileSync(fileURLToPath(new URL(name, here)), "utf8");

const NAMES = ["alex", "juno", "kit", "riley", "sam", "morgan", "casey", "jordan", "taylor", "quinn"];
const STAGES = ["new", "consult booked", "retained", "closed"];
export const CONTACTS = Array.from({ length: 60 }, (_, i) => ({
  id: `ct_${(1000 + i).toString(16)}${(i * 7919).toString(16).padStart(4, "0")}`,
  name: `${NAMES[i % NAMES.length]} ${String.fromCharCode(65 + (i % 26))}. Sample`,
  email: `${NAMES[i % NAMES.length]}${i}@example.com`,
  stage: STAGES[i % STAGES.length],
}));

/** @param {http.ServerResponse} res @param {number} status @param {unknown} body @param {Record<string,string>} [headers] */
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/** @param {http.IncomingMessage} req */
export function authorized(req) {
  const bearer = req.headers.authorization === `Bearer ${TOKEN}`;
  const cookie = String(req.headers.cookie || "").split(/;\s*/).includes(`sid=${SESSION}`);
  return { bearer, cookie, ok: bearer && cookie };
}

/** @param {{port?:number, host?:string}} [o] */
export async function startFixtureServer({ port = 0, host = "127.0.0.1" } = {}) {
  /** @type {Map<string, any>} */
  const workflows = new Map();
  const stats = { requests: 0, api: 0, denied: 0 };

  const server = http.createServer((req, res) => {
    stats.requests++;
    const url = new URL(req.url || "/", "http://x");
    const p = url.pathname;
    if (req.method === "GET" && p === "/healthz") return json(res, 200, { data: { ok: true } });
    if (req.method === "GET" && (p === "/checkout" || p === "/checkout/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return void res.end(page("checkout.html"));
    }
    if (req.method === "GET" && (p === "/ghl" || p === "/ghl/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": `sid=${SESSION}; Path=/; HttpOnly; SameSite=Lax` });
      return void res.end(page("ghl.html"));
    }
    if (p.startsWith("/api/")) {
      stats.api++;
      if (!authorized(req).ok) { stats.denied++; return json(res, 401, { error: "unauthorized" }); }
      if (req.method === "GET" && p === "/api/contacts") {
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 25));
        const pg = Math.max(1, Number(url.searchParams.get("page")) || 1);
        return json(res, 200, { data: CONTACTS.slice((pg - 1) * limit, pg * limit), meta: { total: CONTACTS.length, page: pg, limit } });
      }
      const one = /^\/api\/contacts\/([\w-]+)$/.exec(p);
      if (req.method === "GET" && one) {
        const c = CONTACTS.find(x => x.id === one[1]);
        return c ? json(res, 200, { data: c }) : json(res, 404, { error: "not found" });
      }
      if (p === "/api/workflows" && req.method === "GET") return json(res, 200, { data: [...workflows.values()] });
      if (p === "/api/workflows" && req.method === "POST") {
        /** @type {Buffer[]} */
        const chunks = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => {
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return json(res, 400, { error: "bad json" }); }
          const id = `wf_${crypto.randomBytes(5).toString("hex")}`;
          const wf = { id, name: String(body.name || ""), trigger: body.trigger ?? null, actions: Array.isArray(body.actions) ? body.actions : [] };
          workflows.set(id, wf);
          json(res, 201, { data: wf });
        });
        return;
      }
      const wfOne = /^\/api\/workflows\/([\w-]+)$/.exec(p);
      if (req.method === "GET" && wfOne) {
        const w = workflows.get(wfOne[1]);
        return w ? json(res, 200, { data: w }) : json(res, 404, { error: "not found" });
      }
      return json(res, 404, { error: "no such route" });
    }
    json(res, 404, { error: "not found" });
  });

  await new Promise(resolve => server.listen(port, host, () => resolve(undefined)));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    stats,
    workflows,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--port");
  const s = await startFixtureServer({ port: i > 0 ? Number(process.argv[i + 1]) : 0 });
  console.log(`fixture server on ${s.url}  (/checkout, /ghl)`);
}
