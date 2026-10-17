// @ts-check
// lib/mcp-catalog: the app catalog as a reviewed snapshot. Pure functions, no network and no files: the script (scripts/mcp-catalog-snapshot.mjs) feeds them what it pulled from the official MCP
// registry and from the Claude plugin repos, and core/mcp reads the committed snapshot through `searchCatalog`. Nothing here connects to a server or holds a secret: an entry names a remote address,
// how the server asks for a sign-in, and whether the vendor itself published it. Text from a registry or a plugin is third-party text: it is cut, stripped of control characters and never run.
//
// An entry: { id, name, vendor, description, category, url, transport: http | sse, auth: none | header | oauth | unknown, headers: [names], verified, basis, sources: [{ source, ref }] }
//   auth    `header`: the server declares a header the person supplies (an API key). `oauth`: a plugin config names an OAuth client. `none`: a plugin config sets no header and no OAuth. `unknown`: a
//           registry entry that declares nothing; the server may still ask for a sign-in, so it is not offered as one click until a probe says how.
//   verified  true only when the vendor's own domain published it: a registry name in the reverse form of a domain, whose remote address sits on that domain. Everything else is inferred.

import { createHash } from "node:crypto";

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (/** @type {any} */ v, /** @type {number} */ n) => (typeof v === "string" ? v.replace(CTRL, "").replace(/\s+/g, " ").trim().slice(0, n) : "");
const TRANSPORT = /** @type {Record<string, "http" | "sse">} */ ({ "streamable-http": "http", http: "http", sse: "sse" });

/** The address a catalog entry and a connected server are compared by: scheme, lowercase host and path, no query, no fragment, no trailing slash. @param {string} url @returns {string} */
export function urlKey(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch { return ""; }
}

/** A remote address a catalog may list: https, a host with a dot, no credentials in it and no query (a query can carry a token). @param {string} url */
function listable(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password && !u.search && !u.hash;
  } catch { return false; }
}

/** `com.notion/mcp` is published by notion.com; `io.github.name/x` by a GitHub user (not a vendor domain). @param {string} name @returns {string} the vendor's domain, or "" */
function namespaceDomain(name) {
  const ns = String(name).split("/")[0].toLowerCase();
  if (!ns || ns.startsWith("io.github.") || ns.startsWith("io.gitlab.") || !/^[a-z0-9.-]+$/.test(ns) || !ns.includes(".")) return "";
  return ns.split(".").reverse().join(".");
}

/** @param {string} host @param {string} domain */
const onDomain = (host, domain) => Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));

/** Auth kind from a registry remote's declared headers. @param {any[]} headers */
function registryAuth(headers) {
  const hs = Array.isArray(headers) ? headers.filter(h => h && typeof h.name === "string") : [];
  if (!hs.length) return { auth: "unknown", headers: [] };
  const secret = hs.some(h => h.isSecret === true || /^(authorization|x-api-key|api-key)$/i.test(h.name));
  return { auth: secret ? "header" : "none", headers: hs.map(h => clean(h.name, 60)).filter(Boolean).slice(0, 8) };
}

/**
 * The entries of one page of the official registry (/v0/servers). Only the latest version of an active server, and only its remote (hosted) endpoints.
 * @param {any} page @returns {any[]}
 */
export function parseRegistryPage(page) {
  const out = [];
  for (const row of Array.isArray(page && page.servers) ? page.servers : []) {
    const s = row && row.server;
    const meta = row && row._meta && row._meta["io.modelcontextprotocol.registry/official"];
    if (!s || typeof s.name !== "string" || !Array.isArray(s.remotes)) continue;
    if (meta && (meta.isLatest === false || (meta.status && meta.status !== "active"))) continue;
    const domain = namespaceDomain(s.name);
    const remotes = s.remotes.filter((/** @type {any} */ r) => r && TRANSPORT[r.type] && typeof r.url === "string" && listable(r.url));
    remotes.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
      const host = new URL(r.url).hostname.toLowerCase();
      const a = registryAuth(r.headers);
      const vendor = domain || clean(String(s.name).split("/")[0].replace(/^io\.github\./, ""), 80);
      out.push({
        id: clean(remotes.length > 1 ? `${s.name}#${i + 1}` : s.name, 140),
        name: clean(s.title || String(s.name).split("/").pop(), 80),
        vendor,
        description: clean(s.description, 300),
        category: "other",
        url: r.url.replace(/\/+$/, ""),
        transport: TRANSPORT[r.type],
        auth: a.auth,
        headers: a.headers,
        verified: onDomain(host, domain),
        basis: onDomain(host, domain) ? `published under ${domain} on the official registry` : "listed on the official registry, vendor domain not matched",
        sources: [{ source: "registry", ref: clean(`${s.name}@${s.version || ""}`, 160) }],
      });
    });
  }
  return out;
}

/**
 * The entries of one plugin repo checkout. `plugins` is [{ plugin: <directory name>, author?: string, servers: { <key>: { type?, url?, headers?, oauth? } } }] read from each plugin's .mcp.json or plugin.json.
 * @param {{ repo: string, sha: string }} from @param {any[]} plugins @returns {any[]}
 */
export function parsePlugins(from, plugins) {
  const out = [];
  for (const p of plugins) {
    for (const [key, cfg] of Object.entries(p && p.servers && typeof p.servers === "object" ? p.servers : {})) {
      const c = /** @type {any} */ (cfg);
      const t = TRANSPORT[String(c && c.type)] || (c && c.url ? "http" : null);
      if (!t || !c || typeof c.url !== "string" || !listable(c.url)) continue;
      const names = c.headers && typeof c.headers === "object" ? Object.keys(c.headers) : [];
      const auth = c.oauth ? "oauth" : names.length ? "header" : "none";
      out.push({
        id: clean(`plugin:${p.plugin}/${key}`, 140),
        name: clean(key, 80),
        vendor: clean(p.author || p.plugin, 80),
        description: clean(p.description || "", 300),
        category: clean(p.plugin, 60) || "other",
        url: c.url.replace(/\/+$/, ""),
        transport: t,
        auth,
        headers: names.map(n => clean(n, 60)).filter(Boolean).slice(0, 8),
        verified: false,
        basis: `listed in ${clean(from.repo, 80)}@${clean(from.sha, 12)}, vendor not checked`,
        sources: [{ source: "plugin", ref: clean(`${from.repo}@${String(from.sha).slice(0, 12)}:${p.plugin}/${key}`, 200) }],
      });
    }
  }
  return out;
}

/** One entry per remote address: where two sources list the same address their facts merge (verified if either is, the more specific auth kind wins). @param {any[]} lists @returns {any[]} sorted by id */
export function mergeEntries(...lists) {
  /** @type {Map<string, any>} */ const byUrl = new Map();
  const rank = (/** @type {string} */ a) => ["unknown", "none", "header", "oauth"].indexOf(a);
  for (const e of lists.flat()) {
    const k = urlKey(e.url);
    if (!k) continue;
    const had = byUrl.get(k);
    if (!had) { byUrl.set(k, { ...e, sources: [...e.sources] }); continue; }
    const keep = e.verified && !had.verified ? e : had;
    byUrl.set(k, {
      ...keep,
      category: had.category !== "other" ? had.category : e.category,
      auth: rank(e.auth) > rank(had.auth) ? e.auth : had.auth,
      headers: [...new Set([...had.headers, ...e.headers])].slice(0, 8),
      verified: had.verified || e.verified,
      sources: [...had.sources, ...e.sources].slice(0, 6),
    });
  }
  return [...byUrl.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** What changed between two snapshots' entries, by id: { added, removed, changed: [{ id, fields }] }. @param {any[]} before @param {any[]} after */
export function diffCatalogs(before, after) {
  const a = new Map(before.map(e => [e.id, e])), b = new Map(after.map(e => [e.id, e]));
  const added = after.filter(e => !a.has(e.id)).map(e => e.id);
  const removed = before.filter(e => !b.has(e.id)).map(e => e.id);
  const changed = [];
  for (const e of after) {
    const o = a.get(e.id);
    if (!o) continue;
    const fields = Object.keys(e).filter(k => JSON.stringify(e[k]) !== JSON.stringify(o[k]));
    if (fields.length) changed.push({ id: e.id, fields });
  }
  return { added, removed, changed };
}

/** The diff as the text of a pull request: what appears, what goes and what moved, with the facts a reviewer needs for each new entry. @param {any[]} before @param {any[]} after */
export function diffMarkdown(before, after) {
  const d = diffCatalogs(before, after);
  const byId = new Map(after.map(e => [e.id, e]));
  const L = [`App catalog snapshot: ${d.added.length} new, ${d.removed.length} gone, ${d.changed.length} changed.`, ""];
  if (d.added.length) {
    L.push("## New (a person reads each before it can appear)", "");
    for (const id of d.added.slice(0, 200)) {
      const e = byId.get(id);
      L.push(`- \`${id}\` ${e.url} (${e.transport}, auth ${e.auth}, ${e.verified ? "verified" : "inferred"}: ${e.basis})`);
    }
    if (d.added.length > 200) L.push(`- and ${d.added.length - 200} more`);
    L.push("");
  }
  if (d.changed.length) { L.push("## Changed", ""); for (const c of d.changed.slice(0, 200)) L.push(`- \`${c.id}\`: ${c.fields.join(", ")}`); L.push(""); }
  if (d.removed.length) { L.push("## Gone", ""); for (const id of d.removed.slice(0, 200)) L.push(`- \`${id}\``); L.push(""); }
  return L.join("\n");
}

/** The preset id a connectable entry connects under: `x-`, a short readable slug and four hex digits of the entry id, so two entries never share one and no shipped vendor id is a prefix of it. @param {{ id: string, name: string }} e */
export function presetIdFor(e) {
  const slug = String(e.name || e.id).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 14).replace(/-+$/, "") || "app";
  return `x-${slug}-${createHash("sha1").update(String(e.id)).digest("hex").slice(0, 4)}`;
}

/** Whether the sign-in can start from this entry: the vendor published it on its own domain and it signs in with OAuth, or says nothing yet (a registry entry the probe has not classified). A key or token goes the token route. @param {any} e */
export function connectable(e) {
  return Boolean(e) && e.verified === true && (e.auth === "oauth" || e.auth === "unknown") && (e.transport === "http" || e.transport === "sse") && urlKey(e.url).startsWith("https://");
}

/**
 * Search the snapshot. `connected` is the set of address keys the Space already has a server for (urlKey), so each entry says whether it is connected and the list can be cut to either kind.
 * @param {any[]} entries @param {{ query?: string, category?: string, connected?: boolean, verified?: boolean, limit?: number, offset?: number }} q @param {Set<string>} [connectedKeys]
 */
export function searchCatalog(entries, q = {}, connectedKeys = new Set()) {
  const terms = String(q.query || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const limit = Math.min(100, Math.max(1, Math.floor(Number(q.limit)) || 25)), offset = Math.max(0, Math.floor(Number(q.offset)) || 0);
  const cat = String(q.category || "").toLowerCase();
  const scored = [];
  for (const e of entries) {
    const isConnected = connectedKeys.has(urlKey(e.url));
    if (q.connected === true && !isConnected) continue;
    if (q.connected === false && isConnected) continue;
    if (q.verified === true && !e.verified) continue;
    if (cat && String(e.category).toLowerCase() !== cat) continue;
    let score = 0;
    if (terms.length) {
      const name = `${e.name} ${e.id}`.toLowerCase(), vendor = String(e.vendor).toLowerCase(), desc = String(e.description).toLowerCase();
      for (const t of terms) {
        const s = name.includes(t) ? (name.startsWith(t) || e.name.toLowerCase() === t ? 6 : 4) : vendor.includes(t) ? 3 : desc.includes(t) ? 1 : 0;
        if (!s) { score = -1; break; }
        score += s;
      }
      if (score < 0) continue;
    }
    scored.push({ e, score: score + (e.verified ? 2 : 0), isConnected });
  }
  scored.sort((x, y) => y.score - x.score || (x.e.id < y.e.id ? -1 : 1));
  /** @type {Record<string, number>} */ const categories = {};
  for (const s of scored) categories[s.e.category] = (categories[s.e.category] || 0) + 1;
  return {
    total: scored.length,
    entries: scored.slice(offset, offset + limit).map(s => ({ ...s.e, connected: s.isConnected, oneClick: connectable(s.e), ...(connectable(s.e) ? { preset: presetIdFor(s.e) } : {}) })),
    categories,
  };
}
