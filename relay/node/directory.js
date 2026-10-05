// @ts-check
// The self-hosted names directory: names/worker's REAL code and routes over plain HTTP, on the in-process Workers runtime the Worker's own tests use
// (relay/worker/fake-cf.js). Its state is one file (written a moment after every change, read at start), so a restart keeps every claim. It publishes no DNS:
// the zone is a fake one, so a name resolves through this directory and nowhere else. scripts/standin-directory.mjs is the same thing for walks.
import http from "node:http";
import fs from "node:fs";
import v8 from "node:v8";
import { createRuntime } from "../worker/fake-cf.js";
import { fakeDns } from "../../names/worker/fake-dns.js";
import worker, * as W from "../../names/worker/index.js";

/**
 * @param {{ port?: number, host?: string, zone?: string, stateFile?: string, appOrigins?: string, claimsPerIp?: string, publicOrigin?: string, log?: (m: string) => void }} [o]
 * @returns {Promise<{ url: string, port: number, close(): Promise<void> }>}
 */
export async function createDirectoryServer(o = {}) {
  const log = o.log || (() => {});
  const host = o.host || "127.0.0.1";
  const dns = fakeDns();
  const origin = o.publicOrigin || `http://${host}:${o.port ?? 0}`;
  const rt = createRuntime({
    worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
    env: { APP_ORIGINS: o.appOrigins || "https://app.vyre.run", CLAIMS_PER_IP_PER_DAY: o.claimsPerIp || "5", CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch,
      ZONE: o.zone || "vyre.local", ORIGIN: origin, RESOLVE_TXT: async () => [] },
  });
  if (o.stateFile) {
    const storage = rt.object("v1", "DIRECTORY").ctx.storage;
    try { for (const [k, v] of v8.deserialize(fs.readFileSync(o.stateFile))) storage.map.set(k, v); log(`directory: restored ${storage.map.size} keys`); } catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") log(`directory: state not read: ${/** @type {Error} */ (e).message}`); }
    const file = o.stateFile;
    /** @type {NodeJS.Timeout | null} */ let timer = null;
    const save = () => { if (timer) return; timer = setTimeout(() => { timer = null; try { fs.writeFileSync(`${file}.tmp`, v8.serialize([...storage.map]), { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file); } catch (e) { log(`directory: state not written: ${/** @type {Error} */ (e).message}`); } }, 300);
      timer.unref?.(); };
    for (const m of ["put", "delete", "deleteAll"]) { const orig = storage[m].bind(storage); storage[m] = async (/** @type {any[]} */ ...a) => { const r = await orig(...a); save(); return r; }; }
  }
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    // Behind a reverse proxy the real client is the last x-forwarded-for hop the proxy added; otherwise the socket's own address.
    headers.set("cf-connecting-ip", (process.env.VYRE_TRUST_PROXY === "1" && String(req.headers["x-forwarded-for"] || "").split(",").pop()?.trim()) || req.socket.remoteAddress || "127.0.0.1");
    try {
      const r = await worker.fetch(new Request(`http://${host}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(String(req.method)) || !body.length ? undefined : body }), rt.env);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "directory_failed", message: String(/** @type {Error} */ (e).message) } }));
    }
  });
  const port = await new Promise(resolve => server.listen(o.port ?? 0, host, () => resolve(/** @type {import("node:net").AddressInfo} */ (server.address()).port)));
  return { url: `http://${host}:${port}`, port: /** @type {number} */ (port), close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections?.(); }) };
}
