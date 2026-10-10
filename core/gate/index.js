// @ts-check
// gate — the module: outbound control and approvals (docs/SPEC.md sections 7.7 and 11).
//
// This file is the tool layer. It decides who may call what and hands the work to the Gate class.
// The rule behind the table: anyone may ask for something to go out, only a person may let it go.
// So gate.request is open to Claude, and gate.approve, gate.revise and gate.reject refuse every
// mcp caller. Only approving what acts as the user outside (a send, a spend, a deletion, or an
// outward computer-use act) needs presence
// (core/presence, floor rule 1, the no-nag rule), and one live presence session on the device
// covers it; revising and discarding send nothing and need none. `presence.summary` says what the
// person is proving before they prove it, and every held item carries `presence: {required,
// covered}` so a surface never guesses from the kind. A module may
// approve only when config.json names it under gate.approvers, for a caller not already on the
// explicit allowlist (deck, capsule); Vyre Chat in the app calls as "deck" and needs no
// entry there.
//
// Credentials come from ctx.vault.fetch at the moment of sending (needs.vault "per-sender": the
// items are named by each sender in config.json, and each still needs `vyre vault grant <item>
// gate`), or from vault.relay for a sender that uses someone else's relayed pass.

import { Gate, MIGRATIONS, KINDS } from "./gate.js";
import { isPerson } from "../../lib/caller.js";
import { COVERED } from "../../lib/covered.js";
import { inputHash } from "../presence/index.js";

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
 * their mail, files or posts (which cannot be undone), plus computer use pressing a control that
 * does one of those (kind "act", PLAN.md C4). Approving one needs presence. Every Gate kind is
 * one of these today; a kind added later asks only if it is listed here.
 */
const OUTBOUND = new Set(["send", "spend", "delete", "act"]);

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

    /** Only a person, or a module the person named, lets something go. The person is lib/caller.js isPerson (a person's own surface or device); mcp and harness in any form are never one (MH-1). */
    const mayApprove = caller => {
      const c = String(caller || "");
      if (isPerson(c)) return c;
      if (c.startsWith("module:")) { if (approvers.includes(c.slice(7))) return c; throw new Error(`${c.slice(7)} may not approve for the user \u00b7 add it to gate.approvers in config.json`); }
      // A guest from another tailnet, and an agent's own node, are never the user.
      if (c.startsWith("tailnet-guest:") || c.startsWith("tailnet:agent:")) throw new Error("only the user approves what goes out, never a guest or an agent");
      throw new Error("only the user approves what goes out, never a model");
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

    /**
     * The intent the vault says covers this call, or null: kind, via and EVERY real destination exact
     * (an email's cc and bcc too), the sending agent when the intent names agents, in the call's own
     * thread, its lineage (a teammate working on the person's ask in a parent thread), or standing.
     * A plain ask is used up by the match (consume). A sender that cannot name its destinations never matches.
     */
    const said = async (input, thread, agent) => {
      try {
        const to = gate.recipients(input);
        if (!to || !to.length) return null;
        let lineage = [];
        if (thread) { const l = await ctx.call("threads.lineage", { thread }); if (l && l.data && Array.isArray(l.data.lineage)) lineage = l.data.lineage.map(String); }
        const r = await ctx.call("vault.said.match", { kind: String(input.kind), via: String(input.via), to, consume: true, ...(agent ? { agent } : {}), ...(thread ? { thread } : {}), ...(lineage.length ? { lineage } : {}) });
        return r && r.data && r.data.matched === true && typeof r.data.id === "string" ? r.data.id : null;
      } catch { return null; }
    };

    ctx.tool("gate.request", {
      description: "Ask to send something as the user (email, post, payment, deletion): { kind, via, to, content }. Held until the user approves the final content.",
      input: obj({ kind: { type: "string", enum: KINDS }, via: { type: "string", description: "the way it goes out; tools_call gate.senders lists the values and what each takes" }, to: { anyOf: [str, { type: "array", items: str }] }, content: { type: "object" }, why: str, thread: str, project: str, agent: str,
        asked: { type: "object", description: "A person's own confirmation of exactly this send, from their surface: { surface, hash, at }. hash is inputHash({kind, via, to[], content}); valid 60 s; a mismatch always holds." },
        tool_use_id: { type: "string", description: "The tool call this request comes from, when the caller knows it, so the user's surface can show it in the session." } },
        ["kind", "via", "to", "content"]),
      // A model asks (the request is held for the person); the person's surfaces and modules (the MCP hub, mail, google) file requests too.
      callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "space", "agent", "module", "mcp", "harness"],
      // `agent` in the input is heard only from a module, which files a request for the agent it
      // verified (the MCP hub, whose ctx.call runs as module:mcp). A model's claim is ignored.
      run: async (input, meta0) => {
        const { caller, thread, agent, firstParty } = meta0;
        const covered = meta0[COVERED];
        const filing = await filed(input, caller, thread);
        const by = { agent: agent || agentOf(caller) || (String(caller || "").startsWith("module:") && typeof input.agent === "string" ? input.agent : null) };
        // Asking is approving (P17): what the person's own words covered goes out now, with no
        // card and no proof; anything else holds. No match, or no vault to ask, is a hold as before.
        // A person's own confirmation of exactly this send (Lumen or a Capsule form): from their surface, fresh, and the hash of what they saw.
        const a = input.asked;
        if (a !== undefined) {
          const surface = String(caller || "");
          const dests = (Array.isArray(input.to) ? input.to : [input.to]).map(String).filter(Boolean);
          const fresh = a && typeof a === "object" && Number.isFinite(a.at) && Date.now() - a.at >= -5_000 && Date.now() - a.at <= 60_000;
          const mine = a && a.surface === surface && ["deck", "capsule", "local", "cli"].includes(surface);
          if (fresh && mine && a.hash === inputHash({ kind: input.kind, via: input.via, to: dests, content: input.content })) {
            const { asked: _drop, ...rest } = input;
            return gate.sendNow({ ...rest, ...filing }, { ...by, by: `asked:${surface}` });
          }
          const { asked: _drop, ...rest } = input;
          return gate.request({ ...rest, ...filing }, by);
        }
        // The person already said yes to this send on their phone: the registry redeemed a card bound to the very call a first-party module (mail) is filing this send for. The Gate does not take the
        // mark's word: it asks the approvals queue whether that card was redeemed for this tool, this input and this asker, within its life, and not yet used, and the queue uses it up as it answers.
        // Anything else (no mark, a module that is not Vyre's own, another kind, a card already used, a made-up one) is held as ever.
        if (covered && firstParty === true && input.kind === "send" && (caller === `module:${String(covered.tool).split(".")[0]}` || (Array.isArray(covered.via) && covered.via.some((/** @type {string} */ m) => caller === `module:${m}`)))) {
          const { via: _via, ...mark } = covered;
          const r = await ctx.call("approvals.cover", mark).catch(() => null);
          if (r && r.data && r.data.ok === true) return gate.sendNow({ ...input, ...filing }, { ...by, by: `card:${covered.card}` });
        }
        const intent = await said(input, filing.thread, by.agent);
        if (intent) return gate.sendNow({ ...input, ...filing }, { ...by, intent });
        return gate.request({ ...input, ...filing }, by);
      },
    });

    ctx.tool("gate.senders", {
      description: "The ways out that exist (the `via` of gate.request), the kinds each allows and the content each takes. Never a credential.",
      input: obj({}),
      run: () => gate.senders(),
    });

    ctx.tool("gate.held", {
      description: "What is held at the Gate waiting for the user, oldest first.",
      input: obj({ thread: str, project: str }),
      // Held drafts are the person's own words and recipients: the person's surfaces and modules, as gate.get.
      callers: ["cli", "local", "module", "deck", "capsule", "tailnet", "device", "space", "agent"],
      run: (input, { peer }) => withPresence(gate.held(input), peer),
    });

    ctx.tool("gate.get", {
      description: "One item in full: the draft, what was finally sent, and what the user changed.",
      input: obj({ id: str }, ["id"]),
      callers: ["cli", "local", "module", "deck", "capsule", "tailnet", "device", "space", "agent"],
      run: async (input, { peer }) => (await withPresence([gate.get(input)], peer))[0],
    });

    // who approved, rejected, revised or settled is the caller (S3): the `by` a caller sends is not read
    ctx.tool("gate.revise", {
      description: "The user changes a held item without sending it: the content as it should go out, or the fields that changed (\"\" clears one), `to` included. Send then sends exactly this.",
      input: obj({ id: str, edited: { type: "object" }, by: str }, ["id", "edited"]),
      callers: ["cli", "local", "module", "tailnet", "device"],
      run: (input, { caller }) => { const c = mayApprove(caller); return gate.revise({ ...input, by: c }); },
    });

    ctx.tool("gate.approve", {
      description: "The user approves a held item, optionally with edits (the whole content as it should go out, or the fields that changed; an empty string clears one; `to` included). It sends exactly that, never the original, with the credential added at the boundary.",
      input: obj({ id: str, edited: { type: "object" }, by: str }, ["id"]),
      callers: ["cli", "local", "module", "deck", "capsule", "tailnet", "device"],
      presence: {
        when: ({ id }) => needsProof(id),
        // One passkey or Touch ID opens a ~30 minute session on that device, and the sends after it ride it.
        session: ({ id }) => needsProof(id),
        summary: async ({ id, edited }) => { const it = gate.get({ id }); return `Send ${it.kind} via ${it.via} to ${destOf(edited, it)}: "${previewOf(mergedContent(edited, it))}"`; },
      },
      run: (input, { caller }) => { const c = mayApprove(caller); return gate.approve({ ...input, by: c }); },
    });

    ctx.tool("gate.reject", {
      description: "The user discards a held item. Nothing is sent. The module that offered the item's sender may also take its own item back.",
      input: obj({ id: str, reason: str, by: str }, ["id"]),
      callers: ["cli", "local", "module", "deck", "capsule", "tailnet", "device"],
      run: (input, { caller }) => {
        // Taking an item back sends nothing, so the module whose sender holds it may do so (an outside agent that was ended); any other module goes through the same rule as approving.
        const c = String(caller || "");
        const own = c.startsWith("module:") && gate.row(input.id).sender_module === c.slice(7) ? c : mayApprove(caller);
        return gate.reject({ ...input, by: own });
      },
    });

    ctx.tool("gate.settle", {
      description: "An approved item whose send failed with its answer lost, found to have gone out after all (the app shows the words): mark it sent with the evidence, so it is never sent twice. Only outcome \"sent\", only for an item that was approved and failed. A person, or the module that offered the item's sender.",
      input: obj({ id: str, outcome: { type: "string", enum: ["sent"] }, evidence: { type: "object" }, by: str }, ["id", "outcome"]),
      callers: ["cli", "local", "module", "deck", "capsule"],
      run: (input, { caller }) => {
        const c = String(caller || "");
        // The item's own surface: the module whose sender holds it (mcp for a hub call). Any other
        // module, and every model or guest, goes through the same rule as approving.
        const own = c.startsWith("module:") && gate.row(input.id).sender_module === c.slice(7) ? c : mayApprove(caller);
        return gate.settle({ ...input, by: own });
      },
    });

    ctx.tool("gate.offer", {
      internal: true,
      description: "A module offers a sender of its own: `name` in its namespace (<module>, <module>:<x> or <module>-<x>), and `tool`, one of its own internal tools, which the Gate calls with { id, to, content } once the user approves. Offer again at every start; it replaces the last.",
      input: obj({ name: str, tool: str, recipients: { type: "string", enum: ["to"] }, kinds: { type: "array", items: { type: "string", enum: KINDS } }, content: { type: "object" } }, ["name", "tool"]),
      run: (input, { caller, firstParty }) => gate.offer(input, caller, firstParty === true),
    });

    // What the person's own words asked to go out (P17). The intents live in the vault; these are
    // the person's two tools over them, so nothing here can record one. Taking one back needs no proof.
    const approvedBy = caller => { mayApprove(caller); return String(caller); };
    const vaultCall = async (tool, input) => {
      const r = await ctx.call(tool, input);
      if (r.error) throw Object.assign(new Error(r.error.code === "no_such_tool" ? "the vault is not running on this machine" : r.error.message), { code: r.error.code });
      return r.data;
    };

    // The person's own surfaces, or the assistant acting for them. Anything else is refused.
    const isAssistant = caller => String(caller) === "module:assistant";

    ctx.tool("gate.said.list", {
      description: "What you have asked to go out, by voice or in chat: each thing Vyre will send, post or pay without asking again, and standing permissions. Revoked ones with `all`. The assistant may read it for you.",
      input: obj({ thread: str, all: { type: "boolean" } }),
      callers: ["cli", "local", "deck", "capsule", "module"],
      run: (input, { caller }) => { if (!isAssistant(caller)) approvedBy(caller); return vaultCall("vault.said.list", input); },
    });

    ctx.tool("gate.said.add", {
      description: "Add a standing permission yourself, from Settings: what may go out without asking each time. `kind` send, post or pay; `to` the exact addresses, handles or channels; `agents` to limit it to named agents (none means any of yours); a pay one needs `limits {max_amount, currency}`. Only you, on your own surface, add one; needs no proof, since you asked.",
      input: obj({ kind: { type: "string", enum: ["send", "post", "pay", "act_out"] }, channel: str, to: { type: "array", items: str }, what: str, agents: { type: "array", items: str }, limits: obj({ max_amount: { type: "number" }, currency: str }) }, ["kind", "to"]),
      callers: ["cli", "local", "deck", "capsule"],
      // A rare, power-granting act: paying, or a blanket allow that names no agent, needs a person's proof (the Deck's presence session
      // covers it). A narrow send or post for named agents stays one tap. The summary names the kind, the recipients and the cap, so
      // the proof binds exactly this permission. Taking one away (gate.said.revoke) never needs proof.
      presence: {
        when: (/** @type {any} */ i) => Boolean(i) && (i.kind === "pay" || !(Array.isArray(i.agents) && i.agents.length)),
        summary: (/** @type {any} */ i) => {
          const to = Array.isArray(i && i.to) && i.to.length ? i.to.join(", ") : "no one named";
          const who = Array.isArray(i && i.agents) && i.agents.length ? `only ${i.agents.join(", ")}` : "any agent";
          const cap = i && i.limits && typeof i.limits === "object" ? Object.entries(i.limits).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ") : "";
          return `Allow a standing permission to ${i && i.kind} to ${to} for ${who}${cap ? ` (${cap})` : ""}`;
        },
      },
      run: (input, { caller }) => { approvedBy(caller); return vaultCall("vault.said.add", { ...input, surface: String(caller) }); },
    });

    ctx.tool("gate.said.revoke", {
      description: "Take back something you asked to go out, or a standing permission. It stops covering sends at once. Needs no proof: taking permission away never does. The assistant may do it only when your own words asked for it (\"stop letting kit post there\").",
      input: obj({ id: str, thread: str }, ["id"]),
      callers: ["cli", "local", "deck", "capsule", "module"],
      run: async (input, { caller }) => {
        if (!isAssistant(caller)) { approvedBy(caller); return vaultCall("vault.said.revoke", { id: input.id }); }
        // The assistant acts for the person only on an intent of kind "revoke" that names this id,
        // recorded from the person's own turn in this thread (or its lineage), and used up by this call.
        if (!input.thread) throw new Error("say which thread the request came from: thread");
        let lineage = [];
        const l = await ctx.call("threads.lineage", { thread: input.thread });
        if (l && l.data && Array.isArray(l.data.lineage)) lineage = l.data.lineage.map(String);
        const m = await vaultCall("vault.said.match", { kind: "revoke", to: [String(input.id)], thread: input.thread, lineage, consume: true });
        if (!m || m.matched !== true) throw new Error("only you can take a permission back, unless your own words in this conversation asked for it");
        return vaultCall("vault.said.revoke", { id: input.id });
      },
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
