// @ts-check
// The shipped connector catalog is data, so these check the data: every preset is well formed, names
// its vendor's own https server, and binds its credential to that server's host. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { presets, unavailable, preset, presetOfName, boundFor, connectionName, itemName, hostsOf, originsOf, validate, makeCatalog, catalogFrom, SHIPPED_DATA } from "./index.js";

test("every shipped preset is valid, unique and https", () => {
  assert.ok(presets().length >= 40);
  const ids = new Set();
  for (const p of presets()) {
    validate(p);
    assert.ok(!ids.has(p.id), `${p.id} repeated`);
    ids.add(p.id);
    if (p.target === "api") for (const h of p.api.hosts) assert.equal(new URL(`https://${h}`).hostname, h);
    else assert.equal(new URL(p.url).protocol, "https:");
  }
  assert.deepEqual(unavailable().filter(u => preset(u.id)).map(u => u.id), [], "a vendor is either available or ruled out, never both");
});

test("the priority and the named vendors are in, and GoHighLevel uses the generic address", () => {
  for (const id of ["ghl", "notion", "linear", "atlassian", "stripe", "sentry", "zapier", "canva", "intercom", "monday", "webflow", "paypal", "square", "cloudflare", "github", "slack", "zoom", "microsoft", "google-personal", "slack-web", "google-gmail", "google-calendar", "google-drive", "hubspot"]) {
    assert.ok(preset(id), `${id} is missing`);
  }
  assert.equal(preset("ghl").url, "https://services.leadconnectorhq.com/mcp/");
  assert.ok(preset("ghl").token, "GoHighLevel keeps a token fallback");
  assert.deepEqual(unavailable().map(u => u.id).sort(), ["box", "calendly", "dropbox", "figma", "wordpress-com"]);
});

test("a preset that names a vendor's client-specific endpoint is refused", () => {
  const p = { ...preset("ghl"), url: "https://services.leadconnectorhq.com/mcp/anthropic/v2" };
  assert.throws(() => validate(p), /refuse other clients/);
});

test("malformed presets are refused with the reason", () => {
  const base = preset("notion");
  assert.throws(() => validate({ ...base, url: "http://mcp.notion.com/mcp" }), /plain https/);
  assert.throws(() => validate({ ...base, url: "https://user:pw@mcp.notion.com/mcp" }), /plain https/);
  assert.throws(() => validate({ ...base, url: "https://mcp.notion.com/mcp?key=abc" }), /plain https/);
  assert.throws(() => validate({ ...base, oauth: undefined }), /needs oauth or token/);
  assert.throws(() => validate({ ...base, oauth: { client: "byo", as: ["https://a.example"] } }), /help text/);
  assert.throws(() => validate({ ...base, prefer: "token" }), /prefers token but has none/);
  assert.throws(() => validate({ ...base, evidence: "vibes" }), /evidence/);
  assert.throws(() => validate({ ...base, token: { label: "x", help: "y", header: "bad header" } }), /header name/);
  assert.throws(() => validate({ ...base, token: { label: "x", help: "y", format: "no placeholder" } }), /format/);
  assert.throws(() => makeCatalog({ presets: [base, base] }), /repeated/);
  assert.throws(() => validate({ ...base, url: "http://127.0.0.1:1/mcp" }), /plain https/);
  validate({ ...base, url: "http://127.0.0.1:1/mcp" }, { loopback: true });
  assert.throws(() => validate({ ...base, url: "http://example.org/mcp" }, { loopback: true }), /plain https/);
});

test("names: the id or id-label, and the credential is bound to the vendor's own host", () => {
  assert.equal(connectionName("notion"), "notion");
  assert.equal(connectionName("notion", "Work Team!"), "notion-work-team");
  assert.throws(() => connectionName("google-calendar", "a".repeat(30)), /longer than 32/);
  assert.equal(itemName("notion-work"), "notion-work-auth");
  assert.equal(presetOfName("notion-work-auth").id, "notion");
  assert.equal(presetOfName("google-gmail-work").id, "google-gmail", "the longest preset id wins");
  assert.equal(presetOfName("intercom-eu-support").id, "intercom-eu");
  assert.equal(presetOfName("random-item"), null);
  assert.deepEqual(boundFor("notion-auth"), { prefix: "notion-", hosts: ["mcp.notion.com"] });
  assert.deepEqual(boundFor("google-gmail-auth"), { prefix: "google-gmail-", hosts: ["gmailmcp.googleapis.com"] });
  assert.equal(boundFor("mine"), null);
  assert.deepEqual(hostsOf(preset("ghl")), ["services.leadconnectorhq.com"]);
  assert.deepEqual(originsOf(preset("ghl")), ["https://services.leadconnectorhq.com"]);
});

test("production reads only the shipped catalog; a config's presets count only under the test switch, and never reuse a shipped id", () => {
  const extra = { connectors: { presets: [{ ...preset("notion"), id: "fakev", url: "http://127.0.0.1:9/mcp", oauth: { client: "dcr" } }] } };
  delete process.env.VYRE_CONNECTORS_TEST_PRESETS;
  assert.equal(catalogFrom(undefined).presets().length, presets().length);
  assert.equal(catalogFrom(extra).presets().length, presets().length, "a config file cannot add or change a preset");
  assert.equal(catalogFrom({ connectors: { presets: [{ ...preset("notion"), id: "notion-auth", url: "https://evil.example/mcp" }] } }).boundFor("notion-auth").hosts[0], "mcp.notion.com", "nor rebind a vendor's item");
  process.env.VYRE_CONNECTORS_TEST_PRESETS = "1";
  try {
    const c = catalogFrom(extra);
    assert.equal(c.presets().length, presets().length + 1);
    assert.equal(c.boundFor("fakev-auth").hosts[0], "127.0.0.1");
    assert.equal(c.boundFor("notion-auth").hosts[0], "mcp.notion.com");
    assert.throws(() => catalogFrom({ connectors: { presets: [{ ...preset("notion"), url: "http://127.0.0.1:9/mcp" }] } }), /may not reuse the shipped id notion/);
  } finally { delete process.env.VYRE_CONNECTORS_TEST_PRESETS; }
  assert.equal(SHIPPED_DATA.presets.length, presets().length);
});

test("every own-account sign-in names the authorization servers it expects, as origins", () => {
  for (const p of presets()) {
    if (!p.oauth || p.target === "api" || p.oauth.server) continue;
    assert.ok(Array.isArray(p.oauth.as) && p.oauth.as.length, `${p.id} has no pinned servers`);
    for (const o of p.oauth.as) assert.equal(new URL(o).origin, o, `${p.id}: ${o} is an origin`);
  }
  assert.deepEqual(preset("supabase").oauth.as.includes("https://api.supabase.com"), true);
  const bare = { ...preset("notion"), oauth: { client: "dcr" } };
  assert.throws(() => validate(bare), /oauth\.as lists/);
  assert.throws(() => validate({ ...bare, oauth: { client: "dcr", as: ["https://a.example/path"] } }), /oauth\.as lists/);
  assert.throws(() => validate({ ...bare, oauth: { client: "dcr", as: ["http://a.example"] } }), /oauth\.as lists/);
  validate({ ...bare, oauth: { client: "dcr", as: ["https://a.example"] } });
});

test("the api presets (Microsoft, Google personal, Slack Web API) are vault credentials, not hub servers", () => {
  for (const id of ["microsoft", "google-personal", "slack-web"]) {
    const p = preset(id);
    assert.equal(p.target, "api");
    assert.equal(p.url, undefined);
    assert.deepEqual(originsOf(p), p.api.hosts.map(h => `https://${h}`));
  }
  assert.equal(preset("microsoft").oauth.public, true, "no client secret for Microsoft's public client");
  assert.deepEqual(preset("microsoft").oauth.redirect, { host: "localhost", path: "/" });
  assert.ok(preset("google-personal").oauth.guide.steps.some(s => /In production/.test(s) && /7 days/.test(s)), "the 7 day rule is said plainly");
  assert.deepEqual(hostsOf(preset("microsoft")), ["graph.microsoft.com"]);
  assert.throws(() => validate({ ...preset("microsoft"), url: "https://graph.microsoft.com" }), /hosts, not a url/);
  assert.throws(() => validate({ ...preset("microsoft"), oauth: { ...preset("microsoft").oauth, client: "dcr" } }), /own app/);
  assert.throws(() => validate({ ...preset("microsoft"), api: { hosts: ["*.microsoft.com"] } }), /exact host names/);
});

test("the Slack and Zoom presets carry what a person needs: a prefilled app link, a fixed redirect, scopes", () => {
  const s = preset("slack").oauth;
  assert.equal(s.redirect.scheme, "https");
  assert.equal(s.port, 53682);
  assert.ok(s.scopes.includes("search:read.public") && s.scopes.includes("chat:write"));
  assert.deepEqual(s.guide.manifest.json.oauth_config.redirect_urls, ["{redirect}"]);
  assert.match(s.guide.manifest.link, /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=$/);
  const z = preset("zoom");
  assert.equal(z.url, "https://mcp.zoom.us/mcp/zoom/streamable");
  assert.ok(z.oauth.scopes.includes("cloud_recording:read:list_user_recordings"));
});
