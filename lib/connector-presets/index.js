// @ts-check
// The connector catalog as data (0.2 charter minimum 9). A preset names a vendor's OWN hosted MCP
// server and how a person signs in to it; it carries no code. presets.json is the whole list, and
// adding a vendor is adding an entry. The sign-in shape is not decided here: discovery decides it at
// connect time (a registration endpoint means dynamic registration), and the preset only says what
// to fall back to and how to describe it. Facts and their evidence: team/0.2/connectors-catalog.md.
//
// This file reads presets.json and answers questions about it, and adds one api preset for each OAuth connector declaration (records/connectors) so the one sign-in flow makes its
// credential. It imports nothing else, so the mcp hub (host binding) and the connectors module (connect flow) can both use it.

import fs from "node:fs";
import { DECLARATIONS, declared } from "../../records/connectors/index.js";

const FILE = JSON.parse(fs.readFileSync(new URL("./presets.json", import.meta.url), "utf8"));

/**
 * One api preset per OAuth connector declaration (auth.type "oauth"): the declaration's host, scopes and sign-in endpoints, signed in with the person's own OAuth app. The credential the flow
 * makes also carries the declaration's endpoint classes, rate and `service` rules (lib/connectors/connect.js), so it is a connector for Flows and watchers, not only for vault.request.
 * Google is not here: Gmail and Google Calendar declare auth.type "google", signed in through the google module, which is the one Google path (no vault credential, no preset).
 * Declarations that sign in the same way share one preset and one credential.
 * @param {any} _file
 */
function fromDeclarations(_file) {
  /** @type {Map<string, any[]>} */ const groups = new Map();
  for (const d of Object.values(DECLARATIONS)) if (d.auth.type === "oauth") groups.set(d.auth.authorize_uri, [...(groups.get(d.auth.authorize_uri) || []), d]);
  return [...groups.values()].map(ds => {
    const d = ds[0];
    const hosts = [...new Set(ds.map(x => new URL(x.base_url).hostname))], id = ds.length > 1 ? `${d.id}-group-api`.slice(0, 30) : `${d.id}-api`;
    const label = ds.map(x => x.label).join(" and ");
    return {
      id, label: `${label} for Flows and watchers`, group: "work", target: "api", evidence: "docs",
      who: `Anyone with a ${d.label} account. One sign-in lets Flows, watchers and assistants read ${label} through the vault. You sign in with an OAuth app of your own.`,
      api: { hosts, declarations: ds.map(x => x.id), use: `Ask your agent to use vault.request with the credential ${id}: reads run; sending, changing or deleting asks you first unless you asked for it. Flows reach it as the connector ${id}.` },
      oauth: { client: "byo", offline: true, scopes: [...new Set(ds.flatMap(x => x.auth.scopes || []))], server: { issuer: `https://${hosts[0]}`, authorize_uri: d.auth.authorize_uri, token_uri: d.auth.token_uri },
        help: `Vyre signs in with an OAuth app you register with ${d.label}.` },
    };
  });
}
const RAW = { ...FILE, presets: [...FILE.presets, ...fromDeclarations(FILE)] };

export const GROUPS = ["work", "crm", "dev", "marketing", "finance", "search", "google"];
export const CLIENTS = ["dcr", "byo"];
export const EVIDENCE = ["dcr-registered", "dcr-advertised", "docs"];
const ID = /^[a-z][a-z0-9-]{1,30}$/;
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

/** @param {string} why */
const bad = why => Object.assign(new Error(why), { code: "bad_input" });

/** The hosts a token minted for this preset may go to: the server's own host. @param {any} p */
export function hostsOf(p) {
  return p.target === "api" ? p.api.hosts.slice() : [new URL(p.url).hostname];
}

/** The origins the vault binds an item to (it takes origins, the hub takes host names). @param {any} p */
export function originsOf(p) {
  return p.target === "api" ? p.api.hosts.map(h => `https://${h}`) : [new URL(p.url).origin];
}

/** @param {any} g @param {string} at */
function validateGuide(g, at) {
  if (!g || typeof g !== "object" || !Array.isArray(g.steps) || !g.steps.length || !g.steps.every(x => typeof x === "string" && x)) throw bad(`${at}: a guide needs steps, a list of sentences`);
  for (const l of g.links || []) { try { if (new URL(l.url).protocol !== "https:" || typeof l.label !== "string") throw 0; } catch { throw bad(`${at}: a guide link is { label, url } with an https url`); } }
  if (g.manifest !== undefined) {
    let u; try { u = new URL(g.manifest.link + "x"); } catch { throw bad(`${at}: guide.manifest.link must be an https address`); }
    if (u.protocol !== "https:" || !g.manifest.json || typeof g.manifest.json !== "object") throw bad(`${at}: guide.manifest is { link, json }`);
  }
}

/** Throws with the reason when a preset entry is malformed. Used by the tests over the whole file. `loopback` lets a test fake use http on this machine. @param {any} p @param {{ loopback?: boolean }} [opts] */
export function validate(p, opts = {}) {
  const at = `preset ${String(p && p.id).slice(0, 40)}`;
  if (!p || typeof p !== "object") throw bad("a preset is an object");
  if (!ID.test(String(p.id))) throw bad(`${at}: id is lowercase letters, digits and dashes`);
  for (const k of ["label", "who"]) if (typeof p[k] !== "string" || !p[k].trim()) throw bad(`${at}: ${k} is required`);
  if (!GROUPS.includes(p.group)) throw bad(`${at}: group must be one of ${GROUPS.join(", ")}`);
  if (!EVIDENCE.includes(p.evidence)) throw bad(`${at}: evidence must be one of ${EVIDENCE.join(", ")}`);
  if (p.target !== "api" && !["http", "sse"].includes(p.transport)) throw bad(`${at}: transport is http or sse`);
  if (p.target !== undefined && !["mcp", "api"].includes(p.target)) throw bad(`${at}: target is mcp or api`);
  if (p.target === "api") {
    // Not an MCP server: a vault api-credential the agent uses through vault.request.
    if (p.url !== undefined) throw bad(`${at}: an api preset has hosts, not a url`);
    if (!p.api || !Array.isArray(p.api.hosts) || !p.api.hosts.length || !p.api.hosts.every(h => typeof h === "string" && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h))) throw bad(`${at}: api.hosts is a list of exact host names`);
    if (p.api.readers !== undefined && (!Array.isArray(p.api.readers) || !p.api.readers.every(r => r && r.module === "connectors" && Array.isArray(r.paths) && r.paths.length && r.paths.every(x => typeof x === "string" && x.startsWith("/"))))) throw bad(`${at}: api.readers lists the connectors module and the calendar paths it may read`);
    const names = p.api.declarations !== undefined ? p.api.declarations : p.api.declaration !== undefined ? [p.api.declaration] : null;
    if (names) {
      const ds = Array.isArray(names) ? names.map(n => declared(String(n))) : [];
      if (ds.some(d => d && d.auth.type === "google")) throw bad(`${at}: Google is signed in through the google module, not a vault credential`);
      if (!ds.length || ds.some(d => !d) || p.api.hosts.length !== new Set(ds.map(d => new URL(d.base_url).hostname)).size || !ds.every(d => p.api.hosts.includes(new URL(d.base_url).hostname))) throw bad(`${at}: api.declarations names connectors this build declares, on exactly their hosts`);
    }
    if (p.oauth && (p.oauth.client !== "byo" || !p.oauth.server)) throw bad(`${at}: an api sign-in is your own app (byo) and names its endpoints (oauth.server)`);
    if (p.via) throw bad(`${at}: an api preset has no via`);
  } else {
    let u;
    try { u = new URL(p.url); } catch { throw bad(`${at}: url is not an address`); }
    const local = opts.loopback && u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname);
    if ((u.protocol !== "https:" && !local) || u.username || u.password || u.search) throw bad(`${at}: url must be plain https, no user, no query`);
    if (/\/mcp\/anthropic|\/mcp\/openai/.test(u.pathname)) throw bad(`${at}: vendor client-specific endpoints refuse other clients`);
  }
  if (!p.oauth && !p.token) throw bad(`${at}: needs oauth or token`);
  if (p.oauth) {
    if (!CLIENTS.includes(p.oauth.client)) throw bad(`${at}: oauth.client is dcr or byo`);
    if (p.oauth.scopes !== undefined && !(Array.isArray(p.oauth.scopes) && p.oauth.scopes.every(s => typeof s === "string" && s))) throw bad(`${at}: oauth.scopes is a list of strings`);
    // Where the vendor's own metadata may send the code (and an own-app secret): the catalog names it, so a
    // vendor document, or a hostile one, cannot pick another server. Explicit endpoints pin themselves.
    if (p.target !== "api" && !p.oauth.server) {
      const okOrigin = o => { try { const u = new URL(o); return u.origin === o && (u.protocol === "https:" || (opts.loopback && u.protocol === "http:" && u.hostname === "127.0.0.1")); } catch { return false; } };
      if (p.oauth.as === undefined && opts.loopback) { /* a test fake names no pin */ }
      else if (!Array.isArray(p.oauth.as) || !p.oauth.as.length || !p.oauth.as.every(okOrigin)) throw bad(`${at}: oauth.as lists the authorization-server origins this app signs in with (https, no path)`);
    }
    if (p.oauth.port !== undefined && !(Number.isInteger(p.oauth.port) && p.oauth.port >= 1024 && p.oauth.port <= 65535)) throw bad(`${at}: oauth.port is 1024 to 65535`);
    if (p.oauth.server !== undefined) for (const k of ["authorize_uri", "token_uri"]) {
      try { const u = new URL(p.oauth.server[k]); if (u.protocol !== "https:" && !(opts.loopback && u.protocol === "http:" && u.hostname === "127.0.0.1")) throw 0; } catch { throw bad(`${at}: oauth.server.${k} must be an https address`); }
    }
    if (p.oauth.redirect !== undefined) {
      const r = p.oauth.redirect;
      if (!r || typeof r !== "object" || (r.scheme !== undefined && !["http", "https"].includes(r.scheme)) || (r.host !== undefined && !["127.0.0.1", "localhost"].includes(r.host)) || (r.path !== undefined && !["/", "/connect/callback"].includes(r.path))) throw bad(`${at}: oauth.redirect is { scheme: http|https, host: 127.0.0.1|localhost, path: /|/connect/callback }`);
      if (r.scheme === "https" && !p.oauth.port) throw bad(`${at}: an https redirect needs oauth.port`);
    }
    for (const g of [p.oauth.guide, p.token && p.token.guide]) if (g !== undefined) validateGuide(g, at);
    if (p.oauth.client === "byo" && !p.oauth.help) throw bad(`${at}: a byo sign-in needs help text`);
  }
  if (p.token) {
    if (typeof p.token.label !== "string" || typeof p.token.help !== "string") throw bad(`${at}: token needs a label and help`);
    if (p.token.header !== undefined && !HEADER.test(p.token.header)) throw bad(`${at}: token.header is not a header name`);
    if (p.token.format !== undefined && (!String(p.token.format).includes("{value}") || /[\r\n]/.test(p.token.format))) throw bad(`${at}: token.format needs {value}`);
    for (const x of p.token.extra || []) {
      if (!x || typeof x.name !== "string" || !HEADER.test(x.header || "") || typeof x.label !== "string") throw bad(`${at}: token.extra is { name, header, label }`);
    }
  }
  if (p.prefer !== undefined && !["oauth", "token"].includes(p.prefer)) throw bad(`${at}: prefer is oauth or token`);
  if (p.prefer && !p[p.prefer]) throw bad(`${at}: prefers ${p.prefer} but has none`);
  return p;
}

/**
 * A catalog over a list of presets. The shipped one is below; a test builds its own over fakes.
 * @param {{ checked?: string, presets: any[], unavailable?: any[] }} raw @param {{ loopback?: boolean }} [opts]
 */
export function makeCatalog(raw, opts = {}) {
  const list = raw.presets.map(p => validate(p, opts));
  const byId = new Map(list.map(p => [p.id, p]));
  if (byId.size !== list.length) throw new Error("a preset id is repeated");
  /** @param {string} name */
  const presetOfName = name => {
    const n = String(name);
    let best = null;
    for (const p of list) if ((n === p.id || n.startsWith(`${p.id}-`)) && (!best || p.id.length > best.id.length)) best = p;
    return best;
  };
  return {
    /** Every preset a person can connect, in file order. */
    presets: () => list.slice(),
    /** Vendors checked and ruled out, each with the reason, for a screen that says why. */
    unavailable: () => (raw.unavailable || []).slice(),
    preset: id => byId.get(String(id)) || null,
    checked: () => String(raw.checked || ""),
    presetOfName,
    /**
     * Host binding for the hub: an item named after a preset goes only to that preset's hosts. The
     * longest matching preset id wins (google-gmail before google).
     * @param {string} item @returns {{ prefix: string, hosts: string[] } | null}
     */
    boundFor: item => { const p = presetOfName(item); return p ? { prefix: `${p.id}-`, hosts: hostsOf(p) } : null; },
  };
}

export const SHIPPED_DATA = RAW;
const SHIPPED = makeCatalog(RAW);
const BY_ID = new Map(SHIPPED.presets().map(p => [p.id, p]));
export const presets = SHIPPED.presets;
export const unavailable = SHIPPED.unavailable;
export const preset = SHIPPED.preset;
export const checked = SHIPPED.checked;
export const presetOfName = SHIPPED.presetOfName;
export const boundFor = SHIPPED.boundFor;

/**
 * The connection name for a preset: the id itself, or the id and a label so a second account of the
 * same vendor has its own name (notion, notion-work). Names double as the vault item's prefix, which
 * is what binds the credential to the vendor's hosts.
 * @param {string} id @param {string} [label]
 */
export function connectionName(id, label) {
  const l = String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const name = l ? `${id}-${l}` : id;
  if (name.length > 32) throw bad(`${name.slice(0, 40)} is longer than 32 characters; use a shorter label`);
  return name;
}

/** The vault item that holds a connection's credential. Its prefix is the preset id. @param {string} name */
export const itemName = name => `${name}-auth`;

/**
 * The catalog a running box uses: always the shipped one. A person's own connector goes through the
 * add-an-MCP-server-by-URL path, never a preset, and a config file (which a model can edit) never
 * changes what a vendor's credential may be sent to. Tests, and only tests (VYRE_CONNECTORS_TEST_PRESETS=1 inside a node:test run), may add presets for fakes
 * on this machine; their ids may not overlap a shipped one, by name or prefix.
 * @param {{ connectors?: { presets?: any[] } } | undefined} config
 */
export function catalogFrom(config) {
  const extra = config && config.connectors && Array.isArray(config.connectors.presets) ? config.connectors.presets : [];
  // The switch counts only inside a node:test run, so it cannot be turned on in a running box by an env var alone.
  if (!extra.length || process.env.VYRE_CONNECTORS_TEST_PRESETS !== "1" || !process.env.NODE_TEST_CONTEXT) return SHIPPED;
  for (const p of extra) {
    const id = String(p && p.id);
    // No overlap by name or by prefix in either direction: a longer id would win the longest-match binding of a shipped vendor's items.
    for (const shipped of BY_ID.keys()) if (id === shipped || id.startsWith(`${shipped}-`) || shipped.startsWith(`${id}-`)) throw bad(`a test preset may not reuse or extend the shipped id ${shipped}`);
  }
  return makeCatalog({ ...RAW, presets: [...RAW.presets, ...extra] }, { loopback: true });
}
