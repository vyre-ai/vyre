// @ts-check
// The app catalog snapshot (lib/mcp-catalog.js): what is listed from the registry and the plugin repos, what counts as verified, how two sources merge, what a weekly diff says, and how the catalog is searched.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegistryPage, parsePlugins, mergeEntries, diffCatalogs, diffMarkdown, searchCatalog, urlKey, presetIdFor, connectable, oneClick, issuerOk, authFromProbe } from "./mcp-catalog.js";

const meta = (over = {}) => ({ "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true, ...over } });
const page = {
  servers: [
    { server: { name: "com.northwind/notes", title: "Northwind Notes", description: "Notes for the bakery.\u0007 Reads and writes.", version: "1.2.0", remotes: [{ type: "streamable-http", url: "https://mcp.northwind.com/mcp" }] }, _meta: meta() },
    { server: { name: "com.northwind/notes", version: "1.1.0", remotes: [{ type: "streamable-http", url: "https://old.northwind.com/mcp" }] }, _meta: meta({ isLatest: false }) },
    { server: { name: "io.github.kit/helper", description: "A helper", version: "0.1.0", remotes: [{ type: "sse", url: "https://helper.example.net/sse", headers: [{ name: "Authorization", isSecret: true, isRequired: true }] }] }, _meta: meta() },
    { server: { name: "com.harlow/legal", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://elsewhere.example.org/mcp" }] }, _meta: meta() },
    { server: { name: "com.gone/x", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://mcp.gone.com/mcp" }] }, _meta: meta({ status: "deleted" }) },
    { server: { name: "com.local/proc", version: "1.0.0", packages: [{ registryType: "npm" }] }, _meta: meta() },
    { server: { name: "com.token/leak", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://mcp.token.com/mcp?key=abc" }, { type: "streamable-http", url: "http://mcp.token.com/plain" }] }, _meta: meta() },
    { server: { name: "com.two/multi", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://a.two.com/mcp" }, { type: "streamable-http", url: "https://b.two.com/mcp" }] }, _meta: meta() },
  ],
  metadata: { nextCursor: null, count: 8 },
};

test("the registry: only the latest active version's hosted endpoints, verified only on the vendor's own domain, text cleaned", () => {
  const e = parseRegistryPage(page);
  assert.deepEqual(e.map(x => x.id).sort(), ["com.harlow/legal", "com.northwind/notes", "com.two/multi#1", "com.two/multi#2", "io.github.kit/helper"]);
  const notes = e.find(x => x.id === "com.northwind/notes");
  assert.equal(notes.verified, true);
  assert.equal(notes.vendor, "northwind.com");
  assert.equal(notes.transport, "http");
  assert.equal(notes.description, "Notes for the bakery. Reads and writes.", "control characters are gone");
  assert.equal(notes.auth, "unknown", "a registry entry that declares nothing is not offered as one click");
  assert.equal(e.find(x => x.id === "com.harlow/legal").verified, false, "a namespace whose domain does not match the address is inferred");
  assert.equal(e.find(x => x.id === "io.github.kit/helper").verified, false, "a GitHub namespace is not a vendor");
  const helper = e.find(x => x.id === "io.github.kit/helper");
  assert.equal(helper.auth, "header");
  assert.equal(helper.transport, "sse");
  assert.deepEqual(helper.headers, ["Authorization"], "header names only, never a value");
});

test("an address with a query, a plain http address or a process package is not listed", () => {
  const e = parseRegistryPage(page);
  assert.equal(e.some(x => /token|local|gone/.test(x.id)), false);
});

test("plugins: the server key, the plugin as category, an OAuth client or a header decide the auth kind", () => {
  const e = parsePlugins({ repo: "claude-plugins-official", sha: "abcdef1234567890" }, [
    { plugin: "legal", author: "Harlow", servers: { docs: { type: "http", url: "https://mcp.docs.example.com/mcp" }, sign: { type: "http", url: "https://mcp.sign.example.com/mcp", oauth: { clientId: "x" } }, keyed: { type: "http", url: "https://mcp.k.example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } }, bad: { command: "npx" } } },
  ]);
  assert.deepEqual(e.map(x => [x.name, x.auth]), [["docs", "none"], ["sign", "oauth"], ["keyed", "header"]]);
  assert.ok(e.every(x => x.category === "legal" && x.verified === false && /abcdef123456/.test(x.basis)));
  assert.deepEqual(e.find(x => x.name === "keyed").headers, ["Authorization"]);
  assert.equal(JSON.stringify(e).includes("Bearer"), false, "a header value never reaches the catalog");
});

test("two sources for one address merge: verified if either is, the more specific auth, both sources kept", () => {
  const reg = parseRegistryPage(page).filter(x => x.id === "com.northwind/notes");
  const plug = parsePlugins({ repo: "r", sha: "1234567" }, [{ plugin: "ops", servers: { notes: { type: "http", url: "https://mcp.northwind.com/mcp/", oauth: {} } } }]);
  const [m] = mergeEntries(reg, plug);
  assert.equal(m.verified, true);
  assert.equal(m.auth, "oauth");
  assert.equal(m.category, "ops");
  assert.equal(m.sources.length, 2);
  assert.equal(m.id, "com.northwind/notes", "the verified entry's identity stays");
});

test("the weekly diff names what is new, gone and changed, and a new entry carries its facts for the reviewer", () => {
  const before = mergeEntries(parseRegistryPage(page));
  const next = structuredClone(before).filter(x => x.id !== "com.harlow/legal");
  next.find(x => x.id === "com.northwind/notes").auth = "oauth";
  next.push({ ...before[0], id: "com.new/app", url: "https://mcp.new.com/mcp" });
  const d = diffCatalogs(before, next);
  assert.deepEqual(d.added, ["com.new/app"]);
  assert.deepEqual(d.removed, ["com.harlow/legal"]);
  assert.deepEqual(d.changed, [{ id: "com.northwind/notes", fields: ["auth"] }]);
  const md = diffMarkdown(before, next);
  assert.match(md, /1 new, 1 gone, 1 changed/);
  // sec53: the review checklist travels with the pull request, so a reviewer checks each row's domain before the verdict.
  assert.match(md, /Reviewer checklist/);
  assert.match(md, /domain.*vendor.s own.*never a shared suffix/);
  assert.match(md, /com\.new\/app.*https:\/\/mcp\.new\.com\/mcp.*inferred|verified/);
  assert.match(md, /Check for each: the address below is on the vendor's own domain/);
  assert.match(md, /com\.northwind\/notes` https:\/\/mcp\.northwind\.com\/mcp: auth/, "a changed row shows its address so the reviewer can see the vendor domain");
  assert.deepEqual(diffCatalogs(next, next), { added: [], removed: [], changed: [] });
});

test("search: by words (name before vendor before description), by category, connected or not, verified first, paged", () => {
  const probed = new Set(["com.northwind/notes", "com.two/multi#1"]);
  const entries = mergeEntries(parseRegistryPage(page), parsePlugins({ repo: "r", sha: "1234567" }, [{ plugin: "legal", servers: { notebook: { type: "http", url: "https://mcp.nb.example.com/mcp", oauth: {} } } }])).map(e => (probed.has(e.id) ? { ...e, probe: { result: "dcr-advertised" } } : e));
  const connected = new Set([urlKey("https://mcp.northwind.com/mcp")]);
  const all = searchCatalog(entries, {}, connected);
  assert.equal(all.total, entries.length);
  assert.equal(all.entries[0].id, "com.northwind/notes", "verified first");
  assert.equal(all.entries[0].connected, true);
  assert.equal(all.entries[0].oneClick, true, "verified and probed as registering a client by itself");
  assert.match(all.entries[0].preset, /^x-northwind-note-[0-9a-f]{4}$/, "the slug is cut to 14 characters");
  assert.equal(all.entries.find(e => e.id === "com.two/multi#1").oneClick, true);
  assert.equal(all.entries.find(e => e.id === "com.two/multi#2").oneClick, false, "verified but nobody probed it");
  assert.equal(searchCatalog(entries, { query: "helper" }, connected).entries[0].oneClick, false, "an inferred entry is never one click");
  assert.equal(searchCatalog(entries, { query: "helper" }, connected).entries[0].preset, undefined);
  assert.deepEqual(searchCatalog(entries, { query: "note" }, connected).entries.map(x => x.id), ["com.northwind/notes", "plugin:legal/notebook"]);
  assert.deepEqual(searchCatalog(entries, { query: "bakery" }, connected).entries.map(x => x.id), ["com.northwind/notes"], "the description counts, last");
  assert.deepEqual(searchCatalog(entries, { query: "nonsense words" }, connected).entries, []);
  assert.deepEqual(searchCatalog(entries, { category: "legal" }, connected).entries.map(x => x.id), ["plugin:legal/notebook"]);
  assert.equal(searchCatalog(entries, { connected: true }, connected).total, 1);
  assert.equal(searchCatalog(entries, { connected: false }, connected).total, entries.length - 1);
  assert.equal(searchCatalog(entries, { verified: true }, connected).total, 3, "the notes entry and the two multi remotes sit on their vendors' domains");
  assert.equal(searchCatalog(entries, { limit: 2 }, connected).entries.length, 2);
  assert.equal(searchCatalog(entries, { limit: 2, offset: 2 }, connected).entries[0].id, all.entries[2].id);
  assert.equal(searchCatalog(entries, {}, connected).categories.legal, 1);
});

test("urlKey ignores the query, the fragment, the case of the host and a trailing slash", () => {
  assert.equal(urlKey("https://MCP.Example.com/a/?x=1#y"), "https://mcp.example.com/a");
  assert.equal(urlKey("ftp://x.com/a"), "");
  assert.equal(urlKey("nonsense"), "");
});

test("connectable: vendor-published AND probed as registering a client by itself, over https; unprobed, needs-client, another verdict or an inferred entry is not", () => {
  const e = { verified: true, auth: "oauth", transport: "http", url: "https://mcp.example.com/mcp", probe: { result: "dcr-advertised" } };
  assert.equal(connectable(e), true);
  assert.equal(connectable({ ...e, auth: "unknown" }), true, "the probe, not the declared auth, decides");
  assert.equal(connectable({ ...e, probe: undefined }), false, "unknown is not connectable until a probe has run");
  assert.equal(connectable({ ...e, probe: { result: "needs-client" } }), false);
  assert.equal(connectable({ ...e, probe: { result: "open-client" } }), false, "only a server that registers a client by itself");
  assert.equal(connectable({ ...e, probe: { result: "refused" } }), false);
  assert.equal(connectable({ ...e, verdict: "conditional" }), false);
  assert.equal(connectable({ ...e, verdict: "one-click" }), true);
  assert.equal(connectable({ ...e, verified: false }), false);
  assert.equal(connectable({ ...e, url: "http://mcp.example.com/mcp" }), false);
  assert.equal(connectable({ ...e, transport: "stdio" }), false);
  assert.equal(connectable(null), false);
});

test("authFromProbe: OAuth for a server that registers or wants a client; a header stays a header; no OAuth is open; a refusal settles nothing", () => {
  for (const r of ["dcr-advertised", "needs-client"]) assert.equal(authFromProbe({ auth: "unknown" }, r), "oauth", r);
  assert.equal(authFromProbe({ auth: "header" }, "no-oauth"), "header");
  assert.equal(authFromProbe({ auth: "unknown" }, "no-oauth"), "none");
  assert.equal(authFromProbe({ auth: "unknown" }, "refused"), "unknown");
  assert.equal(authFromProbe({ auth: "oauth" }, "refused"), "oauth");
});

test("presetIdFor: stable, readable, short enough for a connection name and a label, and distinct for distinct entries", () => {
  const a = presetIdFor({ id: "com.northwind/notes", name: "Northwind Notes" }), b = presetIdFor({ id: "com.northwind/notes2", name: "Northwind Notes" });
  assert.equal(a, presetIdFor({ id: "com.northwind/notes", name: "Northwind Notes" }));
  assert.notEqual(a, b);
  assert.match(a, /^x-[a-z0-9-]+-[0-9a-f]{4}$/);
  assert.ok(presetIdFor({ id: "x", name: "A very long name that keeps going and going" }).length <= 21);
  assert.match(presetIdFor({ id: "y", name: "\u00dcber \u2603" }), /^x-[a-z0-9-]+-[0-9a-f]{4}$/);
  assert.match(presetIdFor({ id: "z", name: "***" }), /^x-app-[0-9a-f]{4}$/);
});

test("oneClick: a connectable row, or a vendor-published open server; a reviewer's other verdict, an inferred row or an unprobed one is not", () => {
  const e = { verified: true, auth: "oauth", transport: "http", url: "https://mcp.example.com/mcp", probe: { result: "dcr-advertised" } };
  assert.equal(oneClick(e), true);
  assert.equal(oneClick({ ...e, verdict: "one-click" }), true);
  for (const v of ["conditional", "blocked"]) assert.equal(oneClick({ ...e, verdict: v }), false, v);
  const open = { ...e, auth: "none", probe: { result: "no-oauth" } };
  assert.equal(oneClick(open), true, "an open server needs nothing but its address");
  assert.equal(connectable(open), false, "but there is no sign-in to run, so no preset");
  assert.equal(oneClick({ ...open, auth: "header" }), false, "a declared key is the token route");
  assert.equal(oneClick({ ...open, verdict: "blocked" }), false);
  assert.equal(oneClick({ ...e, probe: { result: "needs-client" } }), false);
  assert.equal(oneClick({ ...e, probe: undefined }), false);
  assert.equal(oneClick({ ...e, verified: false }), false);
  const [row] = searchCatalog([{ ...open, id: "o", name: "Open", vendor: "v", description: "", category: "other", headers: [], basis: "t", sources: [] }], {}).entries;
  assert.equal(row.oneClick, true);
  assert.equal(row.preset, undefined, "an open server has no sign-in to start");
});

test("a probed row whose sign-in lives on another domain is not one tap, unless a curated preset serves that address; a sign-in on the vendor's own domain is one tap", () => {
  const e = { id: "stripe", name: "Stripe", vendor: "Stripe", domain: "stripe.com", verified: true, auth: "oauth", transport: "http", url: "https://mcp.stripe.com", probe: { result: "dcr-advertised", issuer: "https://access.stripe.com" }, verdict: "one-click", category: "finance", description: "", headers: [], basis: "t", sources: [] };
  assert.equal(issuerOk(e), true, "access.stripe.com is Stripe's own domain");
  assert.equal(connectable(e), true);
  assert.equal(issuerOk({ ...e, probe: { result: "dcr-advertised", issuer: "https://login.example.net" } }), false, "another domain is refused");
  // sec53: the sign-in must be on the vendor's proved domain, and never on a sibling under a shared suffix.
  assert.equal(issuerOk({ ...e, verified: false }), false, "an unverified row with a sibling sign-in is refused");
  const acme = { id: "acme", name: "Acme", vendor: "acme.co.uk", domain: "acme.co.uk", verified: true, auth: "oauth", transport: "http", url: "https://mcp.acme.co.uk/mcp", probe: { result: "dcr-advertised", issuer: "https://auth.acme.co.uk" } };
  assert.equal(issuerOk(acme), true, "a subdomain of the proved domain");
  assert.equal(issuerOk({ ...acme, probe: { result: "dcr-advertised", issuer: "https://evil.co.uk" } }), false, "the same suffix is not the vendor");
  assert.equal(issuerOk({ ...acme, url: "https://x.github.io/mcp", vendor: "github.io", domain: "github.io", probe: { result: "dcr-advertised", issuer: "https://y.github.io" } }), false, "another tenant on a shared suffix is refused");
  assert.equal(connectable({ ...e, probe: { result: "dcr-advertised", issuer: "https://login.example.net" } }), false);
  assert.equal(oneClick(e), true, "a same-domain sign-in makes the row one tap");
  const served = new Set([urlKey("https://mcp.stripe.com")]);
  assert.equal(connectable(e, served), true, "the curated preset has its own reviewed pin");
  assert.equal(oneClick(e, served), true);
  const foreign = { ...e, probe: { result: "dcr-advertised", issuer: "https://login.example.net" } };
  const row = f => searchCatalog([foreign], {}, new Set(), f).entries[0];
  assert.deepEqual([row(new Set()).oneClick, row(new Set()).preset], [false, undefined], "the screen does not offer what would fail");
  assert.equal(row(served).oneClick, true);
  assert.equal(issuerOk({ ...e, probe: { result: "dcr-advertised", issuer: "https://mcp.stripe.com" } }), true);
  assert.equal(issuerOk({ ...e, probe: { result: "dcr-advertised", issuer: "not a url" } }), false);
  assert.equal(issuerOk({ ...e, probe: { result: "dcr-advertised" } }), true, "no issuer on the row: nothing to refuse");
});
