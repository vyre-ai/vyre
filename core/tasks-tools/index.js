// @ts-check
// tasks: the app's task calls over the kernel's task store (kernel/tasks), one tool each, under the caller's own chain in the Space it names (lib/gateway-door.js). The kernel's transition table
// and gates decide every answer; `tasks.move` only picks which kernel act a target state is (start, stuck, skip, unblock), so the screen never chooses one. Approving or rejecting
// (`tasks.decide`) is a person's act with their presence proof, which rides beside the request (the kernel proof header), never in the body.
import { createDoor } from "../../lib/gateway-door.js";
import { cloudGate, spaceZone } from "../../lib/cloud-gate.js";
import { personZone, showTimes } from "../../lib/time/index.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device"];
const STATES = ["waiting", "ready", "working", "needs_check", "stuck", "done", "skipped"];

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const door = createDoor(ctx);
    /** @typedef {{ space: string, gateway: any, chain: any, proof: any }} Opened */
    /** @param {string} name @param {string} description @param {any} input @param {(i: any, d: Opened) => Promise<any>} fn */
    /** The task calls a team MEMBER's app makes on the team's server, by tool name (the member door's rows, core/work/member-tools.js). @type {Map<string, (i: any, d: Opened) => Promise<any>>} */
    const ops = new Map();
    const tool = (name, description, input, fn) => ops.set(name, fn) && ctx.tool(name, { description, input, callers: CALLERS, run: async (/** @type {any} */ i, /** @type {any} */ meta) => { const d = await door.open(i || {}, meta); const gate = await cloudGate(ctx, d.space); if (gate) throw gate; return withDue(await fn(i || {}, d), d.space, meta); } });
    /** A task due in a space with its own zone shows both clocks: `due_shown`, "9:00 am PT · 9:00 pm your time" (the reader's zone is the device's). A space with no zone, or the reader in it, adds nothing. @param {any} out @param {string} space @param {any} meta */
    const withDue = async (out, space, meta) => {
      if (!out || typeof out !== "object" || !(out.task || Array.isArray(out.tasks))) return out;
      const zone = await spaceZone(ctx, space);
      if (!zone) return out;
      const person = personZone(meta);
      const one = (/** @type {any} */ t) => (t && typeof t.due === "number" ? { ...t, due_shown: showTimes(t.due, { person, space: zone }).text, due_zone: zone } : t);
      return out.task ? { ...out, task: one(out.task) } : { ...out, tasks: out.tasks.map(one) };
    };
    const asks = (/** @type {Opened} */ d) => { if (!d.gateway.ask) throw refuse("this Space keeps no tasks; use another Space (spaces.list shows yours)", "unavailable"); return d.gateway.ask; };
    /** A task's actor from an id: a person by their per_ id, else an assistant or teammate by name. @param {string} id @param {string} space */
    const actor = (id, space) => ({ kind: /^per_/.test(id) ? "person" : "agent", id, space });

    tool("tasks.list", "Tasks, oldest first: by record, doer, checker or state. Only what the caller may read.", obj({ space: str, record: str, doer: str, checker: str, state: { type: "array", items: { type: "string", enum: STATES } } }), async (i, d) => ({
      tasks: await asks(d).list(d.chain, { ...(i.record ? { record: String(i.record) } : {}), ...(i.doer ? { doer: String(i.doer) } : {}), ...(i.checker ? { checker: String(i.checker) } : {}), ...(Array.isArray(i.state) ? { state: i.state.map(String) } : {}) }),
    }));
    tool("tasks.get", "One task, or null when it is not there or not the caller's to read.", obj({ space: str, id: str }, ["id"]), async (i, d) => ({ task: await asks(d).get(d.chain, String(i.id)) }));
    tool("tasks.request", "Ask for a task: a title, its output, a doer and, when it needs one, a checker. The kernel writes its id, state and who asked.", obj({ space: str, task: { type: "object" } }, ["task"]), async (i, d) => {
      const t = i.task || {};
      const { doer, checker, helpers, ...rest } = t;
      if (typeof doer !== "string" || !doer) throw refuse("a task needs a doer", "bad_input");
      const spec = { ...rest, doer: actor(doer, d.space), ...(typeof checker === "string" && checker ? { checker: actor(checker, d.space) } : {}), ...(Array.isArray(helpers) ? { helpers: helpers.map((/** @type {any} */ h) => actor(String(h), d.space)) } : {}) };
      return { task: await asks(d).request(d.chain, spec) };
    });
    tool("tasks.decide", "Approve or reject a task waiting for a check. The person's own act, with their presence.", obj({ space: str, id: str, outcome: { type: "string", enum: ["approved", "rejected"] }, reason: str }, ["id", "outcome"]), async (i, d) => ({
      task: await asks(d).decide(d.chain, String(i.id), { outcome: i.outcome, ...(i.reason ? { reason: String(i.reason) } : {}), ...(d.proof ? { proof: d.proof } : {}) }),
    }));
    tool("tasks.move", "Move a task: start it, flag it stuck (with a reason), skip it, or fix a stuck one. Which kernel act that is, and whether the caller may, is the kernel's.", obj({ space: str, id: str, to: { type: "string", enum: ["working", "stuck", "skipped", "ready"] }, reason: str, suggested_fix: str }, ["id", "to"]), async (i, d) => {
      const a = asks(d), id = String(i.id);
      if (i.to === "working") return { task: await a.start(d.chain, id) };
      if (i.to === "stuck") return { task: await a.stuck(d.chain, id, { reason: String(i.reason || ""), ...(i.suggested_fix ? { suggested_fix: String(i.suggested_fix) } : {}) }) };
      if (i.to === "skipped") return { task: await a.skip(d.chain, id, String(i.reason || "")) };
      if (i.to === "ready") return { task: await a.unblock(d.chain, id, { ...(d.proof ? { proof: d.proof } : {}) }) };
      throw refuse("a task moves to working, stuck, skipped or ready", "bad_input");
    });
    /** The Deck's evidence ({ note: { text, sources } }) in the kernel's own shape ({ note: text, sources }); anything already in the kernel's shape passes as it is. @param {any} e */
    // The app hands a note as { note: { text, sources } } and a decision as { decision: { answer, reason } }; the kernel's checks read them flat.
    const evidence = e => {
      let out = e;
      if (out && typeof out === "object" && out.note && typeof out.note === "object") out = { ...out, note: String(out.note.text || ""), sources: Array.isArray(out.note.sources) ? out.note.sources : [] };
      if (out && typeof out === "object" && out.decision && typeof out.decision === "object") { const { decision, ...rest } = out; out = { ...rest, answer: decision.answer, reason: decision.reason }; }
      return out;
    };
    tool("tasks.submit", "The doer hands in what it made. The kernel checks the output and moves the task on (to needs_check or done).", obj({ space: str, id: str, evidence: { type: "object" } }, ["id", "evidence"]), async (i, d) => ({ task: await asks(d).complete(d.chain, String(i.id), evidence(i.evidence)) }));
    // ---- the member door: a team member's daily work on tasks, run as her, in the team's Space ----
    // `decide` is not here: approving is the person's own act with their presence, which the door does not carry.
    const MEMBER_KEYS = /** @type {Record<string, string[]>} */ ({
      list: ["record", "doer", "checker", "state", "limit"], get: ["id"], request: ["task"], move: ["id", "to", "reason", "suggested_fix"], submit: ["id", "evidence"],
    });
    const serve = (/** @type {string[]} */ calls) => async (/** @type {any} */ i, /** @type {any} */ extra) => {
      if (!extra || !extra.in_space_chain || !extra.in_space) throw refuse("only the team server's member door runs this", "denied");
      if (!i || !calls.includes(i.call)) throw refuse(`call is one of ${calls.join(", ")}`, "bad_input");
      const fn = ops.get(`tasks.${i.call}`);
      if (!fn) throw refuse("no such call; use one of the calls this tool names in its input", "not_found");
      const src = i.input && typeof i.input === "object" && !Array.isArray(i.input) ? i.input : {};
      const clean = Object.fromEntries(Object.entries(src).filter(([k]) => MEMBER_KEYS[i.call].includes(k)));
      const d = await door.open({}, extra);
      const gate = await cloudGate(ctx, d.space); if (gate) throw gate;
      return withDue(await fn(clean, d), d.space, extra);
    };
    const serveInput = (/** @type {string[]} */ calls) => obj({ call: { type: "string", enum: calls }, input: { type: "object" } }, ["call"]);
    ctx.tool("tasks.serve", { effect: "read", internal: true, callers: ["module"], description: "A team member's reads of the team's tasks (list, get), as that member, in that Space. Only the daemon's member door runs it.", input: serveInput(["list", "get"]), run: serve(["list", "get"]) });
    ctx.tool("tasks.serve-work", { effect: "write", internal: true, callers: ["module"], description: "A team member works a task of hers (start it, flag it stuck, hand it in), as that member, in that Space. Only the daemon's member door runs it.", input: serveInput(["move", "submit"]), run: serve(["move", "submit"]) });
    ctx.tool("tasks.serve-request", { effect: "write", internal: true, callers: ["module"], description: "A team member asks for a task, as that member, in that Space. Only the daemon's member door runs it.", input: serveInput(["request"]), run: serve(["request"]) });
    return { async stop() {} };
  },
};
