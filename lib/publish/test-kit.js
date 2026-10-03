// @ts-check
// lib/publish/test-kit.js: fakes for the Publish tests. Sample world only (alex, juno, kit, Harlow Legal, Northwind Bakery).
// Not a test file and not shipped behaviour: it builds chains, a store, an Ask, a ledger and a builder in memory.

import { createPublisher } from "./index.js";
import { compact } from "./secrets.js";

export const SPACE = { id: "spc_a1b2c3d4e5f6", name: "harlow.vyre.run" };

/** @param {string} kind @param {string} id */
const hop = (kind, id) => ({ actor: { kind, id, space: SPACE.id }, entered_by: "surface" });
/** @param {any[]} hops */
export const chainOf = (...hops) => /** @type {any} */ ({ space: SPACE.id, hops, labels: { trust: "member", red: "internal", source_spaces: [SPACE.id] }, built_at: 0 });
export const person = (/** @type {string} */ id) => chainOf(hop("person", id));
export const model = (/** @type {string} */ id = "juno") => chainOf(hop("person", "per_alex"), hop("agent", id));
export const automation = () => chainOf(hop("person", "per_alex"), hop("automation", "fl_publish"));

export const ROLES = { per_alex: "owner", per_kit: "admin", per_mara: "manager", per_sam: "member", per_pat: "manager" };

export function memoryStore() {
  /** @type {Map<string, Map<string, any>>} */ const m = new Map();
  const c = (/** @type {string} */ n) => m.get(n) || m.set(n, new Map()).get(n);
  return {
    async get(/** @type {string} */ coll, /** @type {string} */ id) { const v = c(coll)?.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; },
    async put(/** @type {string} */ coll, /** @type {string} */ id, /** @type {any} */ v) { c(coll)?.set(id, JSON.parse(JSON.stringify(v))); },
    async delete(/** @type {string} */ coll, /** @type {string} */ id) { c(coll)?.delete(id); },
    async list(/** @type {string} */ coll) { return [...(c(coll)?.values() || [])].map(v => JSON.parse(JSON.stringify(v))); },
  };
}

export function fakeAsk() {
  /** @type {Map<string, any>} */ const tasks = new Map();
  let n = 0;
  return {
    tasks,
    async request(/** @type {any} */ chain, /** @type {any} */ t) { const id = "task_" + (++n); tasks.set(id, { id, state: "needs_check", requested_by: chain, ...t }); return { id }; },
    async get(/** @type {string} */ id) { const t = tasks.get(id); return t ? { id, state: t.state, outcome: t.outcome, decided_by: t.decided_by, payload: { payload_hash: t.payload_hash } } : null; },
    /** What the UI does when a person taps Approve. */
    decide(/** @type {string} */ id, /** @type {any} */ by, outcome = "approved") { const t = tasks.get(id); t.state = "done"; t.outcome = outcome; t.decided_by = by; },
  };
}

/** A ledger that knows plaintext values (the real one holds keyed hashes; the shape is the same). @param {string[]} values */
export function fakeLedger(values) {
  const set = new Map(values.map(v => [compact(v), "us-ssn"]));
  const lens = [...new Set([...set.keys()].map(k => k.length))];
  return { lengths: () => lens, has: (/** @type {string} */ c) => set.get(c) || false };
}

/** @param {{ deny?: string[], ask?: string[] }} [policy] */
export function fakeAuthorize(policy = {}) {
  /** @type {any[]} */ const calls = [];
  const fn = async (/** @type {any} */ input) => {
    calls.push(input);
    const deny = (policy.deny || []).includes(input.action);
    const ask = input.action === "deploy.publish" || input.action === "deploy.rollback" || input.action === "deploy.secret" || (policy.ask || []).includes(input.action);
    return { effect: deny ? "deny" : ask ? "ask" : "allow", reason: deny ? "no_grant" : "ok", decision: "dec_" + calls.length, grants: [], obligations: [], policy_version: 1 };
  };
  return Object.assign(fn, { calls });
}

/**
 * A publisher over fakes.
 * @param {{ files?: any[], logs?: string, ledger?: string[], secretsByRef?: Record<string, string>, policy?: any, classOf?: (ref: string) => string }} [o]
 */
export function setup(o = {}) {
  let t = 1_790_000_000_000, r = 0;
  const events = /** @type {any[]} */ ([]);
  const store = memoryStore();
  const ask = fakeAsk();
  const authorize = fakeAuthorize(o.policy);
  const written = /** @type {Record<string, string>} */ ({});
  const secretsByRef = o.secretsByRef || { "vault://harlow/stripe": "sk_live_FAKEFAKEFAKE1234", "vault://harlow/site-title": "Northwind Bakery" };
  let build = { digest: "sha256:" + "a".repeat(64), files: o.files || [{ path: "index.html", content: "<h1>Northwind Bakery</h1>" }], logs: o.logs ?? "step 1 ok", runtime: /** @type {any} */ (undefined) };
  const dnsTxt = /** @type {Record<string, string[][]>} */ ({});
  const pub = createPublisher({
    space: SPACE,
    clock: { now: () => (t += 1000) },
    random: n => Uint8Array.from({ length: n }, () => (r = (r * 31 + 7) % 251)),
    authorize,
    events: { emit: e => { events.push(e); } },
    store,
    dns: { resolveTxt: async name => { if (!(name in dnsTxt)) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" }); return dnsTxt[name]; } },
    ledger: fakeLedger(o.ledger || ["123-45-6789"]),
    secrets: {
      dir: "/run/publish-secrets",
      classOf: o.classOf || (ref => (ref.includes("stripe") ? "secret" : "config")),
      read: async ref => secretsByRef[ref],
      writeFile: async (p, v) => { written[p] = v; },
      removeFile: async p => { delete written[p]; },
    },
    ask,
    roles: { roleOf: id => /** @type {any} */ (ROLES)[id] || null, managesProject: (id, project) => id === "per_mara" && project === "bakery" },
    names: { owns: async host => host === "northwind.vyre.run" },
    builder: { build: async () => ({ ...build }) },
  });
  return { pub, events, store, ask, authorize, written, dnsTxt, setBuild: (/** @type {any} */ b) => { build = { ...build, ...b }; }, tick: (/** @type {number} */ ms) => { t += ms; } };
}

export const DRAFT = { name: "northwind", source: { kind: "repo", ref: "https://git.example.com/northwind.git#main" }, build: { command: "npm run build", output_dir: "dist", image: "node-22" }, project: "bakery" };
