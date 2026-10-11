// @ts-check
// A team member's Flows on the team's server (0.3.3 rc.2, the product decision: a teammate sets up and starts Flows). A member reaches the server only through the Space's kernel (kernel/remote), never through a registry
// tool, so her Flows are a SERVICE of that remote server (`services.flows`, wire.js CALLS.flows), the way her chats are (core/work/chat-service.js). Every method is `(chain, input)` with the chain the home's
// own Surfaces door minted from what the transport proved: the person is the chain's one person hop and the role is what the Space's kernel says it is, never anything the request names.
//
// The Flows tools themselves check no role and no owner (they take the person from the chain and trust the door), so THESE rows carry the rules:
//   - a Flow belongs to the SPACE: every member sees every Flow and its runs; any member writes a new version of any Flow as a DRAFT; which version runs, and on whose authority, is decided only at approval: a write on an existing Flow (a new version, a patch, a test case, an approval, a proposal, cancelling its run) is refused unless the latest version was made by her, or she is an owner or admin;
//   - she reads her own Flows and the approved ones; she lists those; she starts any Flow she may run (the kernel's `flows.run`, which the member role holds); a run she starts is tagged with her (trigger key);
//   - she sees runs she started and runs of Flows she made; an owner or admin sees all;
//   - refused for a member: pausing or resuming the Space's Flows, rolling back, the AI budget, Kits;
//   - approving: she may approve a version she made herself, and only inside the bound below (MEMBER_APPROVAL); everything else waits for an owner or admin through `propose`.
// What a Flow of hers RUNS AS is not decided here: the runner gives a run the chain [automation, approver], so a Flow she approved acts with at most her own role.

import { KernelError } from "../../kernel/core/errors.js";

/**
 * How far a member's own approval goes. The product decision is "own-any": her own version, any trigger, AI steps allowed, running with HER authority only (the runner gives a run the chain [automation, approver]);
 * outward steps keep the one-yes floor and the ask goes to her; a Connection step, or an action her role does not hold, is not hers to approve (it stays a draft for an owner or admin, said at approve time).
 * "own-manual" is the narrower bound (manual trigger, no outward, AI or code step), kept as the one constant a later role setting can turn.
 * @type {"own-manual" | "own-any"}
 */
/** Drafts one member may have waiting on one Flow. */
const MAX_DRAFTS = 20;
export const MEMBER_APPROVAL = "own-any";

/** Each call of the wire's `flows` group and the Flows tool that serves it. kind: open (no Flow), read (a Flow's definition), write (a Flow's author), start, runs, run (one run), approve, propose. */
export const CALLS = Object.freeze(/** @type {Record<string, { tool: string, kind: string }>} */ ({
  cheatsheet: { tool: "flows.cheatsheet", kind: "open" }, "compile-text": { tool: "flows.compile-text", kind: "open" },
  list: { tool: "flows.list", kind: "list" }, health: { tool: "flows.health", kind: "health" },
  get: { tool: "flows.get", kind: "read" }, card: { tool: "flows.card", kind: "read" }, code: { tool: "flows.code", kind: "read" }, graph: { tool: "flows.graph", kind: "read" },
  diff: { tool: "flows.diff", kind: "read" }, describe: { tool: "flows.describe", kind: "describe" },
  define: { tool: "flows.define", kind: "define" }, patch: { tool: "flows.patch", kind: "write" }, "from-chat": { tool: "flows.from-chat", kind: "open" },
  "test-save": { tool: "flows.test.save", kind: "write" }, "test-remove": { tool: "flows.test.remove", kind: "write" }, "test-list": { tool: "flows.test.list", kind: "read" }, "test-run": { tool: "flows.test.run", kind: "read" },
  simulate: { tool: "flows.simulate", kind: "simulate" },
  start: { tool: "flows.start", kind: "start" },
  runs: { tool: "flows.runs", kind: "runs" }, run: { tool: "flows.run", kind: "run" }, timeline: { tool: "flows.timeline", kind: "run" }, attention: { tool: "flows.attention", kind: "attention" },
  cancel: { tool: "flows.cancel", kind: "cancelrun" }, retry: { tool: "flows.retry", kind: "cancelrun" },
  approve: { tool: "flows.approve", kind: "approve" }, propose: { tool: "flows.propose", kind: "propose" },
}));

const no = (/** @type {string} */ message) => new KernelError("not_allowed", message);

/**
 * One member call, with the rules. `f` is the Space's Flows host entry (f.flows.tools, f.flows.store).
 * @param {any} f @param {string} name @param {any} i @param {any} chain @param {string} me @param {string} role @param {any} [kernel]
 */
export async function serveMember(f, name, i, chain, me, role, kernel) {
  const spec = CALLS[name];
  if (!spec) throw new KernelError("bad_input", "that is not a Flows call a member can make");
  const tools = f.flows.tools, store = f.flows.store;
  const admin = role === "owner" || role === "admin";
  const call = (/** @type {any} */ input = i) => tools[spec.tool](chain, input);
  const need = (/** @type {string} */ k, /** @type {string} */ what) => { if (typeof i[k] !== "string" || !i[k]) throw new KernelError("bad_input", `${what} is needed`); return String(i[k]); };
  const rowOf = async (/** @type {string} */ id) => (store.flowRow ? await store.flowRow(id) : null);
  /** The actor that made the latest version of a Flow, or null (no such Flow). */
  const authorOf = async (/** @type {string} */ id) => { const r = await rowOf(id); const v = r && r.versions && r.versions[r.versions.length - 1]; return v ? v.by : null; };
  /** Whose authority the Flow runs on: the approver of its active version; before any approval, the person who made its first version. Null: no such Flow. */
  const setterUp = async (/** @type {string} */ id) => {
    const act = await store.active(id).catch(() => null);
    if (act && act.approver && act.approver.kind === "person") return String(act.approver.id);
    const r = await rowOf(id); const v1 = r && r.versions && r.versions[0];
    return v1 && v1.by && v1.by.kind === "person" ? String(v1.by.id) : null;
  };
  const exists = async (/** @type {string} */ id) => Boolean(await rowOf(id));
  /** Reading a Flow, its runs and its health is every member's: Flows belong to the Space. */
  const there = async (/** @type {string} */ id) => { if (!(await exists(id))) throw new KernelError("not_found", "there is no such Flow (flows.list shows the Space's)"); };

  switch (spec.kind) {
    case "open": return call();
    case "list": case "runs": return mark(await tools[spec.tool](chain, i));
    // The Flow runs that need a look. The stuck tasks of the whole Space are not Flows matters, so a member is shown none of them.
    case "attention": { const a = await tools[spec.tool](chain, i); return { runs: a && Array.isArray(a.runs) ? a.runs : [] }; }
    case "health": if (i.id) await there(need("id", "the Flow's id")); return call();
    case "read": {
      await there(need("id", "the Flow's id"));
      const out = await call();
      // The app chooses Approve or Send for approval from these, so it never infers them: who the Flow RUNS AS (runs_as) and who made the version shown (by).
      if (spec.tool !== "flows.get" && spec.tool !== "flows.card") return out;
      const r = await rowOf(String(i.id)); const v = r && r.versions.find((/** @type {any} */ x) => x.version === out.version);
      return { ...out, runs_as: await setterUp(String(i.id)), by: v && v.by && v.by.kind === "person" ? String(v.by.id) : null };
    }
    case "describe": if (i.run) return call(await hiding(await runOf(String(i.run)))); await there(need("id", "the Flow's id")); return call();
    // Setting up and improving: any member writes a new version, a patch or a test of any Flow of the Space as a DRAFT. Which version runs, and on whose authority, is decided only at approval (below).
    case "define": case "write": case "simulate": {
      // Drafts she has made of one Flow and nobody has approved are capped, so one member cannot fill the Flow with versions (the vault caps pending requests the same way).
      if (typeof i.id === "string" && i.id && spec.kind !== "simulate") {
        const r = await rowOf(i.id);
        const mine = r ? r.versions.filter((/** @type {any} */ v) => v.by && v.by.kind === "person" && String(v.by.id) === me && (r.active === null || v.version > r.active)).length : 0;
        if (mine >= MAX_DRAFTS) throw new KernelError("too_many", `you already have ${MAX_DRAFTS} drafts of this Flow waiting. Ask the person it runs for to look at them (flows.propose), then try again.`);
      }
      return call();
    }
    case "start": {
      const id = need("id", "the Flow's id");
      await there(id);
      // the starter is written into the run (its trigger key), so "the runs I started" is a fact of the run, not of a list somewhere
      return tools["flows.start"](chain, { ...i, key: `mem:${me}:${typeof i.key === "string" && i.key ? i.key.slice(0, 60) : Math.random().toString(36).slice(2, 12)}` });
    }
    case "run": return call(await hiding(await runOf(need("run", "the run's id"))));
    case "cancelrun": { const run = await runOf(need("run", "the run's id")); if (!admin && !startedBy(run, me) && (await setterUp(run.flow)) !== me) throw no("you cannot stop that run: it is not yours. Ask whoever set the Flow up, or an owner or admin."); return call(); }
    case "propose": return proposeVersion();
    case "approve": return approve();
    default: throw new KernelError("bad_input", "that is not a Flows call a member can make");
  }

  /** A run is shown whole to its owner, an admin and the person whose authority it ran on; to anyone else its steps' data is hidden (kernel/flows/redact.js), because a run reads what its approver may read. Started by her is not enough. @param {any} run */
  async function hiding(run) {
    const as = run.approver && run.approver.kind === "person" ? String(run.approver.id) : null;
    if (admin || as === me) return i;
    return { ...i, hide_for: as || "the person who approved it" };
  }
  /** Rows of runs she started carry a flag the app can show. @param {any} rows */
  async function mark(rows) {
    if (!Array.isArray(rows) || spec.kind !== "runs") return rows;
    // (the listing leaves the trigger out; the run itself says who started it, in its trigger key)
    return Promise.all(rows.map(async (/** @type {any} */ r) => ({ ...r, started_by_me: startedBy(await store.getRun(r.id), me) })));
  }
  /** @param {any} r */ function startedBy(r, /** @type {string} */ person) { return Boolean(r && r.trigger && typeof r.trigger.key === "string" && r.trigger.key.startsWith(`mem:${person}:`)); }
  async function runOf(/** @type {string} */ run) { const r = store.getRun ? await store.getRun(run) : null; if (!r) throw new KernelError("not_found", "there is no such run (flows.runs lists yours)"); return r; }

  /** A version of the Space's Flow that someone else set up: a card goes to the person it runs for (or an owner when they are gone), who approves it in Flows with their own yes. Nothing applies by this call. */
  async function proposeVersion() {
    const id = need("id", "the Flow's id"), version = Number(i.version);
    const row = await rowOf(id);
    const made = row && row.versions ? row.versions.find((/** @type {any} */ x) => x.version === version) : null;
    const v = made ? await store.getVersion(id, version) : null;
    if (!v) throw new KernelError("not_found", "there is no such Flow version (define it first)");
    if (v.approver) throw new KernelError("bad_input", "that version is already approved");
    let to = await setterUp(id);
    if (!to || to === me || !f.roleOf || !f.roleOf(to)) to = null;
    if (!to) { const owners = typeof f.holders === "function" ? await f.holders("owner") : []; to = owners[0] && owners[0].id ? String(owners[0].id) : null; }
    if (!to || to === me) throw new KernelError("bad_input", "nobody else can approve this: it is your own Flow, approve it yourself (approve)");
    const name = String((v.flow && (v.flow.label || v.flow.name)) || id).slice(0, 100);
    const task = await f.notify(to, `A new version of the Flow "${name}" is waiting for your yes`, { kind: "flow_change", flow: id, version, hash: v.hash, by: me, note: typeof i.note === "string" ? i.note.slice(0, 300) : "" }, `member-flow:${id}:${version}:${v.hash}`);
    return { ok: true, asked: to, task: task && task.id, note: "They are asked. A new version runs only when they approve it in Flows." };
  }

  /** Approving: a Flow runs on the authority of whoever approved it, so a member approves only a version of a Flow SHE set up (or one nobody has), within the bound; another member's version of it is a proposal for the
   * person it runs for, or an owner or admin. Nobody can swap the code under someone else's authority with her own yes. */
  async function approve() {
    const id = need("id", "the Flow's id");
    if (admin) return call();
    const version = Number(i.version);
    const row = await rowOf(id);
    const made = row && row.versions ? row.versions.find((/** @type {any} */ x) => x.version === version) : null;
    const v = made ? await store.getVersion(id, version) : null;
    if (!v) throw new KernelError("not_found", "there is no such Flow version");
    const owner = await setterUp(id);
    if (owner !== me) throw no("this Flow runs on someone else's authority, so only they (or an owner or admin) can approve a new version of it. Propose it (propose) and they are asked.");
    const why = await beyondBound(f, id, version, v, chain, kernel);
    if (why) throw no(`this version is beyond what you can approve yourself (${why}). It stays a draft: ask an owner or admin to approve it (propose).`);
    const out = await call();
    return out && typeof out === "object" ? { ...out, notice: approvalNotice(await f.flows.tools["flows.card"](chain, { id, version }), v.flow) } : out;
  }
}

/**
 * Why a version is beyond a member's own approval, or "" when it is inside. Looks at the compiled card (effects and caps) and the trigger.
 * @param {any} f @param {string} id @param {number} version @param {any} v the stored version row @param {any} chain @param {any} [kernel]
 */
async function beyondBound(f, id, version, v, chain, kernel) {
  const flow = v.flow || {};
  const card = await f.flows.tools["flows.card"](chain, { id, version });
  const e = card && card.effects ? card.effects : {};
  // A Connection step: the Space's credential is in the Vault, which is the owner's; the vault gate refuses a member's chain unless an item was granted to her. Said now, not at 3 a.m.
  if (Array.isArray(e.services) && e.services.length) return "it calls a Connection, and Connections are the Vault's and the owner's for now";
  if (MEMBER_APPROVAL === "own-manual") {
    const trigger = flow.trigger && typeof flow.trigger === "object" ? String(flow.trigger.on || flow.trigger.kind || "manual") : flow.trigger ? String(flow.trigger) : "manual";
    if (trigger !== "manual") return `it starts by itself (${trigger}), and an unattended Flow is an owner's or admin's to approve`;
    if (Array.isArray(e.outward) && e.outward.length) return "it sends or changes something outside";
    if (Array.isArray(e.model_steps) && e.model_steps.length) return "it uses an AI step";
    if (Array.isArray(e.code) && e.code.length) return "it runs code";
  }
  // every action it declares must be one the kernel would allow HER today (inside her own role)
  if (kernel && kernel.gateway && typeof kernel.gateway.authorizePeek === "function" && Array.isArray(card.caps)) {
    for (const c of card.caps) {
      if (!c || !c.action || c.action === "*.*") return "it asks for more than your role allows";
      if (c.action === "model.call" || c.action === "fn.run") continue;   // a run's alone: it needs only flows.run of the approver (kernel/core/authorize.js RUNNER_ONLY), which her role holds
      let d; try { d = await kernel.gateway.authorizePeek({ chain, action: c.action, resource: c.resource || `vyre://${f.space || ""}/*` }); } catch { d = null; }
      if (d && d.effect !== "allow") return `it needs ${c.action}, which your role does not allow`;
    }
  }
  return "";
}

/** What the member is told when she approves her own version: in words, once, what it will do and on whose allowance. @param {any} card @param {any} flow */
export function approvalNotice(card, flow) {
  const e = card && card.effects ? card.effects : {};
  const lines = ["It runs as you, with your role only: never with the owner's authority."];
  const trigger = flow && flow.trigger && typeof flow.trigger === "object" ? String(flow.trigger.on || flow.trigger.kind || "manual") : "manual";
  if (trigger !== "manual") lines.push("It starts by itself. If you leave the team it pauses and the owner is told.");
  if ((Array.isArray(e.model_steps) && e.model_steps.length) || (Array.isArray(e.code) && e.code.length)) lines.push("Its AI steps use the Space's AI credentials and count against the Space's daily allowance (200,000 tokens a day for all Flows together; an owner or admin can change it).");
  if (Array.isArray(e.outward) && e.outward.length) lines.push("Anything it sends or changes outside asks you first, every time.");
  return lines.join(" ");
}
