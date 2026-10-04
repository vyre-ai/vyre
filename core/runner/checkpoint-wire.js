// @ts-check
// The checkpoint store over the wire: a lender's runner (another computer) reaches the home's store with the session's token. Production
// puts this on the Wink link between the lender and the home; this file is the request shape and nothing else, plain HTTP with a bearer
// token, so it can be proved on two boxes today. The server turns the token into the session's chain (`authenticate`, the kernel's job)
// and the store authorizes every call as that chain. Every answer is { data } or { error: { code, message } } (the module's shape).

import http from "node:http";

const MAX_BODY = 160 * 1024 * 1024;
const CODES = { not_found: 404, bad_input: 400, quota: 413, storage_full: 507, conflict: 409, stale: 409, incomplete: 409, gap: 409 };

/**
 * @param {{ store: any, authenticate: (token: string) => Promise<any> | any }} o
 * @returns {http.Server}
 */
export function createCheckpointServer(o) {
  return http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    try {
      if (req.method !== "POST") return send(405, { error: { code: "bad_input", message: "POST only" } });
      const m = /^Bearer (.{1,2000})$/.exec(String(req.headers.authorization || ""));
      const chain = m ? await o.authenticate(m[1]) : null;
      if (!chain) return send(401, { error: { code: "denied", message: "no valid session token" } });
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > MAX_BODY) return send(413, { error: { code: "quota", message: "too large" } }); chunks.push(c); }
      const body = Buffer.concat(chunks), op = req.url.replace(/^\/v1\//, "");
      const args = req.headers["x-args"] ? JSON.parse(String(req.headers["x-args"])) : (body.length ? JSON.parse(body.toString()) : {});
      const S = o.store;
      let data;
      if (op === "appendTranscript") data = await S.appendTranscript(chain, args.session, args.entries);
      else if (op === "getTranscript") data = await S.getTranscript(chain, args.session, args.from);
      else if (op === "putFile") data = await S.putFile(chain, args.session, args.rel, args.deleted ? null : new Uint8Array(body));
      else if (op === "getFile") { const b = await S.getFile(chain, args.session, args.rel, args.version); return send(200, b, { "content-type": "application/octet-stream" }); }
      else if (op === "putCheckpoint") data = await S.putCheckpoint(chain, args.session, args.cp);
      else if (op === "getCheckpoint") data = await S.getCheckpoint(chain, args.session);
      else if (op === "usage") data = await S.usage(chain, args.session);
      else return send(404, { error: { code: "not_found", message: "no such call" } });
      send(200, { data });
    } catch (e) {
      const code = e?.code && CODES[e.code] ? e.code : (e instanceof SyntaxError ? "bad_input" : "error");
      send(CODES[code] || 500, { error: { code, message: code === "error" ? "the space could not do that" : String(e.message).slice(0, 300) } });
    }
  });
}

/**
 * The runner's sync port, over the wire.
 * @param {{ url: string, token: () => string, timeoutMs?: number, fetch?: typeof fetch }} o
 */
export function remoteSync(o) {
  const f = o.fetch || fetch;
  async function call(op, args, body) {
    const headers = { authorization: "Bearer " + o.token() };
    let init;
    if (body !== undefined) { headers["x-args"] = JSON.stringify(args); headers["content-type"] = "application/octet-stream"; init = { method: "POST", headers, body }; }
    else { headers["content-type"] = "application/json"; init = { method: "POST", headers, body: JSON.stringify(args) }; }
    const r = await f(o.url.replace(/\/$/, "") + "/v1/" + op, { ...init, signal: AbortSignal.timeout(o.timeoutMs || 60_000) });
    if (op === "getFile" && r.ok) return Buffer.from(await r.arrayBuffer());
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw Object.assign(new Error(j.error?.message || `the space answered ${r.status}`), { code: j.error?.code || "error" });
    return j.data;
  }
  return {
    appendTranscript: (session, entries) => call("appendTranscript", { session, entries }),
    getTranscript: (session, from) => call("getTranscript", { session, from }),
    putFile: (session, rel, bytes) => call("putFile", { session, rel, deleted: bytes === null }, bytes === null ? Buffer.alloc(0) : bytes),
    getFile: (session, rel, version) => call("getFile", { session, rel, version }),
    putCheckpoint: (session, cp) => call("putCheckpoint", { session, cp }),
    getCheckpoint: session => call("getCheckpoint", { session }),
  };
}
