// @ts-check
// A fake, generic OAuth 2.1 authorization server for oauth.js's tests, on 127.0.0.1 port 0. Plays
// three shapes at once, chosen per test: a plain issuer with a pre-registered client and no
// protected-resource document (the Google/GitHub shape); one that publishes RFC 9728
// protected-resource metadata pointing here (`opts.resource`); and RFC 7591 dynamic client
// registration, when `opts.dcr` is true. `consent(url)` plays the browser and the person clicking
// through a real consent screen, the way fake-google.js's does; PKCE (S256) is checked for real by
// the token endpoint, so a wrong verifier is refused the way a real server would refuse it.

import crypto from "node:crypto";
import http from "node:http";

/** @param {{ after: (fn: () => any) => void }} t @param {{ dcr?: boolean, resource?: string, email?: string }} [opts] */
export async function startFakeAuthServer(t, opts = {}) {
  /** @type {Map<string, { client_secret: string|null }>} */ const clients = new Map();
  /** @type {Map<string, { client_id: string, redirect_uri: string, challenge: string, scope: string }>} */ const codes = new Map();
  /** @type {Map<string, { client_id: string, scope: string }>} */ const tokens = new Map();
  /** @type {Map<string, string>} refresh token -> client_id */ const refreshes = new Map();
  let refreshRevoked = false;
  const calls = [];

  const server = http.createServer((req, res) => { handle(req, res).catch(e => { res.writeHead(500); res.end(String(e)); }); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const origin = `http://127.0.0.1:${port}`;
  t.after(() => new Promise(r => server.close(r)));

  function json(res, code, body) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }

  async function handle(req, res) {
    const u = new URL(req.url || "/", origin);
    calls.push({ method: req.method, path: u.pathname });
    if (u.pathname === "/.well-known/oauth-protected-resource") return json(res, 200, { resource: opts.resource || origin, authorization_servers: [origin] });
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, ...(opts.dcr ? { registration_endpoint: `${origin}/register` } : {}) });
    }
    if (u.pathname === "/register" && req.method === "POST") {
      if (!opts.dcr) return json(res, 404, { error: "not_found" });
      const id = "dcr_" + crypto.randomBytes(6).toString("hex");
      clients.set(id, { client_secret: null });
      return json(res, 201, { client_id: id, client_secret: null });
    }
    if (u.pathname === "/token" && req.method === "POST") {
      const body = await new Promise(resolve => { let s = ""; req.on("data", c => s += c); req.on("end", () => resolve(new URLSearchParams(s))); });
      if (body.get("grant_type") === "refresh_token") {
        const rt = body.get("refresh_token") || "";
        if (refreshRevoked || !refreshes.has(rt)) return json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        const c = clients.get(String(body.get("client_id")));
        if (!c || refreshes.get(rt) !== body.get("client_id") || (c.client_secret && c.client_secret !== body.get("client_secret"))) return json(res, 400, { error: "invalid_client" });
        const access = "at_" + crypto.randomBytes(12).toString("hex");
        tokens.set(access, { client_id: String(body.get("client_id")), scope: "" });
        return json(res, 200, { access_token: access, expires_in: 3600, token_type: "Bearer" });
      }
      if (body.get("grant_type") !== "authorization_code") return json(res, 400, { error: "unsupported_grant_type" });
      const code = body.get("code") || "";
      const entry = codes.get(code);
      if (!entry) return json(res, 400, { error: "invalid_grant", error_description: "code unknown or already used" });
      codes.delete(code);
      const client = clients.get(String(body.get("client_id")));
      if (!client || entry.client_id !== body.get("client_id")) return json(res, 400, { error: "invalid_client" });
      if (client.client_secret && client.client_secret !== body.get("client_secret")) return json(res, 400, { error: "invalid_client", error_description: "bad secret" });
      const verifier = body.get("code_verifier") || "";
      if (crypto.createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verifier does not match" });
      if (entry.redirect_uri !== body.get("redirect_uri")) return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri does not match" });
      const access = "at_" + crypto.randomBytes(12).toString("hex");
      const refresh = "rt_" + crypto.randomBytes(12).toString("hex");
      tokens.set(access, { client_id: entry.client_id, scope: entry.scope });
      refreshes.set(refresh, entry.client_id);
      // An id_token carrying the address that signed in, the way Google's does.
      const idToken = "h." + Buffer.from(JSON.stringify({ email: opts.email || "alex@harlowlegal.com" })).toString("base64url") + ".s";
      return json(res, 200, { access_token: access, refresh_token: refresh, id_token: idToken, expires_in: 3600, scope: entry.scope, token_type: "Bearer" });
    }
    res.writeHead(404); res.end();
  }

  return {
    origin,
    port,
    calls,
    tokens,
    /** From now on every refresh is refused invalid_grant, as after Google's 7 day Testing expiry. */
    expireRefreshTokens() { refreshRevoked = true; },
    /** Pre-register a client the way a person pasting a pre-registered client_id would have. */
    registerClient(secret = null) { const id = "client_" + crypto.randomBytes(6).toString("hex"); clients.set(id, { client_secret: secret }); return { client_id: id, client_secret: secret }; },
    /** Register the client oauth.js's DCR path would have registered, so a test can pre-seed it directly. */
    registerDynamicClient(id) { clients.set(id, { client_secret: null }); },
    /** Play the person clicking through a real consent screen: mints a code, gives the redirect address. */
    consent(authorizeUrl) {
      const u = new URL(authorizeUrl);
      const client_id = u.searchParams.get("client_id") || "";
      if (!clients.has(client_id)) throw new Error(`consent: no such client ${client_id}`);
      const code = "code_" + crypto.randomBytes(9).toString("hex");
      codes.set(code, { client_id, redirect_uri: u.searchParams.get("redirect_uri") || "", challenge: u.searchParams.get("code_challenge") || "", scope: u.searchParams.get("scope") || "" });
      const redirect = new URL(u.searchParams.get("redirect_uri") || "");
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", u.searchParams.get("state") || "");
      return redirect.toString();
    },
  };
}
