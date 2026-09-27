// @ts-check
// gate — the module: outbound control and approvals (docs/SPEC.md sections 7.7 and 11).
//
// This file is the tool layer. It decides who may call what and hands the work to the Gate class.
// The rule behind the table: anyone may ask for something to go out, only a person may let it go.
// So gate.request is open to Claude, and gate.approve, gate.revise and gate.reject refuse every
// mcp caller. Only approving what acts as the user outside (a send, a spend, a deletion) needs presence
// (core/presence, floor rule 1, the no-nag rule), and one live presence session on the device
// covers it; revising and discarding send nothing and need none. `presence.summary` says what the
// person is proving before they prove it, and every held item carries `presence: {required,
// covered}` so a surface never guesses from the kind. A module may
// approve only when config.json names it under gate.approvers, for a caller not already on the
// explicit allowlist (deck, capsule); Vyre Chat is deck/chat/, so it calls as "deck" and needs no
// entry there.
//
// Credentials come from ctx.vault.fetch at the moment of sending (needs.vault "per-sender": the
// items are named by each sender in config.json, and each still needs `vyre vault grant <item>
// gate`), or from vault.relay for a sender that uses someone else's relayed pass.

import { Gate, MIGRATIONS, KINDS } from "./gate.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const agentOf = caller => { const m = /^mcp:agent:(.+)$/.exec(String(caller || "")); return m ? m[1] : null; };

/** A model's call: Claude through MCP, in an agent's thread or not. */
const byModel = caller => /^mcp(?:$|[\s:])/.test(String(caller || ""));

// Presence summaries (security, docs/adr/0004-presence.md): what the person sees on the
// terminal or in the dialog before they prove they are there, so they never approve, revise or
// discard blind. gate.get's own shape, not a made-up one: `to`, `draft`, `final`.
const destOf = (edited, it) => [].concat((edited && edited.to) ?? it.to).filter(Boolean).join(", ") || "(no destination)";
const mergedContent = (edited, it) => ({ ...(it.final || it.draft), ...(edited || {}) });
// An MCP call held by the hub keeps its words in `arguments` (a Slack post's text or payload).
const wordsOf = a => (a && typeof a === "object" ? a.text || a.payload || a.message || a.body || a.content : "") || "";
const previewOf = c => String((c && (c.subject || c.body || wordsOf(c.arguments) || (c.method && c.url ? `${c.method} ${c.url}` : ""))) || "").replace(/\s+/g, " ").trim().slice(0, 120);

/**
 * The kinds that act as the user in the outside world: sending or posting, paying, and deleting
 * their mail, files or posts (which cannot be undone). Approving one needs presence. Every Gate
 * kind is one of these today; a kind added later asks only if it is listed here.
 */
const OUTBOUND = new Set(["send", "spend", "delete"]);

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
      // A module's own sender (gate.offer) sends through its tool, called as module:gate.
      call: (t, i) => ctx.call(t, i),
      log: m => ctx.log(m),
    });

    const stuck = gate.recover();
    if (stuck) ctx.log(`${stuck} item(s) were mid-send when vyred stopped; back to held, marked as possibly sent`);

    /** Only a person, or a module the person named, lets something go. */
    const person = caller => {
      const c = String(caller || "");
      if (c.startsWith("mcp")) throw new Error("only the user approves what goes out, never a model");
      // A guest from another tailnet, and an agent's own node, are never the user.
      if (c.startsWith("tailnet-guest:") || c.startsWith("tailnet:agent:")) throw new Error("only the user approves what goes out, never a guest or an agent");
      if (c.startsWith("module:") && !approvers.includes(c.slice(7))) throw new Error(`${c.slice(7)} may not approve for the user · add it to gate.approvers in config.json`);
      return c;
    };

    /**
     * Which thread (session id) and project a held item is filed under. vyred passes the thread it
     * verified for the caller (an agent's thread, or the session the MCP server's hook bound), and
     * that wins: a model cannot file a draft under another session, and one that says nothing is
     * filed under its own. An unverified thread from a model is refused; people and modules name
     * any. So does the project: the thread's, when the Switchboard knows it.
     * @param {any} input @param {string} caller @param {string|undefined} verified
     */
    const filed = async (input, caller, verified) => {
      if (byModel(caller) && input.thread && input.thread !== verified)
        throw new Error(verified ? `this call comes from thread ${verified}; it cannot file under ${input.thread}` : `thread ${input.thread} is not one vyred can confirm this call comes from; leave thread out`);
      const thread = verified || input.thread || undefined;
      if (!thread || (input.project && !byModel(caller))) return { thread };
      // A model's project is the one its thread is in, when the Switchboard knows it.
      const t = await ctx.call("threads.get", { thread, limit: 1 });
      const known = t.data && t.data.thread && t.data.thread.project;
      return { thread, ...(known ? { project: known } : {}) };
    };

    /** Does approving this item need a proof? Anything the Gate cannot find asks. */
    const needsProof = id => { try { return OUTBOUND.has(gate.get({ id }).kind); } catch { return true; } };
    /** Whether the caller's device has a live presence session, and since when (presence.covered). */
    const coverage = async peer => {
      const r = await ctx.call("presence.covered", peer ? { peer } : {});
      const d = r.data || {};
      return { covered: Boolean(d.covered), since: d.since ?? null };
    };
    /** Each item with what approving it takes, for this caller's device. */
    const withPresence = async (items, peer) => {
      const c = items.length ? await coverage(peer) : { covered: false, since: null };
      return items.map(it => ({ ...it, presence: { required: OUTBOUND.has(it.kind), ...c } }));
    };

    ctx.tool("gate.request", {
      description: "Ask for something to go out as the user: an email, a post, a payment, a deletion. It is held until the user approves the final content; nothing is sent from here. See gate.senders for the `via` values and what each takes.",
      input: obj({ kind: { type: "string", enum: KINDS }, via: str, to: { anyOf: [str, { type: "array", items: str }] }, content: { type: "object" }, why: str, thread: str, project: str, agent: str,
        tool_use_id: { type: "string", description: "The tool call this request comes from, when the caller knows it, so the user's surface can show it in the session." } },
        ["kind", "via", "to", "content"]),
      // `agent` in the input is heard only from a module, which files a request for the agent it
      // verified (the MCP hub, whose ctx.call runs as module:mcp). A model's claim is ignored.
      run: async (input, { caller, thread, agent }) => gate.request({ ...input, ...(await filed(input, caller, thread)) },
        { agent: agent || agentOf(caller) || (String(caller || "").startsWith("module:") && typeof input.agent === "string" ? input.agent : null) }),
    });

    ctx.tool("gate.senders", {
      description: "The ways out that exist (the `via` of gate.request), the kinds each allows and the content each takes. Never a credential.",
      input: obj({}),
      run: () => gate.senders(),
    });

    ctx.tool("gate.held", {
      description: "What is held at the Gate waiting for the user, oldest first.",
      input: obj({ thread: str, project: str }),
      run: (input, { peer }) => withPresence(gate.held(input), peer),
    });

    ctx.tool("gate.get", {
      description: "One item in full: the draft, what was finally sent, and what the user changed.",
      input: obj({ id: str }, ["id"]),
      callers: ["cli", "local", "module", "deck", "capsule"],
      run: async (input, { peer }) => (await withPresence([gate.get(input)], peer))[0],
    });

    ctx.tool("gate.revise", {
      description: "The user changes a held item without sending it: the content as it should go out, or the fields that changed (\"\" clears one), `to` included. Send then sends exactly this.",
      input: obj({ id: str, edited: { type: "object" }, by: str }, ["id", "edited"]),
      callers: ["cli", "local", "module"],
      run: (input, { caller }) => { const c = person(caller); return gate.revise({ ...input, by: input.by || c }); },
    });

    ctx.tool("gate.approve", {
      description: "The user approves a held item, optionally with edits (the whole content as it should go out, or the fields that changed; an empty string clears one; `to` included). It sends exactly that, never the original, with the credential added at the boundary.",
      input: obj({ id: str, edited: { type: "object" }, by: str }, ["id"]),
      callers: ["cli", "local", "module", "deck", "capsule"],
      presence: {
        when: ({ id }) => needsProof(id),
        // One passkey or Touch ID opens a ~30 minute session on that device, and the sends after it ride it.
        session: ({ id }) => needsProof(id),
        summary: async ({ id, edited }) => { const it = gate.get({ id }); return `Send ${it.kind} via ${it.via} to ${destOf(edited, it)}: "${previewOf(mergedContent(edited, it))}"`; },
      },
      run: (input, { caller }) => { const c = person(caller); return gate.approve({ ...input, by: input.by || c }); },
    });

    ctx.tool("gate.reject", {
      description: "The user discards a held item. Nothing is sent.",
      input: obj({ id: str, reason: str, by: str }, ["id"]),
      callers: ["cli", "local", "module", "deck", "capsule"],
      run: (input, { caller }) => { const c = person(caller); return gate.reject({ ...input, by: input.by || c }); },
    });

    ctx.tool("gate.settle", {
      description: "An approved item whose send failed with its answer lost, found to have gone out after all (the app shows the words): mark it sent with the evidence, so it is never sent twice. Only outcome \"sent\", only for an item that was approved and failed. A person, or the module that offered the item's sender.",
      input: obj({ id: str, outcome: { type: "string", enum: ["sent"] }, evidence: { type: "object" }, by: str }, ["id", "outcome"]),
      callers: ["cli", "local", "module", "deck", "capsule"],
      run: (input, { caller }) => {
        const c = String(caller || "");
        // The item's own surface: the module whose sender holds it (mcp for a hub call). Any other
        // module, and every model or guest, goes through the same rule as approving.
        const own = c.startsWith("module:") && gate.row(input.id).sender_module === c.slice(7) ? c : person(caller);
        return gate.settle({ ...input, by: input.by || own });
      },
    });

    ctx.tool("gate.offer", {
      internal: true,
      description: "A module offers a sender of its own: `name` in its namespace (<module>, <module>:<x> or <module>-<x>), and `tool`, one of its own internal tools, which the Gate calls with { id, to, content } once the user approves. Offer again at every start; it replaces the last.",
      input: obj({ name: str, tool: str, kinds: { type: "array", items: { type: "string", enum: KINDS } }, content: { type: "object" } }, ["name", "tool"]),
      run: (input, { caller }) => gate.offer(input, caller),
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
