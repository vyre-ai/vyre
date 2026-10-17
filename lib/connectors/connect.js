// @ts-check
// The connect flows, as ONE mechanism (0.2 charter minimum 9). A person picks a preset (lib/
// connector-presets) and this file turns it into a hub server row plus a vault item bound to the
// vendor's host. There is no code per vendor: the sign-in shape comes from the preset and from what
// discovery finds at connect time.
//
//   oauth, automatic   the vendor advertises dynamic client registration (RFC 7591): register, sign in
//   oauth, own app     it does not: the person's own client id (and secret) in a vault item, then sign in
//   token              a personal token, PAT or API key the person pastes, sent as a header
//
// Rules, and why:
// - Every credential is a vault item named <connection>-auth, granted to the hub and to this module,
//   with `hosts` set to the vendor's own host. The hub refuses to put that item on a row for any other
//   host (lib/connector-presets boundFor), and refuses to send its token to any other address.
// - The token a person pastes goes straight into the vault from this module's call; it is never logged,
//   never put in an event, and never comes back out of any tool here.
// - This file has no ctx. Everything it needs is injected, so the tests run it against fake OAuth and
//   fake MCP servers and never a real vendor.

import { connector } from "./oauth.js";
import { makeCatalog, connectionName, itemName, originsOf, hostsOf, SHIPPED_DATA } from "../connector-presets/index.js";
import { declared } from "../../records/connectors/index.js";
import { declarationParts, mergedParts } from "../../records/connectors/format.js";

export const MIGRATIONS = [
  `CREATE TABLE connectors_connections (
     name TEXT PRIMARY KEY, preset TEXT NOT NULL, item TEXT NOT NULL, mode TEXT NOT NULL,
     label TEXT, created INTEGER NOT NULL
   );`,
  // who may use the connection (the scope it was made with), so the Deck can show and change it
  `ALTER TABLE connectors_connections ADD COLUMN scope TEXT;`,
  // Connections made before "no scope" meant you and the assistant only were open to every project and agent, and their
  // hub rows say so; the apps that are vault credentials had no scope and stay for you and the assistant.
  `UPDATE connectors_connections SET scope = '{"projects":"*","agents":"*"}' WHERE scope IS NULL AND preset NOT IN ('microsoft','google-personal','slack-web');`,
  // Connections a person made from any app's API (records/connectors/connection.js): the declaration, the Vault item that holds the key, the check, and its light.
  // `item_updated` is when the derived credential was last written, so a credential changed behind the record's back shows as out of step.
  `CREATE TABLE connectors_made (
     id TEXT PRIMARY KEY, label TEXT NOT NULL, declaration TEXT NOT NULL, credential_item TEXT NOT NULL, credential_field TEXT, check_path TEXT NOT NULL,
     origin TEXT NOT NULL, made_by TEXT NOT NULL, light TEXT NOT NULL DEFAULT 'unknown', reason TEXT, checked_at INTEGER, item_updated INTEGER,
     created INTEGER NOT NULL, updated INTEGER NOT NULL
   );`,
  // the form as the person gave it (no key in it): the fixed values and the way the key is sent, so the form can be shown again
  `ALTER TABLE connectors_made ADD COLUMN form TEXT;`,
  // what an assistant proposed and the person has not yet said yes or no to: the form (no key in it), who proposed it, when
  `CREATE TABLE connectors_proposals (
     id TEXT PRIMARY KEY, form TEXT NOT NULL, proposed_by TEXT NOT NULL, why TEXT, created INTEGER NOT NULL
   );`,
  // the use of a website account, per day (core/connectors/governor.js): reads and writes made, when the last one was, whether a challenge stopped it, and a cooldown after a slowdown
  `CREATE TABLE connectors_site_gov (
     id TEXT PRIMARY KEY, day TEXT NOT NULL, reads INTEGER NOT NULL DEFAULT 0, writes INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL DEFAULT 0,
     stopped_at INTEGER, stopped_reason TEXT, cooldown_until INTEGER NOT NULL DEFAULT 0
   );`,
  // A sign-in the vendor no longer honours (a refresh that failed after one retry): the connection stays, its calls stop, and the person is asked to connect again. A new sign-in or a rotated token clears it.
  `ALTER TABLE connectors_connections ADD COLUMN needs_reconnect INTEGER NOT NULL DEFAULT 0;`,
  // A connection belongs to the person who made it: a member's connections are her own, the owner's keep person ''. The key is (person, name), so two people may each have a "notion".
  `CREATE TABLE connectors_connections_v2 (
     name TEXT NOT NULL, person TEXT NOT NULL DEFAULT '', preset TEXT NOT NULL, item TEXT NOT NULL, mode TEXT NOT NULL,
     label TEXT, created INTEGER NOT NULL, scope TEXT, needs_reconnect INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (person, name)
   );
   INSERT INTO connectors_connections_v2 (name, preset, item, mode, label, created, scope, needs_reconnect) SELECT name, preset, item, mode, label, created, scope, needs_reconnect FROM connectors_connections;
   DROP TABLE connectors_connections;
   ALTER TABLE connectors_connections_v2 RENAME TO connectors_connections;`,
];

/** The item fields a sign-in keeps, so a rotation can rewrite them and a reader can find them. */
export const TOKEN_FIELDS = ["client_id", "client_secret", "refresh_token", "access_token", "expires_at", "token_uri", "token_auth", "issuer", "resource", "scope"];

/** What a connection made from the catalog records about itself: its address, the entry, who made it and how it signs in. Set once at connect, kept through every refresh. */
export const CATALOG_FIELDS = ["server_url", "catalog_id", "connected_by", "auth_kind"];

/** What a refresh may change in a saved sign-in. */
export const ROTATED_FIELDS = ["refresh_token", "access_token", "expires_at", "scope"];
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TOKEN = 4096;

/** @param {string} msg @param {string} [code] */
const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });

/**
 * Who may use a connection: the same shape a hub server carries. Left out, a hub server is open to every project and
 * agent (as mcp.add does) and an api-credential is for the person and the assistant only.
 * @param {any} s @returns {{ projects: "*" | string[], agents: "*" | string[] } | undefined}
 */
export function cleanScope(s) {
  if (s === undefined || s === null) return undefined;
  if (typeof s !== "object" || Array.isArray(s)) throw fail('scope is { projects: "*" | [ids], agents: "*" | [names] }');
  const one = (v, what) => {
    if (v === undefined || v === "*") return "*";
    if (!Array.isArray(v) || v.length > 50 || !v.every(x => typeof x === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(x))) throw fail(`scope.${what} is "*" or a list of names`);
    return [...new Set(v)];
  };
  return { projects: one(s.projects, "projects"), agents: one(s.agents, "agents") };
}

/** Replace {redirect} in every string of a guide, and build the prefilled-app link from its manifest. @param {any} guide @param {string} redirect */
export function resolveGuide(guide, redirect) {
  if (!guide) return undefined;
  const sub = x => typeof x === "string" ? x.split("{redirect}").join(redirect) : Array.isArray(x) ? x.map(sub) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, sub(v)])) : x;
  const g = sub(guide);
  const links = [...(g.links || [])];
  if (g.manifest) links.unshift({ label: g.manifest.label || "Make the app with its settings filled in", url: g.manifest.link + encodeURIComponent(JSON.stringify(g.manifest.json)) });
  return { steps: g.steps || [], links };
}

/**
 * @typedef {{
 *   db: import("node:sqlite").DatabaseSync,
 *   fetchItem: (item: string, field?: string) => Promise<string>,
 *   save: (item: string, fields: Record<string, string>, opts: { kind: string, description: string, hosts: string[], grants?: string[] }) => Promise<void>,
 *   addServer: (input: Record<string, unknown>) => Promise<any>,
 *   testServer: (name: string) => Promise<any>,
 *   hasServer: (name: string) => Promise<boolean>,
 *   removeServer: (name: string) => Promise<void>,
 *   updateServer?: (input: Record<string, unknown>) => Promise<any>,
 *   putCredential?: (name: string, credential: { config: Record<string, unknown>, secret?: string, description: string }, as: string) => Promise<void>,
 *   removeCredential?: (name: string, as: string) => Promise<void>,
 *   storeTokens?: (name: string, tokens: Record<string, unknown>) => Promise<void>,
 *   grantThread?: (server: string, thread: string) => Promise<void>,
 *   saveMine?: (item: string, fields: Record<string, string>) => Promise<void>,   // a member's connection: stored in HER vault (vault.me.connect.put), never the owner's
 *   emit: (type: string, payload: Record<string, unknown>) => void,
 *   log?: (message: string, fields?: Record<string, unknown>) => void,
 *   fetch?: typeof fetch, now?: () => number, expiresMs?: number,
 *   catalog?: ReturnType<typeof makeCatalog>,
 *   snapshot?: ReturnType<typeof makeCatalog>,   // presets made from the reviewed catalog snapshot (lib/connector-presets/from-catalog.js): connectable, never listed
 *   external?: (presetId: string) => Promise<{ name: string, label?: string }[]>,
 * }} ConnectDeps
 */

/** The address the vendor sends the browser back to, as text for a guide (the port is a placeholder when it is free). @param {any} o */
function redirectOf(o) {
  if (!o) return "";
  const r = o.redirect || {};
  return `${r.scheme === "https" ? "https" : "http"}://${r.host === "localhost" ? "localhost" : "127.0.0.1"}:${o.port || "<port>"}${r.path === "/" ? "/" : "/connect/callback"}`;
}

/** @param {ConnectDeps} deps */
export function connections(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const db = deps.db;
  const curated = deps.catalog || makeCatalog(SHIPPED_DATA);
  const { presets, unavailable, checked } = curated;
  // A preset made from the catalog snapshot connects like a curated one but is not part of the curated list; the curated catalog is always asked first.
  const preset = (/** @type {string} */ id) => curated.preset(id) || (deps.snapshot ? deps.snapshot.preset(id) : null);
  const presetOfName = (/** @type {string} */ name) => {
    const a = curated.presetOfName(name), b = deps.snapshot ? deps.snapshot.presetOfName(name) : null;
    return a && b ? (b.id.length > a.id.length ? b : a) : a || b;
  };

  /** A connection of one person (`member`, the owner's own with ''). */
  const rowOf = (name, member = "") => db.prepare("SELECT * FROM connectors_connections WHERE name = ? AND person = ?").get(name, member);
  /** The short form of a person's id that tells their items apart in the Vault and the hub: the first six characters after the prefix. @param {string} member */
  const shortOf = member => String(member).replace(/^per_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toLowerCase();
  /** The sign-ins a person is finishing right now with the address the browser landed on (`finish`), so a member's sign-in is completed only inside her own call. */
  const finishing = new Set();

  // The oauth engine. Its `complete` runs once the vendor sends the person back with a code.
  const oauth = connector({
    fetchItem: deps.fetchItem,
    fetch: deps.fetch,
    expiresMs: deps.expiresMs,
    log,
    emit: (type, payload) => deps.emit(type === "connect.connected" ? "connectors.connected" : "connectors.connect-failed", payload),
    complete: async (flow, tokens) => {
      const pending = /** @type {any} */ (pendingFor.get(flow.id));
      if (!pending) throw fail("that sign-in is no longer open; start a new one");
      // A member's connection is made inside her own call (her claim is what names whose row and vault it is): the vendor's redirect to this machine has none, so it waits for her pasted address.
      if (pending.member && !finishing.has(flow.id)) throw fail("finish this sign-in with the address the browser landed on (connectors.connect.finish)", "needs_finish");
      pendingFor.delete(flow.id);
      const p = preset(pending.preset);
      if (!p) throw fail("that connector is no longer in the catalog", "not_found");
      if (p.target === "api") {
        // Not a hub server: the person-written api-credential (made as the person who started this),
        // then the sign-in sealed into it by the vault, which checks the token endpoint.
        const o = p.oauth;
        await putApi(p, pending.name, { auth: { type: "oauth", client: { item: `${pending.name}-app` }, authorize_uri: o.server.authorize_uri, token_uri: o.server.token_uri, scopes: o.scopes || [] } }, undefined, pending.as, pending.scope);
        // A credential this sign-in just made is taken back out if its tokens cannot be stored, so none is left tokenless.
        const fresh = !rowOf(pending.name);
        try {
          await deps.storeTokens(pending.name, { access_token: tokens.access_token, ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
          ...(tokens.expires_in ? { expires_in: tokens.expires_in } : {}), token_uri: tokens.token_uri });
        } catch (e) {
          if (fresh && deps.removeCredential) { try { await deps.removeCredential(pending.name, String(pending.as || "")); } catch (x) { log("could not take back the credential", { name: pending.name }); } }
          throw e;
        }
        record(p, pending.name, pending.name, "oauth", pending.label, pending.scope);
        return { name: pending.name, ...useOf(p, pending.name) };
      }
      const member = pending.member || "";
      const item = itemName(member ? `${pending.name}-${shortOf(member)}` : pending.name);
      /** @type {Record<string, string>} */
      const fields = { client_id: tokens.client_id, token_uri: tokens.token_uri, issuer: tokens.issuer,
        // The token is bound to the address we connect to, which is what discovery started from.
        resource: p.url, access_token: tokens.access_token };
      if (flow.client.client_secret) fields.client_secret = flow.client.client_secret;
      if (tokens.refresh_token) fields.refresh_token = tokens.refresh_token;
      if (tokens.expires_in) fields.expires_at = String(tokens.obtained_at + tokens.expires_in * 1000);
      if (tokens.scope) fields.scope = tokens.scope;
      if (tokens.token_auth) fields.token_auth = tokens.token_auth;
      // A connection made from the catalog records what it is for and who made it (the person's id, from the verified call, never from input). The vault's own check of these is the vault's.
      if (p.catalog) Object.assign(fields, { server_url: p.url, catalog_id: p.catalog.id, auth_kind: "oauth", ...(pending.by ? { connected_by: pending.by } : {}) });
      if (member) {
        // Her own vault, as a connection item that names its server and how it signs in (the Vault forces who made it); the hub row points at it by name.
        if (!deps.saveMine) throw fail("this box cannot keep a member's connection yet", "config");
        await deps.saveMine(item, { ...fields, server_url: p.url, auth_kind: "oauth", ...(p.catalog ? { catalog_id: p.catalog.id } : {}) });
        const mine = await bind(p, pending.name, item, "oauth", pending.label, { type: "oauth", connection: item }, {}, pending.scope, member);
        return { name: pending.name, item, ...mine };
      }
      await deps.save(item, fields, { kind: "env-set", description: `${p.label} sign-in (made by Vyre)`, hosts: originsOf(p) });
      const out = await bind(p, pending.name, item, "oauth", pending.label, { type: "oauth", item }, {}, pending.scope);
      return { name: pending.name, item, ...out };
    },
  });
  /** @type {Map<string, { preset: string, name: string, label?: string, as?: string, by?: string, member?: string, scope?: any }>} */
  const pendingFor = new Map();

  /** What the agent is told to use once an api connection exists. */
  const useOf = (p, name) => ({ use: { tool: "vault.request", credential: name, hosts: p.api.hosts, ...(p.api.use ? { how: p.api.use } : {}) } });

  const record = (p, name, item, mode, label, scope, member = "") => db.prepare("INSERT OR REPLACE INTO connectors_connections (name, person, preset, item, mode, label, created, scope) VALUES (?,?,?,?,?,?,?,?)")
    .run(name, member, p.id, item, mode, label || null, now(), scope ? JSON.stringify(scope) : null);
  const scopeOf = row => { try { return row && row.scope ? JSON.parse(row.scope) : null; } catch { return null; } };

  /** Make (or replace) the person's api-credential. Only a person's own surface may write one, so this is relayed as the caller that asked. */
  async function putApi(p, name, config, secret, as, scope) {
    if (!deps.putCredential) throw fail("this box has no vault api-credential support", "config");
    // readers: the calendar paths the connectors module may read (the Capsule's next-meeting line), named here so connecting is the grant.
    // A preset made from a connector declaration also carries the declaration's endpoint classes, rate and `service` rules: the credential is a connector for Flows and watchers.
    const decNames = p.api.declarations || (p.api.declaration ? [p.api.declaration] : []);
    const decs = decNames.map((/** @type {string} */ n) => declared(String(n))).filter(Boolean);
    const parts = decs.length ? (decs.length === 1 ? declarationParts(decs[0]) : (({ endpoints, service, rate }) => ({ endpoints, service, rate }))(mergedParts(decs))) : null;
    const full = { ...config, hosts: p.api.hosts, ...(parts ? { endpoints: parts.endpoints, service: parts.service, ...(parts.rate ? { rate: parts.rate } : {}) } : {}), ...(p.api.endpoints ? { endpoints: p.api.endpoints } : {}), ...(p.api.readers ? { readers: p.api.readers } : {}), ...(scope ? { scope } : {}) };
    await deps.putCredential(name, { config: full, ...(secret ? { secret } : {}), description: `${p.label} (made by Vyre)` }, String(as || ""));
  }

  /** Add or refresh the hub row, remember the connection, and try the server once. */
  async function bind(p, name, item, mode, label, auth, headers, scope, member = "") {
    const had = await deps.hasServer(name);
    // A row of this name that is not this connection (another url, another credential) is never taken over.
    if (had && typeof had === "object" && (String(had.url || "") !== p.url || had.auth?.type !== auth.type || (had.auth?.item ?? had.auth?.connection) !== (auth.item ?? auth.connection))) {
      throw fail(`a server named ${name} already exists and is not this ${p.label} connection; remove it first`, "conflict");
    }
    /** @type {any} */ let test = null;
    if (had) test = await deps.testServer(name);
    else {
      const r = await deps.addServer({ name, transport: p.transport, url: p.url, auth, ...(Object.keys(headers).length ? { headers } : {}), ...(scope ? { scope } : {}) });
      test = r && r.test;
    }
    record(p, name, item, mode, label, scope, member);
    return { tools: test && typeof test.tools === "number" ? test.tools : Array.isArray(test?.tools) ? test.tools.length : undefined,
      ...(test && test.ok === false ? { warning: String(test.error || "the server did not answer yet").slice(0, 300) } : {}) };
  }

  const modeOf = (p, want) => {
    const m = want || p.prefer || (p.oauth ? "oauth" : "token");
    if (!["oauth", "token"].includes(m)) throw fail("mode is oauth or token");
    if (!p[m]) throw fail(`${p.label} has no ${m} sign-in; it offers ${p.oauth ? "oauth" : "token"}`);
    return m;
  };

  return {
    /**
     * The catalog: every preset with its modes and which of the person's connections use it, and the
     * vendors that were ruled out with the reason. Never a value.
     * @param {{ group?: string, all?: boolean }} [input] @param {{ member?: string }} [who] a member sees only her own connections
     */
    async catalog(input = {}, who = {}) {
      const mine = db.prepare("SELECT name, preset, mode, label, created, scope FROM connectors_connections WHERE person = ? ORDER BY name").all(who.member || "");
      const list = presets().filter(p => !input.group || p.group === input.group).map(p => ({
        id: p.id, label: p.label, group: p.group, who: p.who, evidence: p.evidence,
        target: p.target || "mcp",
        modes: [p.oauth ? "oauth" : null, p.token ? "token" : null].filter(Boolean),
        prefer: p.prefer || (p.oauth ? "oauth" : "token"),
        // what the person must bring: nothing, their own app, or a token
        setup: p.via ? "via" : (p.prefer === "token" || !p.oauth) ? "token" : p.oauth.client === "byo" ? "app" : "none",
        ...(p.oauth && p.oauth.guide || p.token && p.token.guide ? { guided: true } : {}),
        ...(p.note ? { note: p.note } : {}), ...(p.via ? { via: p.via } : {}),
        connected: mine.filter(c => c.preset === p.id).map(c => ({ name: c.name, mode: c.mode, ...(c.label ? { label: c.label } : {}), scope: scopeOf(c) })),
      }));
      // An app another module signs in to (GitHub) shows the accounts that module holds.
      if (deps.external) for (const p of list) if (p.via) { try { p.connected = (await deps.external(p.id)).map(c => ({ name: c.name, mode: "via", ...(c.label ? { label: c.label } : {}) })); } catch { /* the other module is not running */ } }
      return { checked: checked(), presets: list, ...(input.all ? { unavailable: unavailable() } : {}) };
    },

    /**
     * The # picker's connector kind: the connections that exist, then one "Connect <name>" row for each
     * app that is not connected yet (its id starts with connect:, and the surface opens the connect flow).
     * @param {{ q?: string, limit?: number }} [input]
     */
    mentionSearch(input = {}) {
      const q = String(input.q || "").trim().toLowerCase();
      const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 60);
      const hit = (...texts) => !q || texts.some(t => String(t).toLowerCase().includes(q));
      const mine = db.prepare("SELECT name, preset, mode, label FROM connectors_connections WHERE person = '' ORDER BY name").all();
      /** @type {any[]} */ const out = [];
      for (const c of mine) {
        const p = preset(c.preset);
        if (!p || !hit(c.name, p.label)) continue;
        out.push({ kind: "connector", id: c.name, name: c.label ? `${p.label} (${c.label})` : p.label, hint: "Connected", icon: "plug" });
      }
      const have = new Set(mine.map(c => c.preset));
      for (const p of presets()) {
        if (out.length >= limit) break;
        if (have.has(p.id) || p.via || !hit(p.id, p.label)) continue;
        out.push({ kind: "connector", id: `connect:${p.id}`, name: `Connect ${p.label}`, hint: "Not connected", icon: "plug" });
      }
      return out.slice(0, limit);
    },

    /**
     * What tagging a connection means for one thread: its hub server's tools are usable there (reads run,
     * anything outward follows the Gate). An api connection is used through vault.request, which the
     * person's own words already cover, so it only gets a note.
     * @param {{ id: string, thread: string }} input
     */
    async mentionResolve(input) {
      const id = String(input.id || "");
      const c = /^connect:/.test(id) ? null : rowOf(id);
      if (!c) throw fail(`no connection ${id.slice(0, 40)}`, "not_found");
      const p = preset(c.preset);
      if (!p) throw fail("that connector is no longer in the catalog", "not_found");
      const name = c.label ? `${p.label} (${c.label})` : p.label;
      if (p.target === "api") {
        return { name, hint: "Connected", hosts: p.api.hosts, note: `${name} is used through vault.request with the credential ${c.name}. ${p.api.use || ""}`.trim() };
      }
      if (deps.grantThread) await deps.grantThread(c.name, String(input.thread || ""));
      return { name, hint: "Connected", hosts: hostsOf(p), grant: { use: true, hosts: hostsOf(p) },
        note: `${name} is connected. Its tools are named ${c.name}__<tool> in the tool list. Reads run at once; anything that sends or changes something follows the Gate.` };
    },

    /** The names of this box's connections to any of these presets. @param {string[]} presetIds */
    namesOf(presetIds) {
      return db.prepare("SELECT name, preset FROM connectors_connections WHERE person = '' ORDER BY name").all().filter(r => presetIds.includes(r.preset)).map(r => ({ name: String(r.name), preset: String(r.preset) }));
    },

    /**
     * Change who may use a connection. `scope: null` is the default again. A hub server's row is updated; an api
     * credential is rebuilt from its preset and written as the person who asked (the vault keeps its stored sign-in).
     * @param {{ name: string, scope: any }} input @param {{ as?: string }} who
     */
    async setScope(input, who = {}) {
      const name = String(input.name || "");
      const row = rowOf(name);
      if (!row) throw fail(`no connection ${name.slice(0, 40)}`, "not_found");
      const p = preset(row.preset);
      if (!p) throw fail("that connector is no longer in the catalog", "not_found");
      const scope = cleanScope(input.scope);
      if (p.target === "api") {
        if (!deps.putCredential) throw fail("this box has no vault api-credential support", "config");
        const t = p.token;
        const auth = row.mode === "token"
          ? { type: "bearer", ...(t && t.header ? { header: String(t.header).toLowerCase() } : {}), ...(t && t.format ? { format: t.format } : {}) }
          : { type: "oauth", client: { item: `${name}-app` }, authorize_uri: p.oauth.server.authorize_uri, token_uri: p.oauth.server.token_uri, scopes: p.oauth.scopes || [] };
        // No secret: the vault carries the stored one over for a person's own put.
        await putApi(p, name, { auth }, undefined, String(who.as || ""), scope);
      } else {
        if (!deps.updateServer) throw fail("this box has no hub", "config");
        // null is the hub's own default: you and the assistant only.
        await deps.updateServer({ name, scope: scope || null });
      }
      db.prepare("UPDATE connectors_connections SET scope = ? WHERE name = ? AND person = ''").run(scope ? JSON.stringify(scope) : null, name);
      deps.emit("connectors.scope-changed", { name });
      return { name, scope: scope || null };
    },

    /** The connections this box has made: the owner's, or with `member` that person's own. @param {{ member?: string }} [who] */
    list(who = {}) {
      return db.prepare("SELECT name, preset, mode, label, created, scope, needs_reconnect FROM connectors_connections WHERE person = ? ORDER BY name").all(who.member || "")
        .map(c => ({ ...c, label: preset(c.preset)?.label || c.preset, scope: scopeOf(c), needs_reconnect: Boolean(c.needs_reconnect) }));
    },

    /**
     * Connect a preset. Answers one of: { step: "open", id, url } (open this address, the sign-in
     * finishes on its own or with `finish`), { step: "needs", needs: "token" | "client", ... } (ask the
     * person for it and call again), { step: "via", via } (another module owns this sign-in), or
     * { step: "connected", name, tools } (a token was stored and the server answered).
     * `token` is accepted only when the caller says it is a person's own surface.
     * @param {{ preset: string, label?: string, name?: string, mode?: string, client?: string, scope?: { projects?: "*" | string[], agents?: "*" | string[] }, app?: { client_id: string, client_secret?: string }, token?: string, extra?: Record<string, string>, replace?: boolean }} input
     * @param {{ person: boolean, as?: string, by?: string, member?: string }} who `by` is the verified person's id, kept with a catalog connection. `member` is the person's id when the caller is a member (not the owner): the connection is hers, in her vault and her hub row.
     */
    async start(input, who) {
      const wanted = String(input.preset || "");
      const gone = unavailable().find(u => u.id === wanted);
      if (gone) throw fail(`${gone.label} cannot be connected: ${gone.reason}`, "unavailable");
      const p = preset(wanted);
      if (!p) throw fail(`no connector named ${wanted.slice(0, 40)}; connectors.catalog lists them`, "not_found");
      const member = who.member || "";
      if (member && (p.target === "api" || p.via)) throw fail(`${p.label} is connected by an owner or an admin; ask them, or add a server of your own under Your accounts`, "denied");
      if (member && p.oauth && p.oauth.client === "byo" && !p.token) throw fail(`${p.label} needs an app made in your team's own account first, which an owner or an admin sets up`, "denied");
      const name = input.name ? String(input.name) : connectionName(p.id, input.label);
      if (!NAME.test(name)) throw fail("name is lowercase letters, digits and dashes, starting with a letter, at most 32");
      if (presetOfName(name)?.id !== p.id) throw fail(`a ${p.label} connection is named ${p.id} or starts with ${p.id}-`);
      if (rowOf(name, member) && !input.replace) throw fail(`${name} is already connected; disconnect it first, add a label for a second account, or pass replace`, "conflict");
      const mode = modeOf(p, input.mode);
      const scope = cleanScope(input.scope);

      if (mode === "token") {
        const t = p.token;
        const need = { step: "needs", needs: "token", preset: p.id, name, label: t.label, help: t.help, ...(t.guide ? { guide: resolveGuide(t.guide, redirectOf(p.oauth)) } : {}),
          extra: (t.extra || []).map(x => ({ name: x.name, label: x.label, required: x.required !== false })) };
        if (input.token === undefined) return need;
        if (!who.person) throw fail("a token is pasted by the person, on their own screen", "denied");
        const value = String(input.token).trim();
        if (!value || value.length > MAX_TOKEN || /[\r\n]/.test(value)) throw fail("the token must be one line, up to 4096 characters");
        /** @type {Record<string, string>} */ const headers = {};
        for (const x of t.extra || []) {
          const v = input.extra && input.extra[x.name] !== undefined ? String(input.extra[x.name]).trim() : "";
          if (!v && x.required !== false) throw fail(`${x.label} is needed`);
          if (v) { if (/[\r\n]/.test(v) || v.length > 200) throw fail(`${x.label} must be one short line`); headers[x.header] = v; }
        }
        if (p.target === "api") {
          await putApi(p, name, { auth: { type: "bearer", ...(t.header ? { header: String(t.header).toLowerCase() } : {}), ...(t.format ? { format: t.format } : {}) } }, value, who.as, scope);
          record(p, name, name, "token", input.label, scope);
          deps.emit("connectors.connected", { name, preset: p.id, mode });
          log("connector connected", { name, preset: p.id, mode });
          return { step: "connected", name, ...useOf(p, name) };
        }
        // A member's connection sends its token as `Authorization: Bearer`; an app whose token goes in another header or format is the owner's to set up.
        if (member && (t.header || t.format)) throw fail(`${p.label} needs its token sent in a special way, which an owner or an admin sets up`, "denied");
        const item = itemName(member ? `${name}-${shortOf(member)}` : name);
        const style = { ...(t.header ? { header: String(t.header).toLowerCase() } : {}), ...(t.format ? { format: t.format } : {}) };
        if (member) {
          if (!deps.saveMine) throw fail("this box cannot keep a member's connection yet", "config");
          await deps.saveMine(item, { value, server_url: p.url, auth_kind: "bearer" });
        } else await deps.save(item, { value }, { kind: "api-key", description: `${p.label} token (made by Vyre)`, hosts: originsOf(p) });
        const auth = member ? { type: "bearer", connection: item } : { type: "bearer", item, field: "value", ...style };
        const out = await bind(p, name, item, "token", input.label, auth, headers, scope, member);
        deps.emit("connectors.connected", { name, preset: p.id, mode });
        log("connector connected", { name, preset: p.id, mode });
        return { step: "connected", name, ...out };
      }

      if (p.via) return { step: "via", via: p.via, preset: p.id, name, message: p.note || `${p.label} signs in through its own module.` };

      // oauth
      const o = p.oauth;
      const redirectText = redirectOf(o);
      let client = input.client ? String(input.client) : "";
      if (o.client === "byo" && !client) {
        const appItem = `${name}-app`;
        if (input.app) {
          // The person's own OAuth app, typed in on their own screen: it goes to the vault here, so
          // there is no separate `vault put` for them to get wrong.
          if (!who.person) throw fail("an app's client ID and secret are entered by the person, on their own screen", "denied");
          const id = String(input.app.client_id || "").trim(), secret = String(input.app.client_secret || "").trim();
          if (!id || id.length > 512 || /\s/.test(id)) throw fail("the client ID is needed, on one line");
          if (secret.length > 1024 || /[\r\n]/.test(secret)) throw fail("the client secret must be one line");
          await deps.save(appItem, { client_id: id, ...(secret ? { client_secret: secret } : {}) }, { kind: "env-set", description: `${p.label} OAuth app (made by Vyre)`, hosts: [], grants: ["connectors"] });
          client = appItem;
        } else {
          try { if (await deps.fetchItem(appItem, "client_id")) client = appItem; } catch { /* not made yet */ }
        }
        if (!client) {
          return { step: "needs", needs: "client", preset: p.id, name, help: o.help, ...(redirectText ? { redirect: redirectText } : {}),
            ...(o.guide ? { guide: resolveGuide(o.guide, redirectText) } : {}),
            fields: [{ name: "client_id", label: "Client ID", secret: false, required: true }, { name: "client_secret", label: "Client secret", secret: true, required: o.public !== true }] };
        }
      }
      if (client && !ITEM.test(client)) throw fail("client names a vault item");
      /** @type {any} */ let started;
      try {
        // A vendor whose authorize call takes no `resource` (Google) names its endpoints; the token
        // is still recorded as minted for the server's own address.
        started = await oauth.start({ name, ...(o.server ? { server: o.server, bind: [p.target === "api" ? `https://${p.api.hosts[0]}/` : p.url] } : { resource: p.url }),
          scopes: o.scopes || [], offline: Boolean(o.offline),
          ...(o.port ? { port: o.port } : {}), ...(o.as ? { pin: o.as } : {}), ...(client ? { client } : {}),
          ...(o.redirect ? { redirect: o.redirect } : {}), ...(o.basic ? { basic: true } : {}) });
      } catch (e) {
        const err = /** @type {any} */ (e);
        // The vendor stopped offering automatic registration since the catalog was checked.
        if (err && err.code === "no_dcr") {
          if (p.token) return { step: "needs", needs: "token", preset: p.id, name, label: p.token.label, help: `${p.label} no longer registers apps automatically. ${p.token.help}`,
            extra: (p.token.extra || []).map(x => ({ name: x.name, label: x.label, required: x.required !== false })) };
          return { step: "needs", needs: "client", preset: p.id, name, help: `${p.label} no longer registers apps automatically. Make an OAuth app in your ${p.label} account and enter its client ID and secret.`,
            fields: [{ name: "client_id", label: "Client ID", secret: false, required: true }, { name: "client_secret", label: "Client secret", secret: true, required: false }] };
        }
        throw e;
      }
      pendingFor.set(started.id, { preset: p.id, name, ...(member ? { member } : {}), ...(input.label ? { label: input.label } : {}), ...(who.as ? { as: who.as } : {}), ...(who.by ? { by: String(who.by) } : {}), ...(scope ? { scope } : {}) });
      log("connector sign-in started", { name, preset: p.id });
      return { step: "open", id: started.id, url: started.url, redirect: started.redirect, host: started.host, name, preset: p.id };
    },

    /** The address the browser landed on, pasted, for a person whose browser is not on this machine. A sign-in is finished only by the person who started it. @param {{ id: string, url: string }} input @param {{ member?: string }} [who] */
    async finish(input, who = {}) {
      const id = String(input.id);
      const pending = pendingFor.get(id);
      if (pending && (pending.member || "") !== (who.member || "")) throw fail("that sign-in was started by someone else", "denied");
      finishing.add(id);
      try {
        const r = await oauth.finish(input);
        return { step: "connected", ...r };
      } finally { finishing.delete(id); }
    },

    /** @param {{ id: string }} input */
    async cancel(input, who = {}) {
      const pending = pendingFor.get(String(input.id));
      if (pending && (pending.member || "") !== (who.member || "")) throw fail("that sign-in was started by someone else", "denied");
      pendingFor.delete(String(input.id));
      return oauth.cancel(input);
    },

    /**
     * Disconnect: the hub row goes, the connection record goes. The vault item is left where it is
     * (a person removes items in the vault), as `mcp.remove` does.
     * @param {{ name: string }} input @param {{ member?: string }} [who] a member disconnects only her own
     */
    async disconnect(input, who = {}) {
      const name = String(input.name || ""), member = who.member || "";
      if (!rowOf(name, member)) throw fail(`no connection ${name.slice(0, 40)}`, "not_found");
      const pr = preset(rowOf(name, member).preset);
      if (!(pr && pr.target === "api") && await deps.hasServer(name)) await deps.removeServer(name);
      db.prepare("DELETE FROM connectors_connections WHERE name = ? AND person = ?").run(name, member);
      deps.emit("connectors.disconnected", { name });
      return { name, removed: true };
    },

    /**
     * A rotated refresh token, from the hub, into the item this module made. Only fields a sign-in
     * keeps are accepted, and only for an item of one of this module's own connections.
     * @param {{ item: string, fields: Record<string, string> }} input
     */
    async persist(input) {
      const c = db.prepare("SELECT * FROM connectors_connections WHERE item = ? AND person = ''").get(String(input.item || ""));
      if (!c) throw fail("that item is not a connector sign-in", "not_found");
      const p = preset(c.preset);
      const next = {};
      for (const f of TOKEN_FIELDS) {
        let v = input.fields && input.fields[f];
        if (v === undefined) { try { v = await deps.fetchItem(c.item, f); } catch { v = undefined; } }
        if (typeof v === "string" && v) next[f] = v;
      }
      // What a catalog connection recorded about itself is kept as it was; a refresh never sets it.
      for (const f of CATALOG_FIELDS) { try { const v = await deps.fetchItem(c.item, f); if (typeof v === "string" && v) next[f] = v; } catch { /* a curated connection has none */ } }
      // The hub sends back only what a refresh produces; the client, token address and issuer stay as the sign-in left them.
      for (const k of Object.keys(input.fields || {})) if (!ROTATED_FIELDS.includes(k)) throw fail(`${k.slice(0, 40)} is not a field a refresh changes`);
      await deps.save(c.item, /** @type {Record<string, string>} */ (next), { kind: "env-set", description: `${p ? p.label : c.preset} sign-in (made by Vyre)`, hosts: p ? originsOf(p) : [] });
      db.prepare("UPDATE connectors_connections SET needs_reconnect = 0 WHERE item = ?").run(c.item);
      return { saved: true };
    },

    /**
     * The hub could not use this sign-in even after one refresh: the connection is marked so the person is asked to connect again, once (a second report changes nothing). Only the hub calls it.
     * @param {{ item: string }} input
     */
    needsReconnect(input) {
      const c = db.prepare("SELECT name, person, needs_reconnect FROM connectors_connections WHERE item = ? AND mode = 'oauth'").get(String(input.item || ""));
      if (!c) return { marked: false };
      if (!c.needs_reconnect) {
        db.prepare("UPDATE connectors_connections SET needs_reconnect = 1 WHERE name = ? AND person = ?").run(c.name, c.person);
        deps.emit("connectors.needs-reconnect", { name: String(c.name) });
      }
      return { marked: true, name: String(c.name) };
    },

    stop: () => oauth.stop(),
  };
}
