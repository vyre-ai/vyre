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

import { Credentials } from "../../lib/connectors/auth.js";
import { checkBehalf } from "../../lib/connectors/behalf.js";
import { catalogFrom } from "../../lib/connector-presets/index.js";
import { connect } from "./client.js";
import { Hub, MIGRATIONS, TRANSPORTS, AUTH_TYPES, whoFrom } from "./hub.js";

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
      threadProject: async thread => {
        const t = await ctx.call("threads.get", { thread, limit: 1 });
        return (t.data && t.data.thread && t.data.thread.project) || null;
      },
      idle: Number.isInteger(opts.idle) ? opts.idle : undefined,
      httpHosts: Array.isArray(opts.httpHosts) ? opts.httpHosts.map(String) : [],
      boundFor: catalogFrom(ctx.config).boundFor,
      lineage: async thread => {
        const r = await ctx.call("threads.lineage", { thread });
        const d = r && r.data;
        return Array.isArray(d) ? d.map(x => String(x && x.thread || x)) : Array.isArray(d && d.ancestors) ? d.ancestors.map(x => String(x && x.thread || x)) : [];
      },
    });

    for (const r of hub.rows()) await offer(r.name);

    const who = (meta) => whoFrom(meta.caller, meta);

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
      run: (input, meta) => { refuseProcess(input, meta); return hub.add(input); },
    });

    ctx.tool("mcp.update", {
      effect: "write",
      description: "Change an MCP server: any field of mcp.add. A new command, url or credential stops the running server and drops its cached tools.",
      input: obj({ name: str, ...fields }, ["name"]),
      callers: PEOPLE,
      run: (input, meta) => { refuseProcess(input, meta, (hub.row(input.name) || {}).transport); return hub.update(input); },
    });

    ctx.tool("mcp.remove", {
      effect: "write",
      description: "Remove an MCP server. Its process stops; its vault items and grants are left as they are.",
      input: obj({ name: str }, ["name"]),
      callers: PEOPLE,
      run: input => hub.remove(input),
    });

    ctx.tool("mcp.test", {
      effect: "write",
      description: "Start an MCP server (or use the running one), list its tools and cache them. Says how long it took, and on failure the error and the last lines it wrote to stderr, scrubbed.",
      input: obj({ name: str }, ["name"]),
      callers: PEOPLE,
      run: input => hub.test(input.name),
    });

    ctx.tool("mcp.restart", {
      effect: "write",
      description: "Stop an MCP server and start it again, clearing a failed state and its restart budget.",
      input: obj({ name: str }, ["name"]),
      callers: PEOPLE,
      run: input => hub.restart(input),
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
