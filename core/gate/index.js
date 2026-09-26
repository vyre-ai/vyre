// @ts-check
// gate — the module: outbound control and approvals (docs/SPEC.md sections 7.7 and 11).
//
// This file is the tool layer. It decides who may call what and hands the work to the Gate class.
// The rule behind the table: anyone may ask for something to go out, only a person may let it go.
// So gate.request is open to Claude, and gate.approve and gate.reject refuse every mcp caller.
// A module may approve only when config.json names it under gate.approvers: Chat does, because
// it checks that the button was pressed by the owner's own Mattermost user before it calls.
//
// Credentials come from ctx.vault.fetch at the moment of sending (needs.vault "per-sender": the
// items are named by each sender in config.json, and each still needs `vyre vault grant <item>
// gate`), or from vault.relay for a sender that uses someone else's relayed pass.

import { Gate, MIGRATIONS, KINDS } from "./gate.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const agentOf = caller => { const m = /^mcp:agent:(.+)$/.exec(String(caller || "")); return m ? m[1] : null; };

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const opts = (ctx.config && ctx.config.gate) || {};
    const approvers = Array.isArray(opts.approvers) ? opts.approvers.map(String) : ["chat"];

    const gate = new Gate({
      db: ctx.store.db,
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
      fetchCredential: (item, field) => ctx.vault.fetch(item, field ? { field } : {}),
      relay: async input => {
        const r = await ctx.call("vault.relay", input);
        if (r.error) throw new Error(r.error.code === "no_such_tool" ? "the vault is not running on this machine" : r.error.message);
        return r.data;
      },
      teach: (kind, fact) => ctx.memory.teach(kind, fact),
      senders: opts.senders || {},
      log: m => ctx.log(m),
    });

    const stuck = gate.recover();
    if (stuck) ctx.log(`${stuck} item(s) were mid-send when vyred stopped; back to held, marked as possibly sent`);

    /** Only a person, or a module the person named, lets something go. */
    const person = caller => {
      const c = String(caller || "");
      if (c.startsWith("mcp")) throw new Error("only the user approves what goes out, never a model");
      if (c.startsWith("module:") && !approvers.includes(c.slice(7))) throw new Error(`${c.slice(7)} may not approve for the user · add it to gate.approvers in config.json`);
      return c;
    };

    ctx.tool("gate.request", {
      description: "Ask for something to go out as the user: an email, a post, a payment, a deletion. It is held until the user approves the final content; nothing is sent from here. See gate.senders for the `via` values and what each takes.",
      input: obj({ kind: { type: "string", enum: KINDS }, via: str, to: { anyOf: [str, { type: "array", items: str }] }, content: { type: "object" }, why: str, thread: str, project: str },
        ["kind", "via", "to", "content"]),
      run: (input, { caller }) => gate.request(input, { agent: agentOf(caller) }),
    });

    ctx.tool("gate.senders", {
      description: "The ways out that exist (the `via` of gate.request), the kinds each allows and the content each takes. Never a credential.",
      input: obj({}),
      run: () => gate.senders(),
    });

    ctx.tool("gate.held", {
      description: "What is held at the Gate waiting for the user, oldest first.",
      input: obj({ thread: str, project: str }),
      run: input => gate.held(input),
    });

    ctx.tool("gate.get", {
      description: "One item in full: the draft, what was finally sent, and what the user changed.",
      input: obj({ id: str }, ["id"]),
      callers: ["cli", "local", "module"],
      run: input => gate.get(input),
    });

    ctx.tool("gate.approve", {
      description: "The user approves a held item, optionally with edits (the fields that changed, `to` included). It is sent now, with the credential added at the boundary.",
      input: obj({ id: str, edited: { type: "object" }, by: str }, ["id"]),
      callers: ["cli", "local", "module"],
      run: (input, { caller }) => { const c = person(caller); return gate.approve({ ...input, by: input.by || c }); },
    });

    ctx.tool("gate.reject", {
      description: "The user discards a held item. Nothing is sent.",
      input: obj({ id: str, reason: str, by: str }, ["id"]),
      callers: ["cli", "local", "module"],
      run: (input, { caller }) => { const c = person(caller); return gate.reject({ ...input, by: input.by || c }); },
    });

    ctx.tool("gate.route", {
      internal: true,
      description: "harness.rules: whether a sending MCP tool should go through the Gate instead.",
      input: obj({ tool: str, input: { type: "object" }, agent: str, session: str }, ["tool"]),
      run: input => gate.route(input),
    });

    return { async stop() {} };
  },
};
