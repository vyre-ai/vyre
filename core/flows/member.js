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
 * How far a member's own approval goes (the one constant the product decision changes):
 *   "own-manual": her own version, manual trigger only, effects inside her role, no outward step, no AI step, no code step;
 *   "own-any":    her own version with any trigger and with AI steps, running with HER authority only; outward steps keep the one-yes floor and ask her.
 * @type {"own-manual" | "own-any"}
 */
export const MEMBER_APPROVAL = "own-manual";

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
  cancel: { tool: "flows.cancel", kind: "cancelrun" },
  approve: { tool: "flows.approve", kind: "approve" }, propose: { tool: "flows.propose", kind: "propose" },
}));

const CODES = /** @type {Record<string, string>} */ ({ denied: "not_allowed", not_found: "not_found", bad_input: "bad_input", invalid: "bad_input", not_active: "not_found" });
const no = (/** @type {string} */ message) => new KernelError("not_allowed", message);

/**
 * @param {{ space: string, kernel: any, host: any }} o `host` is the daemon's Flows host (ctx.flowsHost): `host.get(space)` is the Space's Flows assembly
 */
export function createFlowsService(o) {
  const who = (/** @type {any} */ chain) => {
    const h = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (chain?.space !== o.space || chain.viewer === true || chain.delegated === true || h.length !== 1 || !h[0].actor || h[0].actor.kind !== "person") throw new KernelError("not_found", "not found");
    return String(h[0].actor.id);
  };
  const roleOf = (/** @type {string} */ person) => {
    try { const r = o.kernel?.gateway?.members?.roleOf({ kind: "person", id: person, space: o.space }); return typeof r === "string" ? r : ""; } catch { return ""; }
  };
  const serve = (/** @type {string} */ name) => async (/** @type {any} */ chain, /** @type {any} */ input) => {
    const me = who(chain), role = roleOf(me);
    if (!role) throw new KernelError("not_found", "not found");   // not a member: nothing to say
    const f = o.host && o.host.get(o.space);
    if (!f) throw new KernelError("unavailable", "Flows are not running on this server yet");
    const i = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    delete i.space; delete i.as;
    try { return await serveMember(f, name, i, chain, me, role, o.kernel); }
    catch (e) {
      if (e instanceof KernelError) throw e;
      const err = /** @type {any} */ (e);
      throw new KernelError(/** @type {any} */ (CODES[err && err.code] || "bad_input"), String(err && err.message || "that did not work"));
    }
  };
  return Object.fromEntries(Object.keys(CALLS).map(c => [c, serve(c)]));
}

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
    return call();
  }
}

/**
 * Why a version is beyond a member's own approval, or "" when it is inside. Looks at the compiled card (effects and caps) and the trigger.
 * @param {any} f @param {string} id @param {number} version @param {any} v the stored version row @param {any} chain @param {any} [kernel]
 */
async function beyondBound(f, id, version, v, chain, kernel) {
  if (MEMBER_APPROVAL === "own-any") return "";
  const flow = v.flow || {};
  const trigger = flow.trigger && flow.trigger.kind ? String(flow.trigger.kind) : flow.trigger ? String(flow.trigger) : "manual";
  if (trigger !== "manual") return `it starts by itself (${trigger}), and an unattended Flow is an owner's or admin's to approve`;
  const card = await f.flows.tools["flows.card"](chain, { id, version });
  const e = card && card.effects ? card.effects : {};
  if (Array.isArray(e.outward) && e.outward.length) return "it sends or changes something outside";
  if (Array.isArray(e.model_steps) && e.model_steps.length) return "it uses an AI step";
  if (Array.isArray(e.code) && e.code.length) return "it runs code";
  if (Array.isArray(e.services) && e.services.some((/** @type {any} */ s) => s.outward)) return "it acts on a Connection";
  // every action it declares must be one the kernel would allow HER today (inside her own role)
  if (kernel && kernel.gateway && typeof kernel.gateway.authorizePeek === "function" && Array.isArray(card.caps)) {
    for (const c of card.caps) {
      if (!c || !c.action || c.action === "*.*") return "it asks for more than your role allows";
      let d; try { d = await kernel.gateway.authorizePeek({ chain, action: c.action, resource: c.resource || `vyre://${f.space || ""}/*` }); } catch { d = null; }
      if (d && d.effect !== "allow") return `it needs ${c.action}, which your role does not allow`;
    }
  }
  return "";
}
