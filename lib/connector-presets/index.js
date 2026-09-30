// @ts-check
// The connector catalog as data (0.2 charter minimum 9). A preset names a vendor's OWN hosted MCP
// server and how a person signs in to it; it carries no code. presets.json is the whole list, and
// adding a vendor is adding an entry. The sign-in shape is not decided here: discovery decides it at
// connect time (a registration endpoint means dynamic registration), and the preset only says what
// to fall back to and how to describe it. Facts and their evidence: team/0.2/connectors-catalog.md.
//
// This file reads presets.json and answers questions about it. It imports nothing else, so the mcp
// hub (host binding) and the connectors module (connect flow) can both use it.

import fs from "node:fs";

const RAW = JSON.parse(fs.readFileSync(new URL("./presets.json", import.meta.url), "utf8"));

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
 * The catalog a running box uses: the shipped one, plus any presets a config names under
 * `connectors.presets` (test fakes on this machine; a person's own extra vendors later).
 * @param {{ connectors?: { presets?: any[] } } | undefined} config
 */
export function catalogFrom(config) {
  const extra = config && config.connectors && Array.isArray(config.connectors.presets) ? config.connectors.presets : [];
  return extra.length ? makeCatalog({ ...RAW, presets: [...RAW.presets, ...extra] }, { loopback: true }) : SHIPPED;
}
