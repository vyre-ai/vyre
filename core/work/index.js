// @ts-check
// work: the 0.3 work layer as module tools (DESIGN-native-assistant, DESIGN-tasks). Four things, one module, all over the kernel contracts:
//  - native.*   the tool surface generated from the Space's definitions and the action registry (kernel/tools), the situation and the component for a result
//  - teammates.* what a teammate starts with, adding one under the adder's ceiling, the doing-now line
//  - recall.*   the three-layer memory: lines, meaning search, answers with citations, fact proposals
//  - engineer.* the admin-only Engineer: propose, revise, approve under the admin's own presence proof
// The module holds no authority. `ctx.kernel` (platform's) hands over the assembled Kernel and `ctx.kernel.chainFor(extra)`, which builds the chain from
// the call's own facts; a tool never builds or accepts a chain from its input. Until platform wires ctx.kernel every tool answers `unavailable`.

import { createToolSurface } from "../../kernel/tools/surface.js";
import { buildSituation } from "./native/situation.js";
import { createHub } from "./hub.js";
import { toComponent } from "./native/components.js";
import { teammateContext } from "./team/context.js";
import { teammateFromRole, markReviewed, checkAdd, addCardData } from "./team/roles.js";
import { delegateGrants } from "./team/delegate.js";
import { createDoingLine } from "./team/doing.js";
import { createMemoryEngine } from "./memory/index.js";
import { createEngineer } from "./engineer/index.js";

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const unavailable = () => Object.assign(new Error("the kernel is not wired on this box yet"), { code: "unavailable" });
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
/** Who may call the tools the assistant itself uses: the person's surfaces, modules and a model session. Every one runs under the caller's own kernel chain, which decides what it reaches; a model with no valid session token has no chain and is refused. */
const WORK_CALLERS = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "space", "agent", "module", "mcp", "harness"];
const urnOk = (/** @type {any} */ s) => typeof s === "string" && /^vyre:\/\/[^/]+\/[^/]+\/[^/]+$/.test(s);

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    /** @type {any} */ let surface = null;
    /** @type {any} */ let engine = null;
    /** @type {any} */ let engineer = null;
    /** @type {Map<string, any>} */ const doing = new Map();

    /** The kernel and the chain for this call. Both come from platform; a refusal to build a chain is the caller's, not ours. */
    const kernelOf = () => { const k = ctx.kernel; if (!k || typeof k.chainFor !== "function") throw unavailable(); return k; };
    const chainOf = (/** @type {any} */ extra) => kernelOf().chainFor(extra || {});
    /**
     * The room this call is running in, from the running session and never from the tool's input (a model that can name the chat can leave it out). `null` means
     * the kernel says it is a chat of one person; otherwise it is the kernel's room handle (no chain of another person ever reaches this module). If the kernel cannot say which, or says group and gives no audience, the
     * call is refused: there is no fallback to the one to one view.
     */
    const audienceOf = async (/** @type {any} */ extra) => {
      const k = kernelOf();
      const unknown = (/** @type {string} */ why) => Object.assign(new Error(why), { code: "unavailable" });
      if (typeof k.audienceFor !== "function") throw unknown("the room this runs in is not known, so nothing is built for it");
      // The kernel says `no_audience` for a call with no session of its own (the person at a surface, a session opened with no chat). That is one to one only when the call's own chain names no
      // chat either; a chain that names a chat and has no audience stays refused.
      const room = await k.audienceFor(extra || {}).catch(async (/** @type {any} */ e) => {
        if (e && e.code === "no_audience") { const own = await chainOf(extra).catch(() => null); if (own && !own.room) return { group: false }; }
        throw e;
      });
      if (!room || typeof room.group !== "boolean") throw unknown("the room this runs in is not known, so nothing is built for it");
      if (!room.group) return null;
      if (typeof room.read !== "function" || typeof room.canRead !== "function") throw unknown("this is a group chat and its audience is not known, so nothing is built for it");
      return room;
    };
    // KW-1 (kernel side): a `session` resource is read only by the person its `owner` attribute names, and no attribute means nobody. This module holds a session's lines, so it says whose they
    // are: the Space's owner (Recall indexes the owner's own sessions), and the project when the lines sit under one. Only for its own type, only `owner` and `project` (AT-1).
    if (ctx.kernel && typeof ctx.kernel.registerAttrs === "function") {
      ctx.kernel.registerAttrs("session", (/** @type {string} */ urn) => {
        const m = /^vyre:\/\/[^/]+\/session\/([A-Za-z0-9_.:-]{1,128})$/.exec(String(urn));
        if (!m) return {};
        try {
          const meta = engineOf().lines.meta(m[1]);
          if (!meta) return {};
          const p = /^vyre:\/\/[^/]+\/project\/([a-z0-9][a-z0-9_-]{0,79})$/i.exec(meta.record);
          return { owner: String(ctx.kernel.owner), ...(p ? { project: p[1] } : {}) };
        } catch { return {}; }
      });
    }
    const surfaceOf = () => surface || (surface = createToolSurface({ kernel: kernelOf(), space: kernelOf().space, types: async c => (kernelOf().definitions ? kernelOf().definitions(c) : []), actions: () => (kernelOf().actions ? kernelOf().actions() : []) }));
    const engineOf = () => {
      if (engine) return engine;
      const k = kernelOf();
      if (!k.serviceChain || !k.chainForPerson || !ctx.store || !ctx.store.db) throw unavailable();
      return (engine = createMemoryEngine({ kernel: k, db: ctx.store.db, space: k.space, serviceChain: k.serviceChain("memory"), chainFor: k.chainForPerson, ...(k.embed ? { embed: k.embed } : {}), ...(k.fieldDef ? { fieldDef: k.fieldDef, ownerOf: k.ownerOf } : {}) }));
    };
    const engineerOf = () => {
      if (engineer) return engineer;
      const k = kernelOf();
      if (!k.compile) throw unavailable();
      return (engineer = createEngineer({ kernel: k, compile: k.compile, simulate: k.simulate || null, ...(k.engineerChain ? { engineerChain: k.engineerChain } : {}) }));
    };

    // The Project hub: a Project is one record; each session is a summary record linked to it (core/work/hub.js, team/0.3/DESIGN-project-hub.md).
    /** @type {any} */ let hub = null;
    const hubOf = () => hub || (hub = createHub({ kernel: kernelOf(), call: async (tool, input) => { try { return await ctx.call(tool, input); } catch { return null; } }, log: ctx.log }));
    if (ctx.kernel && ctx.events && typeof ctx.events.on === "function") {
      ctx.events.on("thread.started", (/** @type {any} */ e) => { void hubOf().onStarted(e && e.payload).catch(() => {}); });
      ctx.events.on("thread.stopped", (/** @type {any} */ e) => { void hubOf().onStopped(e && e.payload).catch(() => {}); });
    }
    ctx.tool("work.project.create", {
      description: "Make a Project: one record that holds the work's sessions, Drive folder (Projects/<short name>), repository and memory. Give a name, and optionally a repo (a git remote) and a client record.",
      input: obj({ name: { type: "string" }, repo: { type: "string" }, client: { type: "string" }, slug: { type: "string" } }, ["name"]),
      run: async (input, extra) => {
        const rec = await hubOf().createProject(await chainOf(extra), { name: input.name, repo: input.repo, client: input.client, slug: input.slug });
        return { project: rec.urn, slug: rec.data.slug, drive_path: rec.data.drive_path, memory_scope: rec.data.memory_scope };
      },
    });
    ctx.tool("work.tools", {
      description: "The tools this caller may use in this Space, generated from its record definitions and the action registry and cut by what the caller may do. A tool the caller cannot use is not listed.",
      input: obj(),
      run: async (_input, extra) => ({ tools: await surfaceOf().list(await chainOf(extra)) }),
    });
    ctx.tool("work.call", {
      description: "Run one of the listed tools. Returns { result, component }: the component is what to show, a record card, a task card, a draft or a held-for-approval card. An outward act (send, pay, publish, share) is never run: it returns held with a task, and a person approves it.",
      input: obj({ tool: { type: "string" }, input: { type: "object" } }, ["tool"]),
      callers: WORK_CALLERS,
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        const result = await surfaceOf().call(chain, String(input.tool), input.input || {});
        const types = {};
        for (const t of kernelOf().definitions ? await kernelOf().definitions(chain) : []) /** @type {any} */ (types)[t.name] = t;
        const normal = result && result.held ? { held: true, task: result.held.task, summary: result.held.summary, approver: result.held.approver } : result;
        return { result, component: toComponent(String(input.tool), normal, { types }) };
      },
    });
    /** The named assistant a chain acts as (its last hop), or null: project memory is read for an agent. @param {any} chain */
    const agentOf = chain => { const h = chain && chain.hops && chain.hops[chain.hops.length - 1]; return h && h.actor && h.actor.kind === "agent" ? String(h.actor.id) : null; };
    // The Space's own context budget (a Space setting kept with its Flows; an owner or admin sets it through flows.budget { context_tokens }); 1,200 when there is no Flows assembly.
    const spaceContextTokens = async (/** @type {any} */ k, /** @type {any} */ chain) => { try { const h = ctx.flowsHost && ctx.flowsHost.get(k.space); const b = h && await h.flows.tools["flows.budget"](chain, {}); return b && b.context_tokens || 1200; } catch { return 1200; } };
    ctx.tool("work.situation", {
      description: "Where the caller is, in a few hundred tokens: the Space, their role, the project or record in scope, the team, open tasks, what waits on them, and what is sealed and why. With `context: true`, or a `task`, also the record's world: the records it links to and that link to it, recent communications with the people on it, and what happened to it lately.",
      input: obj({ project: { type: "string" }, record: { type: "string" }, context: { type: "boolean" }, task: { type: "string" }, context_tokens: { type: "number" } }),
      run: async (input, extra) => {
        const k = kernelOf();
        const ref = (/** @type {any} */ u) => { if (!urnOk(u)) return undefined; const [, , , type, id] = u.split("/"); return { type, id }; };
        let project = ref(input.project), record = ref(input.record);
        const chain = await chainOf(extra);
        let asked = Number.isFinite(input.context_tokens) ? input.context_tokens : undefined;
        // A task names the record it is about: an agent doing it gets that record's world as well
        if (typeof input.task === "string" && input.task && !record) {
          const t = await k.ask.get(chain, input.task).catch(() => null);
          if (t && typeof t.record === "string") record = ref(t.record);
          // a task may ask for more of the record's world (form.context_tokens), within the ceiling
          if (asked === undefined && t && t.form && Number.isFinite(t.form.context_tokens)) asked = t.form.context_tokens;
        }
        const lines = Object.fromEntries([...doing.values()].flatMap(d => [...(d.lines || [])]));
        return buildSituation(k, chain, { space: k.space, ...(project ? { project } : {}), ...(record ? { record } : {}), doing: lines, room: await audienceOf(extra), memory: agentOf(chain) ? async (/** @type {string} */ slug) => { const r = await ctx.call("memory.brief", { project: slug, agent: agentOf(chain) }); const d = r && (r.data !== undefined ? r.data : r); return d && typeof d.text === "string" ? d.text : null; } : null, context: (input.context === true || typeof input.task === "string") ? { budget: Math.max(200, Math.min(8000, Math.trunc(asked ?? await spaceContextTokens(k, chain)))) } : false });
      },
    });

    ctx.tool("work.team.context", {
      description: "What a teammate starts with on a project: its role instructions, the project and its linked records without sealed fields, and the Kit's templates.",
      input: obj({ project: { type: "string" }, role: { type: "object" }, templates: { type: "array" } }, ["project"]),
      run: async (input, extra) => {
        const k = kernelOf();
        const r = await teammateContext(k, await chainOf(extra), { project: input.project, space: k.space, ...(input.role ? { role: input.role } : {}), templates: Array.isArray(input.templates) ? input.templates : [] });
        return { text: r.text, records: r.urns, labels: r.labels, skipped: r.skipped };
      },
    });
    ctx.tool("work.team.add", {
      description: "Add an assistant teammate to a project from a Kit role. Its grants are narrowings of the adder's and never wider. Without { approved: true } this returns the card to show, and nothing is created.",
      input: obj({ project: { type: "string" }, role: { type: "object" }, approved: { type: "boolean" }, count: { type: "integer" } }, ["project", "role"]),
      run: async (input, extra) => {
        const k = kernelOf(), chain = await chainOf(extra);
        const adder = chain.hops[0].actor;
        if (!urnOk(input.project)) throw fail("bad_input", "the project is a vyre:// address");
        let spec = teammateFromRole(input.role, { project: input.project, space: k.space, ...(k.registry ? { registry: k.registry() } : {}) });
        if (!input.approved) return { card: addCardData(spec) };
        spec = markReviewed(spec, adder.id);
        const ok = checkAdd({ spec, adder, count: Number(input.count) || 0, humanApproved: adder.kind === "person" });
        if (!ok.ok) throw fail(ok.reason === "cap" ? "cap" : "needs_human", String(ok.detail));
        const teammate = { kind: /** @type {const} */ ("agent"), id: `${spec.name}.${input.project.split("/").pop()}`, space: k.space };
        const made = await delegateGrants(k, chain, { adder, teammate, wanted: spec.wanted, presence: typeof k.proofFrom === "function" ? (/** @type {any} */ _i) => k.proofFrom(extra).presence : null });
        return { teammate, grants: made.grants.map((/** @type {any} */ g) => g.id), obligations: made.obligations };
      },
    });
    ctx.tool("work.team.doing", {
      description: "What each teammate on a project is doing right now, one plain line each, from the project's own events. Updates at most once a minute.",
      input: obj({ project: { type: "string" } }, ["project"]),
      run: async (input, extra) => {
        const k = kernelOf();
        if (!urnOk(input.project)) throw fail("bad_input", "the project is a vyre:// address");
        let d = doing.get(input.project);
        if (!d) {
          const lines = new Map();
          const line = createDoingLine(k, { project: input.project, onLine: (t, l) => { if (l) lines.set(t, l); else lines.delete(t); } });
          d = { line, lines, off: line.attach(await chainOf(extra)) };
          doing.set(input.project, d);
        }
        d.line.tick();
        return { lines: Object.fromEntries(d.lines) };
      },
    });

    ctx.tool("work.know.search", {
      description: "Search the Space's records, events and session lines by meaning. Only sources the caller may read come back, each with its address.",
      input: obj({ query: { type: "string" }, k: { type: "integer" } }, ["query"]),
      run: async (input, extra) => { const hits = await engineOf().search(await chainOf(extra), String(input.query), Math.min(Number(input.k) || 6, 12), { room: await audienceOf(extra) }); return { hits, withheld: /** @type {any} */ (hits).withheld || 0 }; },
    });
    ctx.tool("work.know.answer", {
      description: "Answer a question from the Space's own records and history. Every claim cites a source the caller may read; with none to cite it says so.",
      input: obj({ question: { type: "string" } }, ["question"]),
      callers: WORK_CALLERS,
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        const result = await engineOf().answer(chain, String(input.question), { room: await audienceOf(extra) });
        return { result, component: toComponent("work.know.answer", result) };
      },
    });
    ctx.tool("work.know.suggestions", {
      description: "Facts memory proposes for a record, each with the lines they came from. Nothing is written until a person accepts one.",
      input: obj({ record: { type: "string" } }, ["record"]),
      run: async (input, extra) => ({ suggestions: await engineOf().facts.suggestions(await chainOf(extra), String(input.record)) }),
    });
    ctx.tool("work.know.accept", {
      description: "Accept a proposed fact: it is written onto the record under the person's own chain, with its sources.",
      input: obj({ id: { type: "integer" } }, ["id"]),
      run: async (input, extra) => engineOf().facts.accept(await chainOf(extra), Number(input.id)),
    });

    // The capture port (CUTOVER section G): sessions captures a session's turns ONCE and hands the same lines to Recall and here, so Space memory knows what was said. A first-party
    // module calls it; a person or an agent cannot (it would let them write lines under another session's address). The lines are scrubbed on the way in by the engine.
    ctx.tool("work.know.capture", {
      description: "Keep a session's lines so the Space's memory can answer from what was said. Called by the session capture, once per indexed batch: { session, lines: [{ seq, role, text, at }] }. Lines are scrubbed on the way in and readable only by a chain that may read the session. Returns how many were kept and indexed.",
      input: obj({ session: { type: "string", maxLength: 128 }, lines: { type: "array", items: { type: "object" } }, record: { type: "string" }, project: { type: "string", maxLength: 80 } }, ["session", "lines"]),
      run: async (input, extra) => {
        // KW-4: only first-party code writes lines under a session's address (the registry's flag, never the input's).
        const e = engineOf();
        if (!extra || extra.firstParty !== true) throw fail("denied", "only first-party modules hand over a session's lines");
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(input.session))) throw fail("bad_input", "a session id is letters, digits and . _ : -");
        const lines = (Array.isArray(input.lines) ? input.lines : []).slice(0, 2000).filter((/** @type {any} */ l) => l && Number.isInteger(l.seq) && typeof l.text === "string" && ["user", "assistant", "tool"].includes(String(l.role))).map((/** @type {any} */ l) => ({ seq: l.seq, role: String(l.role), text: l.text.slice(0, 20_000), at: Number(l.at) || 0 }));
        // The record a reader must be allowed to read: the one named, else the project's own record when the caller names a project (a project-wide teammate grant then covers its sessions),
        // else the session's own address.
        const projectRecord = typeof input.project === "string" && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(input.project) ? `vyre://${kernelOf().space}/project/${input.project}` : null;
        const record = input.record && urnOk(input.record) ? input.record : projectRecord;
        const kept = e.lines.ingest(String(input.session), lines, record ? { record } : {});
        const indexed = await e.index({ kind: "lines", session: String(input.session) });
        return { kept, indexed };
      },
    });
    ctx.tool("work.know.forget", {
      description: "Erase a session's lines and every index row made from them (the session was deleted or the person asked). Called by the session capture.",
      input: obj({ session: { type: "string", maxLength: 128 } }, ["session"]),
      run: async (input, extra) => {
        const e = engineOf();
        if (!extra || extra.firstParty !== true) throw fail("denied", "only first-party modules erase a session's lines");
        return { erased: e.forgetSession(String(input.session)) };
      },
    });

    ctx.tool("work.engineer.talk", {
      description: "Talk to the Engineer, which only admins can do: 'explain <type>' reads a definition back in plain words, anything else proposes a change and returns a card and a task. Nothing is applied until an admin approves the card.",
      input: obj({ text: { type: "string" } }, ["text"]),
      run: async (input, extra) => {
        const r = await engineerOf().talk(await chainOf(extra), String(input.text));
        return { ...r, component: toComponent("work.engineer.talk", r.kind === "proposal" ? { kind: "flow_diff", ...r.card } : r) };
      },
    });
    ctx.tool("work.engineer.revise", {
      description: "Edit the Engineer's proposed definition yourself. It is checked again, gets its own card and task, and the earlier approval is void.",
      input: obj({ id: { type: "string" }, source: { type: "string" } }, ["id", "source"]),
      run: async (input, extra) => engineerOf().revise(await chainOf(extra), String(input.id), String(input.source)),
    });
    ctx.tool("work.engineer.approve", {
      description: "Approve or reject the Engineer's change with your own presence proof over the card's hash. Only your own chain is accepted, and the change applies as you.",
      input: obj({ id: { type: "string" }, proof: { type: "object" }, outcome: { enum: ["approved", "rejected"] }, reason: { type: "string" } }, ["id", "proof"]),
      run: async (input, extra) => engineerOf().approve(await chainOf(extra), String(input.id), { proof: input.proof, outcome: input.outcome || "approved", ...(input.reason ? { reason: String(input.reason) } : {}) }),
    });

    return { async stop() { for (const d of doing.values()) { try { d.off && d.off(); } catch {} } doing.clear(); } };
  },
};
