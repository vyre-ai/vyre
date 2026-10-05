// @ts-check
// connectors: the module. The catalog of vendors that run their own hosted MCP server, and the one
// connect flow for all of them (work in connect.js, data in lib/connector-presets). Connecting adds
// a server to the MCP hub and a bound credential to the vault; after that the hub, the Gate and the
// vault do everything, as for any hand-added server.
//
// Who may call what, and why:
// - The catalog and the list of connections are open to every caller: they hold no value, and an
//   agent can tell the person what they could connect.
// - Connecting, finishing, cancelling and disconnecting are for the person's own surfaces. A model
//   never adds a connection, and a token is only ever accepted from a person's surface.
// - `connectors.persist` is internal and answers only the MCP hub, which calls it when a vendor
//   rotates a refresh token.

import { connections, MIGRATIONS } from "../../lib/connectors/connect.js";
import { fromGraph, fromGoogle, upNext, requests } from "../../lib/connectors/calendar.js";
import { catalogFrom } from "../../lib/connector-presets/index.js";
import { DECLARATIONS, declared } from "../../records/connectors/index.js";
import { toCredentialConfig, isOutward, connectorWatcherName } from "../../records/connectors/format.js";
import { logCommunicationsFlow } from "../../records/comms/log-flow.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule"];

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const data = r => { if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data; };
    const fail = (msg, code) => Object.assign(new Error(msg), { code });

    const conn = connections({
      db: ctx.store.db,
      catalog: catalogFrom(ctx.config),
      fetchItem: (item, field) => ctx.vault.fetch(item, field ? { field } : {}),
      // The vault item is this module's own: one it did not make is never replaced.
      save: async (item, fields, { kind, description, hosts, grants }) => {
        const old = (await ctx.call("vault.list", { filter: item })).data?.items?.find(x => x.name === item);
        if (old && old.origin !== "module:connectors") throw fail(`the vault already has an item named ${item} that Vyre's connectors did not make; rename or delete it first`, "exists");
        const r = await ctx.call("vault.put", { name: item, kind, description, fields, hosts, grants: grants || ["mcp", "connectors"] });
        if (r.error) throw fail(`could not save the sign-in in the vault: ${r.error.message}`, r.error.code || "vault");
      },
      addServer: async input => data(await ctx.call("mcp.add", input)),
      testServer: async name => data(await ctx.call("mcp.test", { name })),
      hasServer: async name => {
        const list = data(await ctx.call("mcp.servers", {}));
        return (Array.isArray(list) ? list : list.servers || []).find(s => s.name === name) || null;
      },
      updateServer: async input => { data(await ctx.call("mcp.update", input)); },
      removeServer: async name => { data(await ctx.call("mcp.remove", { name })); },
      // An api-credential is made only from a person's own surface, so this is relayed as the person who asked.
      putCredential: async (name, { config, secret, description }, as) => {
        const r = await ctx.call("vault.put", { name, kind: "api-credential", description, fields: { config: JSON.stringify(config), ...(secret ? { secret } : {}) } }, { as });
        if (r.error) throw fail(`could not save the credential in the vault: ${r.error.message}`, r.error.code || "vault");
      },
      // Taken back as the person who started the sign-in, when its token store failed.
      removeCredential: async (name, as) => {
        const r = await ctx.call("vault.delete", { name }, { as });
        if (r.error) throw fail(`could not remove the credential: ${r.error.message}`, r.error.code || "vault");
      },
      grantThread: async (server, thread) => { data(await ctx.call("mcp.grant", { server, thread })); },
      storeTokens: async (name, tokens) => { data(await ctx.call("vault.credential.tokens", { name, tokens })); },
      // GitHub signs in through the github module; the catalog shows the accounts it holds.
      external: async id => {
        if (id !== "github") return [];
        const r = await ctx.call("github.accounts", {});
        const list = r.error ? [] : Array.isArray(r.data) ? r.data : Array.isArray(r.data && r.data.accounts) ? r.data.accounts : [];
        return list.map(a => ({ name: String(a.login || a.name || a.account || "github") })).filter(a => a.name);
      },
      emit: (type, payload) => ctx.events.emit(type, payload),
      log: (m, x) => ctx.log(m, x),
    });

    ctx.tool("connectors.catalog", {
      effect: "read",
      description: "Every app Vyre can connect, each run by the vendor's own hosted server: id, label, group, who can use it, how the sign-in goes (setup: none, app or token; modes oauth and token), and which of the person's connections already use it. { all: true } adds the vendors checked and ruled out, each with the reason. Never a value.",
      input: obj({ group: str, all: { type: "boolean" } }),
      run: input => conn.catalog(input),
    });

    ctx.tool("connectors.list", {
      effect: "read",
      description: "The person's connections: name, the app, how it signs in, and when it was made.",
      input: obj({}),
      run: () => conn.list(),
    });

    ctx.tool("connectors.connect", {
      effect: "write",
      description: "Connect an app from the catalog. { preset, label? } starts the sign-in. It answers { step: \"open\", id, url }: open the address in a browser and the sign-in finishes when the vendor sends the browser back (connectors.connect.finish takes the address for a browser on another device). Or { step: \"needs\", needs: \"token\" | \"client\", ... }: ask the person for a token (pass it as `token`, with `extra` for any extra fields) or for their own OAuth app: the answer carries a `guide` (steps and links, with a prefilled app link where the vendor has one) and the two `fields` to ask for; pass them as `app` { client_id, client_secret }, or name a vault item holding them as `client`. `scope` { projects, agents } is who may use it, the shape a server carries; left out, a server is open to every project and agent and a credential (Microsoft, personal Google) is for you and the assistant only. `label` makes a second account of the same app. `mode` picks oauth or token when both exist.",
      input: obj({ preset: str, label: str, name: str, mode: { type: "string", enum: ["oauth", "token"] }, client: str, scope: { type: "object" }, app: { type: "object" }, token: str, extra: { type: "object" }, replace: { type: "boolean" } }, ["preset"]),
      callers: PEOPLE,
      run: (input, meta) => conn.start(input, { person: true, as: String(meta && meta.caller || "") }),
    });

    ctx.tool("connectors.connect.finish", {
      effect: "write",
      description: "Finish a sign-in with the whole address the browser landed on (for a browser on another device).",
      input: obj({ id: str, url: str }, ["id", "url"]),
      callers: PEOPLE,
      run: input => conn.finish(input),
    });

    ctx.tool("connectors.connect.cancel", {
      effect: "write",
      description: "Cancel an open sign-in.",
      input: obj({ id: str }, ["id"]),
      callers: PEOPLE,
      run: input => conn.cancel(input),
    });

    ctx.tool("connectors.scope", {
      description: "Change who may use a connection: { name, scope } where scope is { projects: \"*\" | [ids], agents: \"*\" | [names] }, or null for the default (a hub server open to every project and agent, an api credential for you and the assistant only). Rewrites the hub row or the credential's config; the credential's stored sign-in is kept.",
      input: obj({ name: str, scope: { type: ["object", "null"] } }, ["name"]),
      callers: PEOPLE,
      run: (input, meta) => {
        // Widening who may use a connection is the person's act: the registry already limits `callers`, and this says it again
        // where it matters, so no change to the list above can let a model, an agent's thread or a module in.
        const who = String(meta && meta.caller || "");
        if (!PEOPLE.includes(who)) throw fail("only you change who may use a connection, from your own screen", "denied");
        return conn.setScope(input, { as: who });
      },
    });

    // A connector as a declaration (records/connectors): what this build ships, in plain words, and making one into a vault credential. The declaration says where the service lives,
    // what can be asked of it and which asks are outward; the credential carries that to the vault, which is where a Flow, a watcher and an assistant meet it.
    ctx.tool("connectors.declared", {
      effect: "read",
      description: "The connectors this build ships as declarations (Stripe, Gmail, Google Calendar ...), each: id, label, how it signs in, its operations (name, label, kind, outward) and the polls a watcher can run on it, plus whether a credential of that name is already in the vault. Holds no value.",
      input: obj({ id: str }),
      run: async ({ id } = {}) => {
        const list = id ? [declared(String(id))].filter(Boolean) : Object.values(DECLARATIONS);
        if (id && !list.length) throw fail(`no connector ${String(id).slice(0, 40)}; this build declares ${Object.keys(DECLARATIONS).join(", ")}`, "not_found");
        const have = new Set(((await ctx.call("vault.list", {})).data?.items || []).map(/** @param {any} x */ x => String(x.name)));
        // A Google connector has no vault credential: it is read and written through a Google account connected to the google module.
        const accounts = list.some(d => d.auth.type === "google") ? (/** @type {any[]} */ ((await ctx.call("google.accounts", {})).data || [])).map(a => String(a.name)) : [];
        return { connectors: list.map(d => ({
          id: d.id, label: d.label, host: new URL(d.base_url).hostname, auth: { type: d.auth.type, ...(d.auth.also ? { also: d.auth.also } : {}), ...(d.auth.scopes ? { scopes: d.auth.scopes } : {}) },
          installed: d.auth.type === "google" ? accounts.length > 0 : have.has(d.id),
          ...(d.auth.type === "google" ? { accounts } : {}),
          ops: Object.entries(d.ops).map(([name, op]) => ({ name, label: op.label || name, kind: op.kind, outward: isOutward(op), ...(op.idempotent === false ? { idempotent: false } : {}) })),
          polls: Object.entries(d.poll || {}).map(([name, p]) => ({ name, label: p.label || name, every_minutes: p.every_minutes ?? 15 })),
        })) };
      },
    });

    // The default "Log communications" recipe for one mailbox or calendar: the watcher to write (watchers.preset, asked) and the Flow that files what it finds (flows.define, then a person approves).
    // Nothing is written here: the person or their assistant makes each part under their own chain, and the vault credential, the watcher card and the Flow card are each theirs to say yes to.
    ctx.tool("connectors.logging", {
      effect: "read",
      description: "The recipe for logging a mailbox or calendar to contacts: { connector: gmail | google-calendar, address (the mailbox, or the calendar id), project, google? (the Google account's name, from google.accounts; default: the one whose address is this one), createUnknown?, skipInternal? (a domain) } -> { watcher: the input for watchers.preset, flow: the stored Flow for flows.define, steps: what to do in order }. Writes nothing; logging reads and files records and never sends.",
      input: obj({ connector: str, address: str, project: str, google: str, createUnknown: { type: "boolean" }, skipInternal: str }, ["connector", "address", "project"]),
      run: async input => {
        const d = declared(String(input.connector));
        const poll = d && d.poll && Object.keys(d.poll).find(n => ["mail.recent", "events.changed"].includes(n));
        if (!d || !poll) throw fail(`logging is for ${["gmail", "google-calendar"].join(" or ")}`, "bad_input");
        const address = String(input.address || "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) && d.id === "gmail") throw fail("address is the mailbox's email address", "bad_input");
        if (!address || address.length > 200) throw fail("address is the mailbox or calendar to log", "bad_input");
        // The mailbox or calendar is read through a Google account connected to the google module (the one Google path): the named one, or the one whose address this is.
        const accts = /** @type {any[]} */ ((await ctx.call("google.accounts", {})).data || []);
        const acct = input.google ? accts.find(a => a.name === String(input.google)) : accts.find(a => String(a.email || "").toLowerCase() === address) || (accts.length === 1 ? accts[0] : undefined);
        if (!acct) throw fail(input.google ? `no Google account ${String(input.google).slice(0, 40)}; google.accounts lists them` : `no connected Google account for ${address.slice(0, 80)}; connect it (vyre connect add google ... --sign-in) or name one with google`, "not_found");
        const needs = poll === "mail.recent" ? "mailbox" : "calendar";
        const watcher = { kind: "connector", connector: d.id, poll, project: String(input.project), google: String(acct.name), vars: { [needs]: address } };
        const name = connectorWatcherName(d, { poll, vars: watcher.vars });
        const flow = logCommunicationsFlow({ watcher: name, createUnknown: input.createUnknown === true, ...(input.skipInternal ? { skipInternal: String(input.skipInternal) } : {}) });
        return { watcher, flow, name, steps: [
          `the Google account ${acct.name} is connected to the google module (nothing to make in the vault)`,
          "watchers.preset with `watcher` (a draft with its card), then watchers.test, then the person turns it on with watchers.create (the card says it reads that account, read only)",
          "flows.define with `flow`, then a person approves it with flows.approve (the card shows it reads and writes records and never sends)",
        ] };
      },
    });

    ctx.tool("connectors.declare", {
      effect: "write",
      description: "Make a vault credential from a shipped declaration, so Flows, watchers and assistants can reach that service through the vault: { id, also? (more connector ids that sign in the same way and share this one credential, such as [\"google-calendar\"] with gmail: one sign-in), secret? (a key or token, for bearer and api-key connectors), as: \"service-account\" with subject (the address it acts as) and item (the vault item holding the service-account key), or client (the vault item holding an OAuth app's client id and secret), name? (default: the connector id), scope? }. A model never calls this. For an OAuth connector this makes the credential; the sign-in is then made with connectors.connect for the matching app.",
      input: obj({ id: str, also: { type: "array", items: str }, name: str, secret: str, as: { type: "string", enum: ["service-account"] }, subject: str, item: str, field: str, client: str, scope: { type: "object" } }, ["id"]),
      callers: PEOPLE,
      run: async (input, meta) => {
        const who = String(meta && meta.caller || "");
        if (!PEOPLE.includes(who)) throw fail("only you make a connector's credential, from your own screen", "denied");
        const ids = [String(input.id), ...(Array.isArray(input.also) ? input.also.map(String) : [])];
        const ds = ids.map(i => declared(i));
        if (ds.some(x => !x)) throw fail(`no connector ${ids[ds.indexOf(null)].slice(0, 40)}; this build declares ${Object.keys(DECLARATIONS).join(", ")}`, "not_found");
        const d = /** @type {any} */ (ds[0]);
        if (ds.some(x => /** @type {any} */ (x).auth.type === "google")) throw fail(`${d.label} is signed in through the Google module, not the vault: connect the account with vyre connect add google ... --sign-in`, "bad_input");
        const many = ds.length > 1;
        const name = input.name ? String(input.name) : many ? ids.join("-").slice(0, 32) : d.id;
        const secretAuth = d.auth.type === "bearer" || d.auth.type === "api-key";
        if (!secretAuth && input.secret) throw fail(`${d.label} does not take a pasted secret; it signs in as a service account (as, subject, item) or with an OAuth app (client)`, "bad_input");
        let config;
        try { config = toCredentialConfig(many ? /** @type {any} */ (ds) : d, { ...(input.as ? { as: input.as } : {}), ...(input.subject ? { subject: String(input.subject) } : {}), ...(input.item ? { item: String(input.item), ...(input.field ? { field: String(input.field) } : {}) } : {}), ...(input.client ? { client: String(input.client) } : {}) }); }
        catch (e) { throw fail(/** @type {Error} */ (e).message, "bad_input"); }
        if (input.scope) config = { ...config, scope: input.scope };
        if (secretAuth && !input.secret && !input.item) throw fail(`${d.label} signs in with a key: pass it as secret, or name the vault item that holds it (item)`, "bad_input");
        const old = (await ctx.call("vault.list", { filter: name })).data?.items?.find(/** @param {any} x */ x => x.name === name);
        // making it again replaces the person's own connector credential (a new key, a new scope); an item of any other kind is never overwritten
        if (old && old.kind !== "api-credential") throw fail(`the vault already has an item named ${name} that is not an api credential; pass name or rename it first`, "exists");
        const r = await ctx.call("vault.put", { name, kind: "api-credential", description: `${d.label} connector (made by Vyre)`, fields: { config: JSON.stringify(config), ...(input.secret ? { secret: String(input.secret) } : {}) } }, { as: who });
        if (r.error) throw fail(`could not save the credential in the vault: ${r.error.message}`, r.error.code || "vault");
        return { name, connectors: ids, hosts: ds.map(x => new URL(/** @type {any} */ (x).base_url).hostname), ops: ds.reduce((n, x) => n + Object.keys(/** @type {any} */ (x).ops).length, 0), outward: ds.flatMap(x => Object.entries(/** @type {any} */ (x).ops).filter(([, op]) => isOutward(/** @type {any} */ (op))).map(([n]) => n)),
          next: d.auth.type === "oauth" && !input.as ? "sign in with connectors.connect so the vault holds tokens" : "ready: Flows reach it as the connector " + name };
      },
    });

    ctx.tool("connectors.disconnect", {
      effect: "write",
      description: "Disconnect an app: its server leaves the hub. The vault item stays; the vault removes items.",
      input: obj({ name: str }, ["name"]),
      callers: PEOPLE,
      run: input => conn.disconnect(input),
    });

    // The # picker's connector kind (platform's core/mentions calls these two: search as the asking person,
    // resolve as sessions or the assistant on the person's own turn). The manifest's `mentions` entry names them.
    ctx.tool("connectors.mention.search", {
      effect: "read",
      description: "The # picker's connectors: connected apps by name, then a \"Connect <name>\" row for each app not yet connected. { q?, limit? } -> [{ kind, id, name, hint, icon }]. A connect: id means open the connect flow (connectors.connect), not a tag.",
      input: obj({ q: str, limit: { type: "integer" } }),
      callers: PEOPLE,
      run: input => conn.mentionSearch(input),
    });

    ctx.tool("connectors.mention.resolve", {
      internal: true,
      description: "What a #tag on a connected app means for one thread: its tools are usable there. { id, thread, said } -> { name, hint, hosts, note, grant }.",
      input: obj({ id: str, thread: str, said: str }, ["id"]),
      run: (input, { caller }) => {
        if (!["module:sessions", "module:assistant", "module:mentions"].includes(String(caller))) throw fail("only sessions and the assistant resolve a tag", "denied");
        return conn.mentionResolve(input);
      },
    });

    // The Capsule's `next` command: today's next meetings from every calendar connected, Google's native module
    // and the Microsoft and personal Google connections (read through vault.request as a reader the person named
    // when they connected). Read only, cached for a minute, and empty when nothing is connected.
    /** @type {{ key: string, at: number, value: any } | null} */
    let cached = null;
    ctx.tool("connectors.calendar.today", {
      effect: "read",
      description: "Today's next meetings across every connected calendar, for a next-meeting line: { events: [{ id, account, title, start, end, when, join?, link }] }. Empty when none is connected. Read only; cached for a minute.",
      input: obj({ limit: { type: "integer" } }),
      run: async ({ limit } = {}) => {
        const at = Date.now();
        const n = Number.isInteger(limit) ? Math.min(10, Math.max(1, limit)) : 3;
        const apis = conn.namesOf(["microsoft", "google-personal"]);
        const key = `${n}:${apis.map(a => a.name).join(",")}`;
        if (cached && cached.key === key && at - cached.at < 60_000) return cached.value;
        const end = new Date(at); end.setHours(23, 59, 59, 999);
        const rq = requests(new Date(at).toISOString(), end.toISOString());
        /** @type {any[]} */ const events = [];
        // One calendar failing or missing never hides the rest.
        try { const g = await ctx.call("google.calendar.today", { limit: 10 }); if (g.data && Array.isArray(g.data.events)) events.push(...g.data.events); } catch { /* no google module */ }
        for (const a of apis) {
          try {
            const r = await ctx.call("vault.request", { credential: a.name, ...(a.preset === "microsoft" ? rq.graph : rq.google) });
            if (r.data) events.push(...(a.preset === "microsoft" ? fromGraph(r.data.body, a.name) : fromGoogle(r.data.body, a.name)));
          } catch { /* not signed in, or no network */ }
        }
        const value = { events: upNext(events, at, n) };
        cached = { key, at, value };
        return value;
      },
    });

    ctx.tool("connectors.persist", {
      internal: true,
      description: "The MCP hub saves a rotated refresh token into the item a connection made.",
      input: obj({ item: str, fields: { type: "object" } }, ["item", "fields"]),
      run: (input, { caller }) => {
        if (caller !== "module:mcp") throw fail("only the MCP hub saves a rotated sign-in", "denied");
        return conn.persist(input);
      },
    });

    return { async stop() { conn.stop(); } };
  },
};
