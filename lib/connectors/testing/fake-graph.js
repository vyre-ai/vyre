// @ts-check
// A fake Microsoft identity platform and Microsoft Graph on 127.0.0.1 port 0, for the app-only (client credentials) tests. The token endpoint checks the client secret and hands out an app-only
// token; Graph answers per-user mailbox, calendar and OneDrive reads from `users` (keyed by user principal name) and records every request, so a test can prove which mailbox was asked for.
// Like a real tenant restricted to a staff group, a user outside `staff` answers 403.

import http from "node:http";
import crypto from "node:crypto";

/** @param {{ after: (fn: () => any) => void }} t @param {{ tenant?: string, client_id?: string, client_secret?: string, users?: Record<string, { mail?: any[], events?: any[], files?: any[] }>, staff?: string[] }} [o] */
export async function startFakeGraph(t, o = {}) {
  const tenant = o.tenant || "tenant-1", clientId = o.client_id || "app-1", secret = o.client_secret || "fixture-" + crypto.randomBytes(8).toString("hex");
  const users = o.users || {};
  const staff = new Set((o.staff || Object.keys(users)).map(s => s.toLowerCase()));
  /** @type {Set<string>} */ const tokens = new Set();
  /** @type {{ method: string, path: string, auth: boolean, query: Record<string, string> }[]} */ const requests = [];
  const tokenCalls = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", "http://x");
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (u.pathname === `/${tenant}/oauth2/v2.0/token`) {
      let raw = ""; for await (const c of req) raw += c;
      const p = new URLSearchParams(raw); tokenCalls.push(Object.fromEntries(p));
      if (p.get("grant_type") !== "client_credentials" || p.get("client_id") !== clientId || p.get("client_secret") !== secret) return send(401, { error: "invalid_client", error_description: "bad client" });
      if (p.get("scope") !== "https://graph.microsoft.com/.default") return send(400, { error: "invalid_scope" });
      const tok = "app-" + crypto.randomBytes(10).toString("hex"); tokens.add(tok);
      return send(200, { access_token: tok, token_type: "Bearer", expires_in: 3599 });
    }
    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
    requests.push({ method: req.method || "GET", path: u.pathname, auth: Boolean(auth), query: Object.fromEntries(u.searchParams) });
    if (!auth || !tokens.has(auth[1])) return send(401, { error: { code: "InvalidAuthenticationToken", message: "no token" } });
    const m = /^\/v1\.0\/users\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return send(404, { error: { code: "NotFound", message: "no such path" } });
    const upn = decodeURIComponent(m[1]).toLowerCase(), rest = m[2] || "";
    if (!staff.has(upn) || !users[upn]) return send(403, { error: { code: "ErrorAccessDenied", message: "Access to OData is disabled." } });
    const us = users[upn];
    if (rest === "/messages") return send(200, { value: us.mail || [] });
    const one = /^\/messages\/([^/]+)$/.exec(rest);
    if (one) { const x = (us.mail || []).find(z => z.id === decodeURIComponent(one[1])); return x ? send(200, x) : send(404, { error: { code: "ErrorItemNotFound", message: "gone" } }); }
    if (rest === "/calendarView") return send(200, { value: us.events || [] });
    if (/^\/drive\/root\/search/.test(rest)) return send(200, { value: us.files || [] });
    const f = /^\/drive\/items\/([^/]+)(\/content)?$/.exec(rest);
    if (f) { const x = (us.files || []).find(z => z.id === decodeURIComponent(f[1])); if (!x) return send(404, { error: { code: "itemNotFound", message: "gone" } }); if (f[2]) { res.writeHead(200, { "content-type": "text/plain" }); return res.end(x.content || ""); } return send(200, x); }
    return send(404, { error: { code: "NotFound", message: "no such path" } });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  t.after(() => new Promise(r => server.close(r)));
  return { origin, tenant, clientId, secret, tokenUri: `${origin}/${tenant}/oauth2/v2.0/token`, requests, tokenCalls };
}
