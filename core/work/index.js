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
      const room = await k.audienceFor(extra || {});
      if (!room || typeof room.group !== "boolean") throw unknown("the room this runs in is not known, so nothing is built for it");
      if (!room.group) return null;
      if (!(room.size >= 2) || typeof room.read !== "function" || typeof room.canRead !== "function") throw unknown("this is a group chat and its audience is not known, so nothing is built for it");
      return room;
    };
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

    ctx.tool("work.tools", {
      description: "The tools this caller may use in this Space, generated from its record definitions and the action registry and cut by what the caller may do. A tool the caller cannot use is not listed.",
      input: obj(),
      run: async (_input, extra) => ({ tools: await surfaceOf().list(await chainOf(extra)) }),
    });
    ctx.tool("work.call", {
      description: "Run one of the listed tools. Returns { result, component }: the component is what to show, a record card, a task card, a draft or a held-for-approval card. An outward act (send, pay, publish, share) is never run: it returns held with a task, and a person approves it.",
      input: obj({ tool: { type: "string" }, input: { type: "object" } }, ["tool"]),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        const result = await surfaceOf().call(chain, String(input.tool), input.input || {});
        const types = {};
        for (const t of kernelOf().definitions ? await kernelOf().definitions(chain) : []) /** @type {any} */ (types)[t.name] = t;
        const normal = result && result.held ? { held: true, task: result.held.task, summary: result.held.summary, approver: result.held.approver } : result;
        return { result, component: toComponent(String(input.tool), normal, { types }) };
      },
    });
    ctx.tool("work.situation", {
      description: "Where the caller is, in a few hundred tokens: the Space, their role, the project or record in scope, the team, open tasks, what waits on them, and what is sealed and why.",
      input: obj({ project: { type: "string" }, record: { type: "string" } }),
      run: async (input, extra) => {
        const k = kernelOf();
        const ref = (/** @type {any} */ u) => { if (!urnOk(u)) return undefined; const [, , , type, id] = u.split("/"); return { type, id }; };
        const project = ref(input.project), record = ref(input.record);
        const lines = Object.fromEntries([...doing.values()].flatMap(d => [...(d.lines || [])]));
        return buildSituation(k, await chainOf(extra), { space: k.space, ...(project ? { project } : {}), ...(record ? { record } : {}), doing: lines, room: await audienceOf(extra) });
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
        const made = await delegateGrants(k, chain, { adder, teammate, wanted: spec.wanted });
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
