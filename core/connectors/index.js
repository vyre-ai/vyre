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
