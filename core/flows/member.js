// @ts-check
// A team member's Flows on the team's server (0.3.3 rc.2, the product decision: a teammate sets up and starts Flows). A member reaches the server only through the Space's kernel (kernel/remote), never through a registry
// tool, so her Flows are a SERVICE of that remote server (`services.flows`, wire.js CALLS.flows), the way her chats are (core/work/chat-service.js). Every method is `(chain, input)` with the chain the home's
// own Surfaces door minted from what the transport proved: the person is the chain's one person hop and the role is what the Space's kernel says it is, never anything the request names.
//
// The Flows tools themselves check no role and no owner (they take the person from the chain and trust the door), so THESE rows carry the rules:
//   - a Flow is its author's: a write on an existing Flow (a new version, a patch, a test case, an approval, a proposal, cancelling its run) is refused unless the latest version was made by her, or she is an owner or admin;
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
  const mine = async (/** @type {string} */ id) => { const by = await authorOf(id); return Boolean(by && by.kind === "person" && by.id === me); };
  const active = async (/** @type {string} */ id) => { const r = await rowOf(id); return Boolean(r && r.active); };
  const writeOk = async (/** @type {string} */ id, /** @type {string} */ what) => {
    if (admin) return;
    const by = await authorOf(id);
    if (!by) throw new KernelError("not_found", "there is no such Flow (flows.list shows yours)");
    if (!(await mine(id))) throw no(`${what}: that Flow is someone else's. Ask its author, or an owner or admin, to change it, or make a Flow of your own.`);
  };
  const readOk = async (/** @type {string} */ id) => {
    if (admin || (await mine(id)) || (await active(id))) return;
    throw new KernelError("not_found", "there is no such Flow you can see (flows.list shows yours and the approved ones)");
  };

  switch (spec.kind) {
    case "open": return call();
    case "list": {
      const rows = await tools["flows.list"](chain, i);
      if (admin) return rows;
      const out = [];
      for (const r of rows) if ((await mine(r.id)) || (r.active !== null && r.active !== undefined)) out.push(r);
      return out;
    }
    case "health": {
      if (i.id) { await readOk(need("id", "the Flow's id")); return call(); }
      const rows = await tools["flows.health"](chain, i);
      if (admin || !Array.isArray(rows)) return rows;
      const out = [];
      for (const r of rows) if ((await mine(r.id)) || (await active(r.id))) out.push(r);
      return out;
    }
    case "read": await readOk(need("id", "the Flow's id")); return call();
    case "describe": { if (i.run) { await runOk(String(i.run)); return call(); } await readOk(need("id", "the Flow's id")); return call(); }
    case "define": {
      // A new Flow is hers; a new version of an existing one is its author's (or an admin's)
      if (i.id) await writeOk(String(i.id), "you cannot change it");
      return call();
    }
    case "write": await writeOk(need("id", "the Flow's id"), "you cannot change it"); return call();
    case "simulate": { if (i.id) await readOk(String(i.id)); return call(); }
    case "start": {
      const id = need("id", "the Flow's id");
      await readOk(id);
      // the starter is written into the run (its trigger key), so "the runs I started" is a fact of the run, not of a list somewhere
      return tools["flows.start"](chain, { ...i, key: `mem:${me}:${typeof i.key === "string" && i.key ? i.key.slice(0, 60) : Math.random().toString(36).slice(2, 12)}` });
    }
    case "runs": {
      const rows = await tools["flows.runs"](chain, i);
      if (admin || !Array.isArray(rows)) return rows;
      const out = [];
      // (the listing leaves the trigger out; the run itself says who started it, in its trigger key)
      for (const r of rows) if ((await mine(r.flow)) || startedBy(await store.getRun(r.id), me)) out.push({ ...r, started_by_me: startedBy(await store.getRun(r.id), me) });
      return out;
    }
    case "run": await runOk(need("run", "the run's id")); return call();
    case "attention": {
      const r = await tools["flows.attention"](chain, i);
      return r;
    }
    case "cancelrun": { const run = await runOf(need("run", "the run's id")); if (!admin && !startedBy(run, me) && !(await mine(run.flow))) throw no("you cannot cancel that run: it is not yours"); return call(); }
    case "propose": {
      // asking an owner or admin to approve her own version: the author's request, nothing applies until they say yes
      if (i.what === "flow" || i.id) await writeOk(need("id", "the Flow's id"), "you cannot propose it");
      return call();
    }
    case "approve": return approve();
    default: throw new KernelError("bad_input", "that is not a Flows call a member can make");
  }

  /** @param {any} r */ function startedBy(r, /** @type {string} */ person) { return Boolean(r && r.trigger && typeof r.trigger.key === "string" && r.trigger.key.startsWith(`mem:${person}:`)); }
  async function runOf(/** @type {string} */ run) { const r = store.getRun ? await store.getRun(run) : null; if (!r) throw new KernelError("not_found", "there is no such run (flows.runs lists yours)"); return r; }
  async function runOk(/** @type {string} */ run) { if (admin) return; const r = await runOf(run); if (!startedBy(r, me) && !(await mine(r.flow))) throw new KernelError("not_found", "there is no such run you can see (flows.runs lists yours)"); }

  /** Approving: her own version only, and inside the bound (MEMBER_APPROVAL) unless she is an owner or admin. */
  async function approve() {
    const id = need("id", "the Flow's id");
    if (admin) return call();
    const version = Number(i.version);
    const row = await rowOf(id);
    const made = row && row.versions ? row.versions.find((/** @type {any} */ x) => x.version === version) : null;
    const v = made ? await store.getVersion(id, version) : null;
    if (!v) throw new KernelError("not_found", "there is no such Flow version");
    if (!(made.by && made.by.kind === "person" && made.by.id === me)) throw no("you can approve only a version you made yourself; ask an owner or admin to approve this one");
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
  if ((Array.isArray(e.model_steps) && e.model_steps.length) || (Array.isArray(e.code) && e.code.length)) lines.push("Its AI steps run on this Space's AI allowance (200,000 tokens a day for all Flows together, shared with the owner's; an owner or admin can change it), not on your own sign-in.");
  if (Array.isArray(e.outward) && e.outward.length) lines.push("Anything it sends or changes outside asks you first, every time.");
  return lines.join(" ");
}
