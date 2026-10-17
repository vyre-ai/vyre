// @ts-check
// mcp: the module. The MCP hub's tools, who may call each, and the wiring to the vault, the Gate,
// the agents and the Switchboard (ADR 0016, decisions 2 to 4). The work is in hub.js.
//
// Who may call what, and why:
// - Adding, changing, removing, testing and restarting servers is for people and modules (cli,
//   local, deck, capsule, module), never a model: a model must not add a server or widen a scope.
//   None of them asks for presence. Adding a server releases nothing by itself; the vault grant to
//   `mcp` is what lets a value out, and vault.grant asks for presence.
// - mcp.servers, mcp.tools and mcp.call are open to all, and scoped by what vyred verified: the
//   agent from its key, the thread from the session key, and the thread's project from the
//   Switchboard. A claim in the input is never used for scope.
// - mcp.release is internal and answers only module:gate, which calls it after the person
//   approved an outward call.
//
// The Gate: one sender per server, `mcp:<server>` (the ADR's `via`), offered at start for every
// stored server and when one is added. So the person sees which server a held call is for, and an
// item held before a restart can still be approved once this module has started again. A removed
// server's sender stays offered until vyred restarts; release refuses it.

import { refuseNonPerson } from "../../lib/person-body.js";
import { PERSON_SURFACES } from "../../lib/person-surfaces.js";
import { Credentials } from "../../lib/connectors/auth.js";
import { checkBehalf } from "../../lib/connectors/behalf.js";
import { catalogFrom } from "../../lib/connector-presets/index.js";
import { connect } from "./client.js";
import { memberServers, storeOverCalls, legacyRows, remoteOk } from "../../lib/member-mcp.js";
import { searchCatalog, urlKey } from "../../lib/mcp-catalog.js";
import { ownRow } from "../../lib/own-row.js";
import { loadSnapshot, snapshotCatalog } from "../../lib/connector-presets/from-catalog.js";
import { Hub, MIGRATIONS, TRANSPORTS, AUTH_TYPES, whoFrom, personKey } from "./hub.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule", "module"];
const KINDS = ["send", "spend", "delete"];

const fields = {
  transport: { type: "string", enum: TRANSPORTS }, command: str, args: { type: "array", items: str }, cwd: str,
  env: { type: "object" }, vars: { type: "object" }, url: str, headers: { type: "object" },
  auth: { type: "object", properties: { type: { type: "string", enum: AUTH_TYPES } } },
  scope: { type: ["object", "null"] }, tools: { type: "object" }, idle: { type: "integer" },
};

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const opts = (ctx.config && ctx.config.mcp) || {};
    const data = r => { if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data; };

    const creds = new Credentials({
      fetchItem: (item, field) => ctx.vault.fetch(item, field ? { field } : {}),
      // A vendor that rotates its refresh token on every use: the connectors module made the item, so it saves the new one.
      save: async (item, fields) => { data(await ctx.call("connectors.persist", { item, fields })); },
    });
    const offer = async name => {
      const r = await ctx.call("gate.offer", { name: `mcp:${name}`, tool: "mcp.release", kinds: KINDS,
        content: { server: "the hub server", tool: "the server's own tool name", arguments: "object: exactly what the tool is called with", summary: "string" } });
      if (r.error) ctx.log(`could not offer the Gate sender mcp:${name}: ${r.error.message}`);
    };

    const curated = catalogFrom(ctx.config);
    const fromSnapshot = snapshotCatalog(loadSnapshot(ctx.config), curated);
    const hub = new Hub({
      db: ctx.store.db, creds, connect,
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
      log: m => ctx.log(m),
      offer,
      // Filed by thread, project and agent from what vyred verified for the model's call. ctx.call
      // runs as module:mcp, which would lose them, so the hub puts them in the request itself.
      request: async input => data(await ctx.call("gate.request", input)),
      item: async id => data(await ctx.call("gate.get", { id })),
      agentKind: async agent => {
        const list = data(await ctx.call("agents.list", {}));
        const a = (Array.isArray(list) ? list : []).find(x => x.name === agent);
        return a ? String(a.kind || "") : null;
      },
      agentProjects: async agent => {
        const list = data(await ctx.call("agents.list", {}));
        const a = (Array.isArray(list) ? list : []).find(x => x.name === agent);
        return a ? a.projects : [];
      },
      // A person's connection is used by whoever the Vault says holds its item; the call inherits the turn's chain, so the Vault reads the caller from the kernel.
      // The access token for a person's connection, asked of the Vault at the moment of the request: the call inherits the turn, so the Vault checks the asker again. Only the short-lived token comes back.
      connectionToken: async c => { const r = await ctx.call("vault.connection.token", c); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data; },
      // What the Gate holds for this module's own sender, and the module taking its own items back: how a revoke cancels what is waiting.
      heldOf: async via => { const r = await ctx.call("gate.held-of", { via }); return (r && r.data) || []; },
      cancel: async (id, reason) => { const r = await ctx.call("gate.reject", { id, reason }); if (r && r.error) throw new Error(r.error.message); return r.data; },
      // The vendor is told to drop the token too, where the connection names how; best effort, and the hub says when it was not.
      revokeConnection: async c => { const r = await ctx.call("vault.connection.revoke", c); if (r && r.error) throw new Error(r.error.message); if (r.data && r.data.revoked !== true) ctx.log(`mcp: the vendor was not told to drop the token (${r.data.why})`); return r.data; },
      mayUseConnection: async c => { const r = await ctx.call("vault.connection.may", c); return Boolean(r && r.data && r.data.allow === true); },
      threadProject: async thread => {
        const t = await ctx.call("threads.get", { thread, limit: 1 });
        return (t.data && t.data.thread && t.data.thread.project) || null;
      },
      idle: Number.isInteger(opts.idle) ? opts.idle : undefined,
      httpHosts: Array.isArray(opts.httpHosts) ? opts.httpHosts.map(String) : [],
      // A credential named after a curated vendor, or after a preset made from the catalog snapshot, goes only to that preset's host.
      boundFor: item => curated.boundFor(item) || fromSnapshot.boundFor(item),
      // A sign-in the vendor refused after a fresh token: the connectors module marks the connection so the person is asked to connect again.
      needsReconnect: item => ctx.call("connectors.needs-reconnect", { item }),
      lineage: async thread => {
        const r = await ctx.call("threads.lineage", { thread });
        const d = r && r.data;
        return Array.isArray(d) ? d.map(x => String(x && x.thread || x)) : Array.isArray(d && d.ancestors) ? d.ancestors.map(x => String(x && x.thread || x)) : [];
      },
    });

    for (const r of hub.rows()) await offer(r.name);

    const who = (meta) => ({ ...whoFrom(meta.caller, meta), me: () => callerMember(meta) });   // me: the member the verified call names ("" for the owner and for home work), read only when a person's connection is asked about

    ctx.tool("mcp.servers", {
      effect: "read",
      description: "List the MCP servers behind the hub this caller may use: name, transport, state, tool count, last error, auth type and scope. Never a value.",
      input: obj({}),
      run: (_, meta) => hub.servers(who(meta)),
    });

    // An added (not first-party) module may put an http server in the hub, but not a process: a stdio row runs
    // a command with vault items in its environment, so it is for a person or one of Vyre's own modules
    // (reviewer-2 M-G1: an added module must not be able to put a granted token in a process's env).
    const refuseProcess = (input, meta, existing) => {
      if (!String(meta.caller || "").startsWith("module:") || meta.firstParty) return;
      const stdio = input.transport === "stdio" || input.command !== undefined || existing === "stdio";
      const env = (input.env && Object.keys(input.env).length) || (input.auth && input.auth.type === "env");
      if (stdio || env) throw Object.assign(new Error("an added module may add an http or sse server, not a command or an environment from the vault; a person adds those"), { code: "denied" });
    };

    ctx.tool("mcp.add", {
      effect: "write",
      description: "Add an MCP server: a name ([a-z][a-z0-9-], up to 32), a transport (stdio with command, args, cwd; http or sse with url), credentials as vault item names (auth { type: bearer | env | oauth | service-account, item }, env { VAR: item } for stdio), plain vars and headers that are not secret, a scope { projects, agents } (none means you and the assistant only; a named agent needs a scope that names it, or a #tag on its thread) and a tools policy { allow, deny, mode }. It then tries the server once to cache its tools; grant each vault item to mcp first, or run mcp.test after.",
      input: obj({ name: str, ...fields }, ["name", "transport"]),
      callers: PEOPLE,
      run: async (input, meta) => {
        refuseNonPerson(meta, "adds an MCP server");
        refuseProcess(input, meta);
        // A server a member adds is HER row: the owner is the person in the verified chain (the Vault names them), never anything in the input. A call that carries a claim and cannot be named is refused,
        // not treated as the Space owner's; a call with no claim at all (the home's own work) is the Space's, as before.
        const claims = Boolean(meta && (typeof meta.token === "string" || (meta.kernelFacts && typeof meta.kernelFacts === "object")));
        if (!claims) return hub.add(input);
        const w = await ctx.call("vault.me.who", {}, { relay: true });
        if (w.error) throw Object.assign(new Error(w.error.message), { code: w.error.code || "denied" });
        return w.data && w.data.kind === "member" ? hub.add(input, { owner: w.data.person }) : hub.add(input);
      },
    });

    // A team member's own servers ("Your accounts"): kept in THEIR personal vault, for the person the kernel names for the call, never one the input names. A member's call arrives here with its token
    // (a module hop inherits the turn), so vault.me.store.* resolves the same person; the owner has no personal vault and uses mcp.add.
    const MINE = [...PERSON_SURFACES, "device", "web"];   // a person's surfaces, as vault.me.store.* has them: a model's labels are not among them
    const mine = () => memberServers(storeOverCalls((tool, input) => ctx.call(tool, input, { relay: true })));
    // The app catalog: a reviewed weekly snapshot (scripts/mcp-catalog-snapshot.mjs opens the pull request, a person merges it). Read from the file the build carries; none is an empty catalog.
    const snapshot = loadSnapshot(ctx.config);
    ctx.tool("mcp.catalog", {
      effect: "read",
      description: "Search the reviewed app catalog of hosted MCP servers by words or category; each entry says its sign-in kind and whether you are connected.",
      input: obj({ query: str, category: str, connected: { type: "boolean" }, verified: { type: "boolean" }, limit: { type: "integer" }, offset: { type: "integer" } }),
      run: async (input, meta) => {
        // "connected" means a server this caller may use (the same scope as mcp.servers): a member does not learn which apps the owner connected beyond what her sessions can reach.
        const w = who(meta), memo = {}, connectedKeys = new Set();
        for (const r of hub.rows()) if (r.url && await hub.inScope(r, w, memo)) connectedKeys.add(urlKey(r.url));
        // The preset to connect with: the curated one when a curated preset already serves that address (it keeps its own reviewed sign-in pin), else the one made from the entry.
        const served = new Map(curated.presets().filter(p => p.url).map(p => [urlKey(p.url), p.id]));
        const found = searchCatalog(snapshot.entries, input || {}, connectedKeys, new Set(served.keys()));
        const entries = found.entries.map(e => (e.oneClick && served.has(urlKey(e.url)) ? { ...e, preset: served.get(urlKey(e.url)) } : e));
        return { ...found, entries, generated: snapshot.generated };
      },
    });

    // A member's own servers are rows of the hub, hers by owner (a per-person key), reached through the one vyre entry with the token added per call. They are not config handed to a harness. A token she pastes
    // becomes a connection item in her own vault (vault.me.connect.put), and the row names it; older entries kept in her store are moved the first time she lists (legacyRows), then removed.
    const memberOnly = async (/** @type {any} */ meta) => { const p = await callerMember(meta); if (!p) throw Object.assign(new Error("these are a member's own servers: ask the Space's owner to add a server for everyone"), { code: "denied" }); return p; };
    const rowsOf = (/** @type {string} */ person) => hub.rows().filter((/** @type {any} */ r) => r.owner === person);
    const moveLegacy = async (/** @type {string} */ person) => {
      let entries;
      try { entries = await mine().list(); } catch { return; }   // locked or none: nothing to move now
      const { rows } = legacyRows(entries);
      for (const { row, token } of rows) {
        try {
          const item = `mine-${row.name}-token`.slice(0, 120);
          if (token) { const r = await ctx.call("vault.me.connect.put", { name: item, fields: { auth_kind: "bearer", token, server_url: row.url } }, { relay: true }); if (r.error) continue; }
          await hub.add({ name: row.name, transport: row.transport, url: row.url, auth: token ? { type: "bearer", connection: item } : { type: "none" } }, { owner: person });
          await mine().remove(row.name);
        } catch { /* a row that cannot be made stays an entry, unused, until it can */ }
      }
    };
    ctx.tool("mcp.mine.list", {
      effect: "read",
      description: "The MCP servers you brought yourself (your own accounts): name and address, never a credential.",
      input: obj({}),
      callers: MINE,
      run: async (_input, meta) => { const person = await memberOnly(meta); await moveLegacy(person); return rowsOf(person).map((/** @type {any} */ r) => ({ name: r.label || r.name, type: r.transport, url: r.url ? new URL(r.url).origin + new URL(r.url).pathname : null })); },
    });
    ctx.tool("mcp.mine.add", {
      effect: "write",
      description: "Add an MCP server to your own accounts: a name and a remote server (type http or sse, an https url, optionally an authorization bearer token). Your token is kept in your own vault, and the server is reached through Vyre with the token added there; nothing is handed to a session.",
      input: obj({ name: str, type: { type: "string", enum: ["http", "sse"] }, url: str, headers: { type: "object" } }, ["name", "type", "url"]),
      callers: MINE,
      run: async ({ name, type, url, headers }, meta) => {
        const person = await memberOnly(meta);
        if (!remoteOk({ type, url })) throw Object.assign(new Error("a server you bring is a remote one: an https address on a public host"), { code: "bad_input" });
        const { rows, left } = legacyRows([{ name: String(name), type, url, ...(headers && typeof headers === "object" ? { headers } : {}) }]);
        if (left.length) throw Object.assign(new Error("a server you bring takes no header other than an authorization bearer token"), { code: "bad_input" });
        const { row, token } = rows[0];
        const item = `mine-${row.name}-token`.slice(0, 120);
        if (token) { const r = await ctx.call("vault.me.connect.put", { name: item, fields: { auth_kind: "bearer", token, server_url: row.url } }, { relay: true }); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" }); }
        await hub.add({ name: row.name, transport: row.transport, url: row.url, auth: token ? { type: "bearer", connection: item } : { type: "none" } }, { owner: person });
        return { name: row.name };
      },
    });
    ctx.tool("mcp.mine.remove", {
      effect: "write",
      description: "Remove one of your own MCP servers.",
      input: obj({ name: str }, ["name"]),
      callers: MINE,
      run: async ({ name }, meta) => { const person = await memberOnly(meta); await hub.remove({ name: ownRow(hub, personKey, String(name), person) }, who(meta)); try { await mine().remove(String(name)); } catch { /* none kept */ } return { removed: true }; },
    });

    // The row a call means. A call that carries a member's claim reaches only HER rows: the name she gives is her label, the row is hers by key and by owner, and any other row answers not_found.
    // The Space owner, and a call with no claim (the home's own work), reach a row by its name as before.
    /** The member's person id when the call carries a claim the Vault names as a member's; "" for the owner and for home work with no claim. A claim the Vault cannot name is refused, never served as the owner's. */
    const callerMember = async (/** @type {any} */ meta) => {
      const claims = Boolean(meta && (typeof meta.token === "string" || (meta.kernelFacts && typeof meta.kernelFacts === "object")));
      if (!claims) return "";
      const w = await ctx.call("vault.me.who", {}, { relay: true });
      if (w.error) throw Object.assign(new Error(w.error.message), { code: w.error.code || "denied" });
      return w.data && w.data.kind === "member" ? String(w.data.person) : "";
    };
    const rowName = async (/** @type {string} */ name, /** @type {any} */ meta) => ownRow(hub, personKey, name, await callerMember(meta));

    ctx.tool("mcp.update", {
      effect: "write",
      description: "Change an MCP server: any field of mcp.add. A new command, url or credential stops the running server and drops its cached tools.",
      input: obj({ name: str, ...fields }, ["name"]),
      callers: PEOPLE,
      run: async (input, meta) => { refuseNonPerson(meta, "changes an MCP server"); const name = await rowName(input.name, meta); refuseProcess(input, meta, (hub.row(name) || {}).transport); return hub.update({ ...input, name }); },
    });

    // The Vault tells the hub a share or grant on a person's connection ended: whoever asked for something held there and no longer holds the connection has it discarded.
    ctx.tool("mcp.sweep", {
      internal: true,
      description: "A share or grant on a person's connection ended: discard what its requesters, who no longer hold it, left waiting at the Gate. { owner, connection } -> { cancelled }. Only the vault module asks.",
      input: obj({ owner: str, connection: str }, ["connection"]),
      run: async (input, meta) => {
        if (String(meta && meta.caller) !== "module:vault") throw Object.assign(new Error("only the vault module reports that a connection was shared out or taken back"), { code: "denied" });
        let cancelled = 0;
        for (const r of hub.rows()) if (r.owner && r.connection === String(input.connection) && (input.owner === undefined || r.owner === String(input.owner))) cancelled += await hub.sweep(r.name);
        return { cancelled };
      },
    });

    ctx.tool("mcp.remove", {
      effect: "write",
      description: "Remove an MCP server. Its process stops; its vault items and grants are left as they are.",
      input: obj({ name: str }, ["name"]),
      callers: PEOPLE,
      run: async (input, meta) => { refuseNonPerson(meta, "removes an MCP server"); return hub.remove({ ...input, name: await rowName(input.name, meta) }, who(meta)); },
    });

    ctx.tool("mcp.repin", {
      effect: "write",
      description: "Approve the tool descriptions an MCP server changed since you reviewed them: { name, seen } where seen is the hash mcp.servers shows. Until then its tools are held.",
      input: obj({ name: str, seen: str }, ["name", "seen"]),
      callers: PEOPLE,
      run: async (input, meta) => {
        refuseNonPerson(meta, "approves changed MCP tool descriptions");
        // A member approves the change to her own connection only; the Space owner approves the Space's own rows and is refused a member's.
        const person = await callerMember(meta);
        return person ? hub.repin({ ...input, name: personKey(String(input.name), person) }, { owner: person }) : hub.repin(input);
      },
    });

    ctx.tool("mcp.test", {
      effect: "write",
      description: "Start an MCP server (or use the running one), list its tools and cache them. Says how long it took, and on failure the error and the last lines it wrote to stderr, scrubbed.",
      input: obj({ name: str }, ["name"]),
      callers: PEOPLE,
      run: async (input, meta) => { refuseNonPerson(meta, "tests an MCP server"); return hub.test(await rowName(input.name, meta), { who: who(meta) }); },
    });

    ctx.tool("mcp.restart", {
      effect: "write",
      description: "Stop an MCP server and start it again, clearing a failed state and its restart budget.",
      input: obj({ name: str }, ["name"]),
      callers: PEOPLE,
      run: async (input, meta) => hub.restart({ ...input, name: await rowName(input.name, meta) }),
    });

    ctx.tool("mcp.tools", {
      effect: "read",
      description: "List tools of every MCP server this caller may use: name \"<server>__<tool>\", input schema, outward (true: held at the Gate).",
      input: obj({}),
      run: (_, meta) => hub.tools(who(meta)),
    });

    ctx.tool("mcp.call", {
      effect: "write",
      callers: [...PEOPLE, "mcp", "harness"], // a model session may call; the hub scopes servers to the caller and holds anything outward at the Gate
      description: "Call a tool on an MCP server. A read runs and returns the result; anything else is held at the Gate for approval.",
      input: obj({ server: str, tool: str, name: { type: "string", description: "\"<server>__<tool>\", instead of server and tool." }, arguments: { type: "object" },
        hold: { type: "boolean", description: "modules only: hold this call at the Gate even if the tool reads" },
        on_behalf: obj({ thread: str, agent: str }) }),
      run: async (input, meta) => {
        // One of Vyre's own modules (mail) calls for a chat or an agent: the held item is filed
        // under that thread and agent, checked against the Switchboard (connectors/behalf.js), and
        // the server scope becomes that agent's or that thread's project, never the person's.
        // From anyone else on_behalf is dropped, never trusted. `hold` only makes a call stricter,
        // so any module may ask for it.
        const mod = String(meta.caller || "").startsWith("module:");
        const { hold, on_behalf, ...rest } = input;
        const w = who(meta);
        const b = await checkBehalf((tool, x) => ctx.call(tool, x), meta, on_behalf);
        if (b) {
          if (b.thread) w.thread = b.thread;
          if (b.agent) w.agent = b.agent;
          w.person = false;
        }
        return hub.call({ ...rest, ...(mod && hold === true ? { hold: true } : {}) }, w);
      },
    });

    ctx.tool("mcp.grant", {
      internal: true,
      description: "The connectors module lets one thread use a server after the person tagged it (#Slack) in their own turn.",
      input: obj({ server: str, thread: str }, ["server", "thread"]),
      run: (input, { caller }) => {
        if (caller !== "module:connectors") throw Object.assign(new Error("only the connectors module grants a thread"), { code: "denied" });
        return hub.grantThread(input);
      },
    });

    ctx.tool("mcp.release", {
      internal: true,
      description: "The Gate runs an approved call: exactly the approved arguments, on the server the item was held for.",
      input: obj({ id: str, to: { type: "array", items: str }, content: { type: "object" } }, ["id", "content"]),
      run: (input, { caller }) => {
        if (caller !== "module:gate") throw Object.assign(new Error("only the Gate releases a held call"), { code: "denied" });
        return hub.release(input);
      },
    });

    return { async stop() { await hub.stop(); } };
  },
};
