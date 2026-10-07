// @ts-check
// One Space's records host: the kernel's gateway over a store (the Space's Twenty), the event log, the chain builder,
// the Flow runner and the Kit manager, wired together. The platform's own assembly calls the same pieces; this file is
// what the records team's tests and the testbox runs use to prove a Kit's types and Flows go through `kernel.records.*`
// with authorize and events, and that the runner runs the Kit's Flows.
//
//   const host = createRecordsHost({ space, owner, store, key });
//   await host.installKit(kit, { approve: true });      // types, templates, roles, Flows (the install card, approved by the owner)
//   await host.emit("payment.received", payload, { key })  // an event the Flows hear
//   host.kernel.records.create(host.ownerChain(), "contact", { ... })

import { createGateway } from "../kernel/gateway/index.js";
import { createEventLog } from "../kernel/core/events.js";
import { createChainBuilder } from "../kernel/core/chain.js";
import { createFlows } from "../kernel/flows/index.js";
import { CORE_TYPES } from "./core-types.js";
import { toKernelKit } from "./kit-adapter.js";
import { parseExpr, evalExpr } from "./language/expr.js";

const RECORD_GRANT_ACTIONS = ["records.*", "records.define", "events.read"];

/**
 * @param {{ space: string, owner: string, ownerUid?: number, store: any, key?: Buffer, clock?: () => number, tickMs?: number,
 *   extraActions?: Record<string, any>, ports?: any, sealer?: any }} o
 */
export function createRecordsHost(o) {
  const clock = o.clock ?? Date.now;
  const space = o.space;
  const ownerUid = o.ownerUid ?? 501;
  const chains = createChainBuilder({ space, owner: o.owner, owner_uid: ownerUid, key: o.key ?? Buffer.alloc(32, 7), clock });
  const log = createEventLog({ space, clock });

  const person = { kind: "person", id: o.owner, space };
  const grantFor = (/** @type {string} */ id, /** @type {any} */ subject, /** @type {string[]} */ actions) => ({
    id, space, subject: { kind: "actor", actor: subject }, actions, action_set_version: 9,
    resource: { prefix: `vyre://${space}/*/*` }, conditions: {}, issuer: person, source: "records-host", status: "active", created_at: 0,
  });
  // The owner holds the record actions; so does the Flows service, which only ever acts with the approver beside it (a chain narrows).
  const grants = [grantFor("gr_owner0000001", person, o.sealer ? [...RECORD_GRANT_ACTIONS, "seal.put"] : RECORD_GRANT_ACTIONS), grantFor("gr_flows0000001", { kind: "service", id: "flows", space }, RECORD_GRANT_ACTIONS), grantFor("gr_hook00000001", { kind: "service", id: "connector", space }, RECORD_GRANT_ACTIONS)];
  const byId = new Map(grants.map((g) => [g.id, g]));
  const kernel = createGateway({
    owner: o.owner, space, store: o.store, log, chains, clock,
    grants: { forSubject: (/** @type {any} */ a) => grants.filter((g) => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: (/** @type {string} */ id) => byId.get(id) },
    members: { has: (/** @type {any} */ a) => (a.kind === "person" && a.id === o.owner) || (a.kind === "service" && (a.id === "flows" || a.id.startsWith("connector"))) },
    hasPresenceSession: () => true,
    ...(o.sealer ? { sealer: o.sealer } : {}),
    // the type rules (defineRule) are written in the records language's Expression language
    expr: { parseExpr, evalExpr },
  });

  const ownerChain = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: ownerUid, pid: 1, inside_model_process: false, capsule_verified: true });
  /** The chain a Flow or a Kit's work runs under: the approver, then the service. */
  const forFlow = (/** @type {any} */ x) => {
    const base = ownerChain();
    const c = chains.appendService(base, "flows", true);
    return x.tainted ? chains.weaken(c, { trust: "external", red: "public", source_spaces: x.source_spaces ?? [space] }) : c;
  };

  /** @type {Map<string, any>} types the Space knows, for the Flows catalog */
  const types = new Map();
  const catalog = () => ({
    space,
    types: Object.fromEntries(types),
    actions: { "records.read": { risk: "read" }, "records.create": { risk: "write" }, "records.update": { risk: "write" }, "records.remove": { risk: "write" }, ...(o.extraActions ?? {}) },
    roles: ["owner", "admin", "manager", "member", "attorney"],
    teammates: [], templates: [],
  });
  const flows = createFlows({ kernel, chains: { forFlow }, catalog, clock, ports: o.ports ?? {} });
  // the kernel's own event stream feeds the runner, as the platform's assembly does
  log.subscribe("flows:runner", {}, (/** @type {any} */ e) => flows.onEvent(e));

  async function defineTypes(/** @type {any[]} */ list) {
    const r = await kernel.records.define(ownerChain(), { add_types: list });
    for (const t of list) types.set(t.name, t);
    return r;
  }
  /** The types every Space has (task, template, playbook, team-member). */
  const defineCore = () => defineTypes([...CORE_TYPES]);

  /** An event for the Flows and anything else subscribed. Written once per `key`: a second call with the same key returns the first event. */
  /** @type {Map<string, Promise<any>>} */ const keyed = new Map();
  async function emit(/** @type {string} */ type, /** @type {any} */ data, /** @type {{ key?: string, subject?: string, source?: string, vis?: string, red?: string }} */ opt = {}) {
    const chain = chains.appendService(undefined, opt.source ?? "connector", true);
    const run = async () => {
      if (opt.key) { const had = log.read({ corr: opt.key, type })[0]; if (had) return { event: had, duplicate: true }; }
      const event = log.append(chain, { type, sv: 1, subject: opt.subject ?? `vyre://${space}/event/${opt.key ?? type}`, data, ...(opt.key ? { corr: opt.key } : {}), ...(opt.red ? { red: opt.red } : {}), ...(opt.vis ? { vis: opt.vis } : {}) });
      return { event, duplicate: false };
    };
    if (!opt.key) return run();
    const prior = keyed.get(opt.key) ?? Promise.resolve();
    const p = prior.then(run, run);
    keyed.set(opt.key, p);
    return p;
  }

  /** Install a Kit in the records language's compiled form: its types go through the gateway, then its Flows are approved by the owner. */
  async function installKit(/** @type {any} */ kit) {
    const k = toKernelKit(kit);
    await defineTypes(k.includes.types);
    const ids = [];
    for (const fl of k.includes.flows) {
      const d = await flows.runner.define(null, fl, person);
      if (!d.ok) throw new Error(`flow ${fl.name} did not compile: ${JSON.stringify(d.errors)}`);
      await flows.runner.approve(d.id, d.version, person, d.hash);
      ids.push(d.id);
    }
    return { types: k.includes.types.map((/** @type {any} */ t) => t.name), flows: ids };
  }

  /** Let the runs started by events settle (tests and connectors that answer after the work is done). */
  async function settle() { await new Promise((r) => setImmediate(r)); await flows.runner.drain(); await new Promise((r) => setImmediate(r)); await flows.runner.drain(); }

  return { space, kernel, log, chains, flows, person, ownerChain, forFlow, catalog, defineTypes, defineCore, emit, installKit, settle };
}
