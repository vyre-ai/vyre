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
import { makeCatalog, connectionName, itemName, originsOf, hostsOf, SHIPPED_DATA } from "../../lib/connector-presets/index.js";

export const MIGRATIONS = [
  `CREATE TABLE connectors_connections (
     name TEXT PRIMARY KEY, preset TEXT NOT NULL, item TEXT NOT NULL, mode TEXT NOT NULL,
     label TEXT, created INTEGER NOT NULL
   );`,
];

/** The item fields a sign-in keeps, so a rotation can rewrite them and a reader can find them. */
export const TOKEN_FIELDS = ["client_id", "client_secret", "refresh_token", "access_token", "expires_at", "token_uri", "token_auth", "issuer", "resource", "scope"];

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TOKEN = 4096;

/** @param {string} msg @param {string} [code] */
const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });

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
 *   putCredential?: (name: string, credential: { config: Record<string, unknown>, secret?: string, description: string }, as: string) => Promise<void>,
 *   storeTokens?: (name: string, tokens: Record<string, unknown>) => Promise<void>,
 *   grantThread?: (server: string, thread: string) => Promise<void>,
 *   emit: (type: string, payload: Record<string, unknown>) => void,
 *   log?: (message: string, fields?: Record<string, unknown>) => void,
 *   fetch?: typeof fetch, now?: () => number, expiresMs?: number,
 *   catalog?: ReturnType<typeof makeCatalog>,
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
  const { preset, presets, unavailable, presetOfName, checked } = deps.catalog || makeCatalog(SHIPPED_DATA);

  const rowOf = name => db.prepare("SELECT * FROM connectors_connections WHERE name = ?").get(name);

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
      pendingFor.delete(flow.id);
      const p = preset(pending.preset);
      if (!p) throw fail("that connector is no longer in the catalog", "not_found");
      if (p.target === "api") {
        // Not a hub server: the person-written api-credential (made as the person who started this),
        // then the sign-in sealed into it by the vault, which checks the token endpoint.
        const o = p.oauth;
        await putApi(p, pending.name, { auth: { type: "oauth", client: { item: `${pending.name}-app` }, authorize_uri: o.server.authorize_uri, token_uri: o.server.token_uri, scopes: o.scopes || [] } }, undefined, pending.as);
        await deps.storeTokens(pending.name, { access_token: tokens.access_token, ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
          ...(tokens.expires_in ? { expires_in: tokens.expires_in } : {}), token_uri: tokens.token_uri });
        record(p, pending.name, pending.name, "oauth", pending.label);
        return { name: pending.name, ...useOf(p, pending.name) };
      }
      const item = itemName(pending.name);
      /** @type {Record<string, string>} */
      const fields = { client_id: tokens.client_id, token_uri: tokens.token_uri, issuer: tokens.issuer,
        // The token is bound to the address we connect to, which is what discovery started from.
        resource: p.url, access_token: tokens.access_token };
      if (flow.client.client_secret) fields.client_secret = flow.client.client_secret;
      if (tokens.refresh_token) fields.refresh_token = tokens.refresh_token;
      if (tokens.expires_in) fields.expires_at = String(tokens.obtained_at + tokens.expires_in * 1000);
      if (tokens.scope) fields.scope = tokens.scope;
      if (tokens.token_auth) fields.token_auth = tokens.token_auth;
      await deps.save(item, fields, { kind: "env-set", description: `${p.label} sign-in (made by Vyre)`, hosts: originsOf(p) });
      const out = await bind(p, pending.name, item, "oauth", pending.label, { type: "oauth", item }, {});
      return { name: pending.name, item, ...out };
    },
  });
  /** @type {Map<string, { preset: string, name: string, label?: string, as?: string }>} */
  const pendingFor = new Map();

  /** What the agent is told to use once an api connection exists. */
  const useOf = (p, name) => ({ use: { tool: "vault.request", credential: name, hosts: p.api.hosts, ...(p.api.use ? { how: p.api.use } : {}) } });

  const record = (p, name, item, mode, label) => db.prepare("INSERT OR REPLACE INTO connectors_connections (name, preset, item, mode, label, created) VALUES (?,?,?,?,?,?)")
    .run(name, p.id, item, mode, label || null, now());

  /** Make (or replace) the person's api-credential. Only a person's own surface may write one, so this is relayed as the caller that asked. */
  async function putApi(p, name, config, secret, as) {
    if (!deps.putCredential) throw fail("this box has no vault api-credential support", "config");
    const full = { ...config, hosts: p.api.hosts, ...(p.api.endpoints ? { endpoints: p.api.endpoints } : {}) };
    await deps.putCredential(name, { config: full, ...(secret ? { secret } : {}), description: `${p.label} (made by Vyre)` }, String(as || ""));
  }

  /** Add or refresh the hub row, remember the connection, and try the server once. */
  async function bind(p, name, item, mode, label, auth, headers) {
    const had = await deps.hasServer(name);
    /** @type {any} */ let test = null;
    if (had) test = await deps.testServer(name);
    else {
      const r = await deps.addServer({ name, transport: p.transport, url: p.url, auth, ...(Object.keys(headers).length ? { headers } : {}) });
      test = r && r.test;
    }
    db.prepare("INSERT OR REPLACE INTO connectors_connections (name, preset, item, mode, label, created) VALUES (?,?,?,?,?,?)")
      .run(name, p.id, item, mode, label || null, now());
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
     * @param {{ group?: string, all?: boolean }} [input]
     */
    async catalog(input = {}) {
      const mine = db.prepare("SELECT name, preset, mode, label, created FROM connectors_connections ORDER BY name").all();
      const list = presets().filter(p => !input.group || p.group === input.group).map(p => ({
        id: p.id, label: p.label, group: p.group, who: p.who, evidence: p.evidence,
        target: p.target || "mcp",
        modes: [p.oauth ? "oauth" : null, p.token ? "token" : null].filter(Boolean),
        prefer: p.prefer || (p.oauth ? "oauth" : "token"),
        // what the person must bring: nothing, their own app, or a token
        setup: p.via ? "via" : (p.prefer === "token" || !p.oauth) ? "token" : p.oauth.client === "byo" ? "app" : "none",
        ...(p.oauth && p.oauth.guide || p.token && p.token.guide ? { guided: true } : {}),
        ...(p.note ? { note: p.note } : {}), ...(p.via ? { via: p.via } : {}),
        connected: mine.filter(c => c.preset === p.id).map(c => ({ name: c.name, mode: c.mode, ...(c.label ? { label: c.label } : {}) })),
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
      const mine = db.prepare("SELECT name, preset, mode, label FROM connectors_connections ORDER BY name").all();
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

    /** The connections this box has made. */
    list() {
      return db.prepare("SELECT name, preset, mode, label, created FROM connectors_connections ORDER BY name").all()
        .map(c => ({ ...c, label: preset(c.preset)?.label || c.preset }));
    },

    /**
     * Connect a preset. Answers one of: { step: "open", id, url } (open this address, the sign-in
     * finishes on its own or with `finish`), { step: "needs", needs: "token" | "client", ... } (ask the
     * person for it and call again), { step: "via", via } (another module owns this sign-in), or
     * { step: "connected", name, tools } (a token was stored and the server answered).
     * `token` is accepted only when the caller says it is a person's own surface.
     * @param {{ preset: string, label?: string, name?: string, mode?: string, client?: string, app?: { client_id: string, client_secret?: string }, token?: string, extra?: Record<string, string>, replace?: boolean }} input
     * @param {{ person: boolean, as?: string }} who
     */
    async start(input, who) {
      const wanted = String(input.preset || "");
      const gone = unavailable().find(u => u.id === wanted);
      if (gone) throw fail(`${gone.label} cannot be connected: ${gone.reason}`, "unavailable");
      const p = preset(wanted);
      if (!p) throw fail(`no connector named ${wanted.slice(0, 40)}; connectors.catalog lists them`, "not_found");
      const name = input.name ? String(input.name) : connectionName(p.id, input.label);
      if (!NAME.test(name)) throw fail("name is lowercase letters, digits and dashes, starting with a letter, at most 32");
      if (presetOfName(name)?.id !== p.id) throw fail(`a ${p.label} connection is named ${p.id} or starts with ${p.id}-`);
      if (rowOf(name) && !input.replace) throw fail(`${name} is already connected; disconnect it first, add a label for a second account, or pass replace`, "conflict");
      const mode = modeOf(p, input.mode);

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
          await putApi(p, name, { auth: { type: "bearer", ...(t.header ? { header: String(t.header).toLowerCase() } : {}), ...(t.format ? { format: t.format } : {}) } }, value, who.as);
          record(p, name, name, "token", input.label);
          deps.emit("connectors.connected", { name, preset: p.id, mode });
          log("connector connected", { name, preset: p.id, mode });
          return { step: "connected", name, ...useOf(p, name) };
        }
        const item = itemName(name);
        await deps.save(item, { value }, { kind: "api-key", description: `${p.label} token (made by Vyre)`, hosts: originsOf(p) });
        const auth = { type: "bearer", item, field: "value", ...(t.header ? { header: String(t.header).toLowerCase() } : {}), ...(t.format ? { format: t.format } : {}) };
        const out = await bind(p, name, item, "token", input.label, auth, headers);
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
          ...(o.port ? { port: o.port } : {}), ...(client ? { client } : {}),
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
      pendingFor.set(started.id, { preset: p.id, name, ...(input.label ? { label: input.label } : {}), ...(who.as ? { as: who.as } : {}) });
      log("connector sign-in started", { name, preset: p.id });
      return { step: "open", id: started.id, url: started.url, redirect: started.redirect, name, preset: p.id };
    },

    /** The address the browser landed on, pasted, for a person whose browser is not on this machine. @param {{ id: string, url: string }} input */
    async finish(input) {
      const r = await oauth.finish(input);
      return { step: "connected", ...r };
    },

    /** @param {{ id: string }} input */
    async cancel(input) {
      pendingFor.delete(String(input.id));
      return oauth.cancel(input);
    },

    /**
     * Disconnect: the hub row goes, the connection record goes. The vault item is left where it is
     * (a person removes items in the vault), as `mcp.remove` does.
     * @param {{ name: string }} input
     */
    async disconnect(input) {
      const name = String(input.name || "");
      if (!rowOf(name)) throw fail(`no connection ${name.slice(0, 40)}`, "not_found");
      const pr = preset(rowOf(name).preset);
      if (!(pr && pr.target === "api") && await deps.hasServer(name)) await deps.removeServer(name);
      db.prepare("DELETE FROM connectors_connections WHERE name = ?").run(name);
      deps.emit("connectors.disconnected", { name });
      return { name, removed: true };
    },

    /**
     * A rotated refresh token, from the hub, into the item this module made. Only fields a sign-in
     * keeps are accepted, and only for an item of one of this module's own connections.
     * @param {{ item: string, fields: Record<string, string> }} input
     */
    async persist(input) {
      const c = db.prepare("SELECT * FROM connectors_connections WHERE item = ?").get(String(input.item || ""));
      if (!c) throw fail("that item is not a connector sign-in", "not_found");
      const p = preset(c.preset);
      const next = {};
      for (const f of TOKEN_FIELDS) {
        let v = input.fields && input.fields[f];
        if (v === undefined) { try { v = await deps.fetchItem(c.item, f); } catch { v = undefined; } }
        if (typeof v === "string" && v) next[f] = v;
      }
      for (const k of Object.keys(input.fields || {})) if (!TOKEN_FIELDS.includes(k)) throw fail(`${k.slice(0, 40)} is not a sign-in field`);
      await deps.save(c.item, /** @type {Record<string, string>} */ (next), { kind: "env-set", description: `${p ? p.label : c.preset} sign-in (made by Vyre)`, hosts: p ? originsOf(p) : [] });
      return { saved: true };
    },

    stop: () => oauth.stop(),
  };
}
