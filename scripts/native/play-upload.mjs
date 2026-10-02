#!/usr/bin/env node
// Upload one signed AAB to a Google Play track, with no dependency and no third-party action (it runs next to the signing key's job).
//   PLAY_SERVICE_ACCOUNT_JSON='{...}' node scripts/native/play-upload.mjs --aab app-release.aab --package sh.vyre.app --track internal [--status draft|completed] [--name "0.2.2 (12)"]
// A new app that has never been published must use status draft (Play refuses completed until the listing is finished). The service
// account JSON is read from the environment only, used to sign one short token request, and never printed. PLAY_API_BASE and
// PLAY_TOKEN_URL exist for the test, which runs this against a fake Play; unset they are Google's.
import crypto from "node:crypto";
import fs from "node:fs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const API = process.env.PLAY_API_BASE || "https://androidpublisher.googleapis.com";
const TOKEN_URL = process.env.PLAY_TOKEN_URL || "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const b64u = b => Buffer.from(b).toString("base64url");

export async function upload({ aab, pkg, track, status = "draft", name, json = process.env.PLAY_SERVICE_ACCOUNT_JSON, fetchImpl = fetch }) {
  if (!json) throw new Error("PLAY_SERVICE_ACCOUNT_JSON is not set");
  if (!["draft", "completed", "inProgress", "halted"].includes(status)) throw new Error("status must be draft or completed");
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(pkg || "")) throw new Error("--package must be an Android package name");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(track || "")) throw new Error("--track must be a track name (internal, alpha, beta, production or a closed track's name)");
  let sa;
  try { sa = JSON.parse(json); } catch { throw new Error("PLAY_SERVICE_ACCOUNT_JSON is not JSON"); }
  if (!sa.client_email || !sa.private_key) throw new Error("the service account JSON has no client_email or private_key");
  const body = fs.readFileSync(aab);
  if (body.length < 1000 || body.subarray(0, 2).toString() !== "PK") throw new Error(`${aab} is not an AAB (a zip)`);

  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 300 }));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${claim}`), sa.private_key);
  const tok = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64u(sig)}` }) });
  if (!tok.ok) throw new Error(`Google did not give a token (${tok.status})`);
  const access = (await tok.json()).access_token;
  if (!access) throw new Error("Google's token answer had no access_token");
  const call = async (method, url, init = {}) => {
    const r = await fetchImpl(url, { method, ...init, headers: { authorization: `Bearer ${access}`, ...(init.headers || {}) } });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${url.replace(API, "")} failed: ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
  const base = `${API}/androidpublisher/v3/applications/${pkg}`;
  const edit = await call("POST", `${base}/edits`, { headers: { "content-type": "application/json" }, body: "{}" });
  const up = await call("POST", `${API}/upload/androidpublisher/v3/applications/${pkg}/edits/${edit.id}/bundles?uploadType=media`, { headers: { "content-type": "application/octet-stream" }, body });
  await call("PUT", `${base}/edits/${edit.id}/tracks/${track}`, { headers: { "content-type": "application/json" },
    body: JSON.stringify({ track, releases: [{ ...(name ? { name } : {}), status, versionCodes: [String(up.versionCode)] }] }) });
  await call("POST", `${base}/edits/${edit.id}:commit`, { headers: { "content-type": "application/json" }, body: "{}" });
  return { versionCode: up.versionCode, track, status };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  upload({ aab: arg("aab"), pkg: arg("package"), track: arg("track"), status: arg("status", "draft"), name: arg("name") })
    .then(r => console.log(`uploaded versionCode ${r.versionCode} to ${r.track} (${r.status})`))
    .catch(e => { console.error(`play-upload: ${e.message}`); process.exit(1); });
}
