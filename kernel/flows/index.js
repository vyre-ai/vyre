// @ts-check
// The Flows part of the kernel, assembled: the runner, Kits, the canvas data and the tools that expose them. Built on kernel/contracts;
// the host gives it a kernel (authorize, records, ask, events, model), a chain builder and a catalog of the Space's types and actions.
//
//   const flows = createFlows({ kernel, chains, catalog, store, kitStore, emit, ports });
//   flows.tools["flows.define"](chain, { text })       every tool takes the caller's chain first, then its input
//   kernel events -> flows.onEvent(event)              one subscription feeds triggers, waits and Kit approvals
//   one timer     -> flows.tick(), at flows.nextWake()  time triggers and waits (nothing polls faster than a minute)
//   a watcher     -> flows.watcherItem({ watcher, item }) a watcher's new item (bridgeWatchers adapts the watchers module's events)

import { diffFlows } from "./diff.js";
import { testKit } from "./kit-test.js";
import { flowFromCalls } from "../../lib/flow-from-calls.js";
import { printLines } from "./lines.js";
import { connectorsOf } from "./health.js";
import { cheatsheet } from "./cheatsheet.js";
import { applyPatch, PatchError } from "./patch.js";
import { normalizeFlow } from "./text.js";
import { compareHistory } from "./replay.js";
import { checkCase, runCases, expectFrom, simulateCase, CASE_LIMITS } from "./cases.js";
import { describeFlow, describeRun, explainRun } from "./describe.js";
import { FlowRunner } from "./runner.js";
import { KitManager, MemoryKitStore, RecordsKitStore, KIT_TYPES, installCard, diffKits } from "./kits.js";
import { MemoryFlowStore } from "./store.js";
import { createStages, taskIdOf } from "./stages.js";
import { Proposals, proposerOf } from "./proposals.js";
import { graph, paintRun, seeAsCode, fromCode, flowChanges } from "./canvas.js";
import { compileFlow } from "./compile.js";
import { printFlow, parseFlowTextBounded } from "./text.js";

export { createStages, taskIdOf };
export { FlowRunner, KitManager, MemoryKitStore, MemoryFlowStore, installCard, diffKits };
export * as language from "./schema.js";
export { compileFlow, nextCron, parseCron, deriveCaps } from "./compile.js";
export { TRIGGER_REGISTRY, TRIGGER_ONS, kindOf, whyRan } from "./triggers.js";
export { bridgeWatchers } from "./watcher-bridge.js";
export { printFlow, parseFlowText, parseFlowTextBounded, normalizeFlow, sameFlow } from "./text.js";
export { defineFlow, step, expr } from "./sdk.js";
export { RecordsFlowStore, FLOW_TYPES } from "./store.js";
export { Proposals, proposerOf, assistantOf } from "./proposals.js";
export { RecordsKitStore, KIT_TYPES } from "./kits.js";
export { graph, paintRun, seeAsCode, fromCode, flowChanges, describeStep, describeTrigger, ops } from "./canvas.js";

/**
 * The one accountable person in a chain: a chain that is exactly [person]. Approving a Flow or a Kit is a human-only act (contract 9.2, R6-1);
 * the kernel has already verified presence before the call reaches here, and this refuses any chain with an agent, service or automation hop.
 * @param {any} chain @returns {{ kind: string, id: string, space: string }}
 */
/** A tool that needs an input says which one, and where to get it, instead of failing somewhere else ("that Flow is not running" for a missing id sent an agent the wrong way). @param {any} i @param {string} key @param {string} where */
function need(i, key, where) {
  if (!i || i[key] === undefined || i[key] === null || i[key] === "") throw Object.assign(new Error(`${key} is required: ${where}`), { code: "bad_input" });
  return i[key];
}

const isPlain = (/** @type {any} */ v) => v && typeof v === "object" && !Array.isArray(v);

function personOf(chain) {
  const hops = chain && chain.hops;
  if (!Array.isArray(hops) || hops.length !== 1 || hops[0].actor.kind !== "person") throw Object.assign(new Error("only a person can do that, in their own name"), { code: "chain_not_person" });
  const a = hops[0].actor;
  return { kind: "person", id: a.id, space: a.space };
}

/**
 * @param {{
 *   kernel: any, chains: { forFlow: (o: any) => any },
 *   catalog: () => Promise<import('./compile.js').Catalog> | import('./compile.js').Catalog,
 *   store?: any, kitStore?: any, clock?: () => number,
 *   emit?: (type: string, data: any, o: any) => void,
 *   ports?: any, installerRole?: (a: any) => Promise<string> | string, limits?: any,
 *   proposals?: { chain: () => any, applyTypes?: (approver: any, diff: any) => Promise<any>, kinds?: Record<string, import("./proposals.js").ProposalKind>, isAdmin?: (who: any) => Promise<boolean> | boolean },  an assistant's proposals become tasks (proposals.js)
 *   stages?: { approver: any },  stages made of tasks run when this is given: the person whose chain the module works under
 * }} o
 */
export function createFlows(o) {
  const store = o.store || new MemoryFlowStore();
  const runner = new FlowRunner({ kernel: o.kernel, store, catalog: o.catalog, chains: o.chains, clock: o.clock, emit: o.emit, ports: o.ports, limits: o.limits, policy: o.policy, settings: o.settings });
  const kits = new KitManager({ kernel: o.kernel, runner, store: o.kitStore || new MemoryKitStore(), catalog: o.catalog, chains: o.chains, clock: o.clock, installerRole: o.installerRole, ports: o.ports });
  const stages = o.stages && o.chains.forModule ? createStages({ kernel: o.kernel, catalog: o.catalog, chain: () => o.chains.forModule({ module: "stages", approver: o.stages.approver }), ports: o.ports, clock: o.clock, emit: o.emit, gates: runner.gatePort(), isAdmin: o.proposals && o.proposals.isAdmin }) : null;
  const proposals = o.proposals ? new Proposals({ kernel: o.kernel, runner, store, chain: o.proposals.chain, chains: o.chains, catalog: o.catalog, applyTypes: o.proposals.applyTypes, kinds: o.proposals.kinds, isAdmin: o.proposals.isAdmin, clock: o.clock, log: m => (o.emit ? o.emit("proposal.log", { m }) : undefined) }) : null;
  /** The stages module this Space runs: made here, or attached by the host that makes it. @type {any} */ let stagesRef = stages;
  /** The catalog, with the words of the Flows a sub-flow step can name (name -> label), so a step reads "Run Write the inner note", never an id. */
  const cat = async () => {
    const c = await o.catalog();
    try { return { ...c, flows: Object.fromEntries((await store.activeFlows()).map((/** @type {any} */ v) => [v.flow.name, v.flow.label || v.flow.name])) }; } catch { return c; }
  };
  const view = async (/** @type {string} */ id, /** @type {number} */ [version] = [/** @type {any} */ (undefined)]) => {
    const v = version !== undefined ? await store.getVersion(id, version) : (await store.active(id)) || (await latest(id));
    if (!v) throw Object.assign(new Error("no such Flow"), { code: "not_found" });
    return v;
  };
  /** The Connections a Flow uses (the `conn-` prefix off), from the version that runs or the newest. @param {string} id @returns {Promise<string[]>} */
  const connectionsOf = async (id) => { try { const v = await view(id); return connectorsOf(v.flow).map((/** @type {string} */ c) => c.replace(/^conn-/, "")); } catch { return []; } };
  const latest = async (/** @type {string} */ id) => { const r = await store.flowRow?.(id); const last = r && r.versions[r.versions.length - 1]; return last ? store.getVersion(id, last.version) : null; };

  /** Every stored version of every Flow as { id, name, version, json }. */
  const allDefinitions = async () => (await store.allVersions()).map((/** @type {any} */ v) => ({ id: v.id, name: v.flow.label || v.flow.name || v.id, version: v.version, json: JSON.stringify(v.flow) }));
  /** @type {Record<string, (chain: any, input: any) => Promise<any>>} */
  const tools = {
    /** Compile and store a new version, from the stored form or from text. Nothing runs until `flows.approve`. */
    "flows.define": async (chain, i) => {
      const c = await cat();
      let flow = i.flow;
      if (i.text !== undefined) {
        const lines = i.format === "lines";
        const r = fromCode(i.text, null, c, lines ? "lines" : "ts");
        const parsed = lines ? true : await parseFlowTextBounded(i.text).catch(() => null);
        if (!r.ok || !parsed) return { ok: false, errors: r.errors.length ? r.errors : [{ path: "", message: "that text could not be read" }] };
        flow = r.flow;
      }
      const by = chain.hops[chain.hops.length - 1].actor;
      const d = await runner.define(i.id || null, flow, by);
      if (d.ok) return { ...d, changes: i.id ? flowChanges((await view(i.id)).flow, flow, c) : [] };
      return d;
    },
    /** The approver sees the card built from the stored form and approves its hash. A person, in their own name. */
    "flows.approve": async (chain, i) => {
      const v = await store.getVersion(i.id, i.version);
      if (!v) throw Object.assign(new Error("no such Flow version"), { code: "not_found" });
      return runner.approve(i.id, i.version, personOf(chain), i.hash);
    },
    "flows.card": async (chain, i) => {
      const v = await view(i.id, [i.version]);
      const c = await cat();
      const compiled = compileFlow(v.flow, c);
      const prev = i.version && i.version > 1 ? await store.getVersion(i.id, i.version - 1) : null;
      return { id: v.id, version: v.version, hash: v.hash, authorship: v.flow.authorship, effects: compiled.effects, caps: compiled.caps, warnings: compiled.warnings, changes: prev ? flowChanges(prev.flow, v.flow, c) : [], text: seeAsCode(v.flow).text };
    },
    "flows.get": async (chain, i) => { const v = await view(need(i, "id", "the Flow's id (flows.list)"), [i.version]); return { id: v.id, version: v.version, hash: v.hash, status: v.status, approver: v.approver, flow: v.flow }; },
    // Every Flow with its one-line health (f8): a few tokens a Flow, so one call says how the whole Space is.
    "flows.list": async () => {
      const rows = await store.list(); const hs = new Map((await runner.health()).map((/** @type {any} */ h) => [h.id, h]));
      return Promise.all(rows.map(async (/** @type {any} */ r) => { const h = hs.get(r.id); const cs = await connectionsOf(r.id); return { ...r, ...(h ? { label: h.label, level: h.level, line: h.line } : {}), ...(cs.length ? { connections: cs } : {}) }; }));
    },
    // Connections list their Flows (R031-43): per Connection, the Flows that use it with each one's health, so a red Connection shows which Flows it stops.
    // The Vault's "Used by" (R031-70) and its scan for a secret value (R031-72): module-only reads of the stored definitions, every version of every Flow. The first answers names only; the second the
    // definition text, for the Vault's own scan (a Flow cannot hold a key: kernel/flows/no-secrets.js refuses it at save).
    "flows.credential-uses": async (chain, i) => {
      const name = need(i, "name", "the credential's name");
      const needle = `vault://${name}`;
      const uses = [];
      for (const d of await allDefinitions()) if (d.json.includes(needle) && !uses.some(u => u.id === d.id)) uses.push({ id: d.id, name: d.name });
      return { uses };
    },
    "flows.definitions.scan": async () => ({ definitions: await allDefinitions() }),
    "flows.connections": async (chain, i) => {
      const hs = new Map((await runner.health()).map((/** @type {any} */ h) => [h.id, h]));
      /** @type {Map<string, any[]>} */ const by = new Map();
      for (const r of await store.list()) {
        for (const c of await connectionsOf(r.id)) {
          if (i && i.connection && c !== String(i.connection)) continue;
          const h = hs.get(r.id);
          if (!by.has(c)) by.set(c, []);
          /** @type {any[]} */ (by.get(c)).push({ id: r.id, label: h ? h.label : r.id, active: r.status === "active", ...(h ? { level: h.level, line: h.line } : {}) });
        }
      }
      return { connections: [...by].map(([connection, flows]) => ({ connection, flows })).sort((a, b) => (a.connection < b.connection ? -1 : 1)) };
    },
    "flows.health": async (chain, i) => { const h = await runner.health(i && i.id); if (i && i.id && !h) throw Object.assign(new Error("no such Flow"), { code: "not_found" }); return i && i.id ? h : { flows: h, control: await runner.controlState() }; },
    // Saved test cases (t2). An assistant may add a case (that only makes approval stricter) but not change or remove one: that is a person's.
    "flows.test.save": async (chain, i) => {
      const id = need(i, "id", "the Flow's id (flows.list)");
      const v = await view(id, [i.version]);
      /** @type {any} */ let c = { name: i.name, ...(i.event !== undefined ? { event: i.event } : {}), ...(i.input !== undefined ? { input: i.input } : {}), ...(i.expect !== undefined ? { expect: i.expect } : {}) };
      const approver = personOf({ hops: [chain.hops[0]] });
      if (i.from_run) {
        const r = await runner.getRun(String(i.from_run));
        if (!r || r.flow !== id) throw Object.assign(new Error("that run is not a run of this Flow (flows.runs)"), { code: "not_found" });
        const t = r.trigger || {};
        c = { name: i.name || `from ${r.id}`, ...(t.event ? { event: { type: t.event.type, subject: t.event.subject, data: t.event.data } } : { input: t.input ?? {} }) };
        c.expect = expectFrom(await simulateCase(runner, v.flow, c, approver));
      }
      const problems = checkCase(c);
      if (problems.length) throw Object.assign(new Error(problems.map(p => `${p.path ? p.path + ": " : ""}${p.message}`).join("; ")), { code: "invalid" });
      const cases = await runner.tests(id);
      const at = cases.findIndex((/** @type {any} */ x) => x.name === c.name);
      const byAssistant = chain.hops.some((/** @type {any} */ h) => h.actor.kind === "agent");
      if (at >= 0 && byAssistant) throw Object.assign(new Error(`a case named ${c.name} exists; an assistant adds cases, a person changes one`), { code: "not_allowed" });
      if (at < 0 && cases.length >= CASE_LIMITS.cases) throw Object.assign(new Error(`a Flow keeps at most ${CASE_LIMITS.cases} test cases`), { code: "invalid" });
      if (at >= 0) cases[at] = c; else cases.push(c);
      await runner.saveTests(id, cases);
      const result = await runCases(runner, v.flow, [c], approver);
      return { saved: c.name, count: cases.length, expect: c.expect || null, ran: result.results[0].line };
    },
    "flows.test.run": async (chain, i) => {
      const id = need(i, "id", "the Flow's id (flows.list)");
      const v = await view(id, [i.version]);
      const cases = await runner.tests(id);
      const r = await runCases(runner, v.flow, cases, personOf({ hops: [chain.hops[0]] }));
      return { id, version: v.version, ok: r.ok, summary: cases.length ? `${r.passed} of ${cases.length} test case${cases.length === 1 ? "" : "s"} pass` : "this Flow has no saved test cases", lines: r.results.map(x => x.line) };
    },
    "flows.test.list": async (chain, i) => { const id = need(i, "id", "the Flow's id (flows.list)"); await view(id, [i.version]); return { id, cases: await runner.tests(id) }; },
    "flows.test.remove": async (chain, i) => {
      personOf(chain);
      const id = need(i, "id", "the Flow's id (flows.list)"); const name = need(i, "name", "the case's name (flows.test.list)");
      const cases = await runner.tests(id);
      if (!cases.some((/** @type {any} */ c) => c.name === name)) throw Object.assign(new Error("no such test case (flows.test.list)"), { code: "not_found" });
      await runner.saveTests(id, cases.filter((/** @type {any} */ c) => c.name !== name));
      return { removed: name };
    },
    "flows.timeline": async (chain, i) => runner.timeline(need(i, "run", "the run's id (flows.runs)"), { step: i.step }),
    "flows.diff": async (chain, i) => {
      need(i, "id", "the Flow's id (flows.list)"); need(i, "from", "an older version number"); need(i, "to", "a newer version number");
      const a = await store.getVersion(i.id, Number(i.from)), b = await store.getVersion(i.id, Number(i.to));
      if (!a || !b) throw Object.assign(new Error("no such Flow version"), { code: "not_found" });
      return { id: i.id, from: Number(i.from), to: Number(i.to), ...diffFlows(a.flow, b.flow) };
    },
    // One click to go back: approve an earlier version again, as the person who clicks (an approval is never inherited), and say in words what changes. Runs in flight keep their version; failed runs that still match can
    // be moved to the restored version with retry_failed.
    "flows.rollback": async (chain, i) => {
      const who = personOf(chain);
      need(i, "id", "the Flow's id (flows.list)"); need(i, "to", "the version number to go back to (flows.get shows the versions)");
      const target = await store.getVersion(i.id, Number(i.to));
      if (!target) throw Object.assign(new Error("no such Flow version"), { code: "not_found" });
      const list = await store.list(); const row = list.find((/** @type {any} */ r) => r.id === i.id);
      const was = row && row.active !== null && row.active !== undefined ? await store.getVersion(i.id, row.active) : null;
      if (was && was.version === target.version) return { ok: true, active: target.version, changes: [], note: "that version is already the active one" };
      await runner.approve(i.id, target.version, who, target.hash);
      const changes = was ? diffFlows(was.flow, target.flow).summary : [];
      /** @type {string[]} */ const retried = [], refused = [];
      if (i.retry_failed === true) for (const r of await runner.listRuns({ flow: i.id, state: "failed", limit: 200 })) { try { await runner.retry(r.id, { version: "latest", by: who.id }); retried.push(r.id); } catch (e) { refused.push(`${r.id}: ${/** @type {Error} */ (e).message}`); } }
      return { ok: true, active: target.version, was: was ? was.version : null, changes, retried, refused };
    },
    "flows.describe": async (chain, i) => {
      if (i && i.run) { const r = await runner.getRun(i.run); if (!r) throw Object.assign(new Error("no such run"), { code: "not_found" }); const v = await store.getVersion(r.flow, r.version); return { explain: explainRun(r, v ? v.flow : null), lines: describeRun(r, v ? v.flow : null) }; }
      const v = await view(i.id, [i.version]);
      const h = await runner.health(i.id);
      return { lines: describeFlow(v.flow, { id: v.id, version: v.version, status: v.status, health: h ? h.line : undefined }) };
    },
    // Edit by patch (e2): small named edits on the newest version, stored as a new draft. A patch made against an older version is refused, never merged.
    "flows.patch": async (chain, i) => {
      const id = need(i, "id", "the Flow's id (flows.list)");
      const cur = await latest(id);
      if (!cur) throw Object.assign(new Error("no such Flow"), { code: "not_found" });
      if (i.base !== undefined && i.base !== cur.version && i.base !== cur.hash) throw Object.assign(new Error(`this patch was made against ${typeof i.base === "number" ? "version " + i.base : "an older version"}, but the Flow is at version ${cur.version} (hash ${cur.hash.slice(0, 12)}); read it again with flows.code and redo the edit`), { code: "conflict" });
      let flow;
      try { flow = normalizeFlow(applyPatch(cur.flow, i.ops)); } catch (e) { if (e instanceof PatchError) return { ok: false, errors: [{ path: `ops[${e.at}]`, message: e.detail }] }; throw e; }
      const c = await cat();
      const by = chain.hops[chain.hops.length - 1].actor;
      const d = await runner.define(id, flow, by);
      return d.ok ? { ...d, changes: flowChanges(cur.flow, flow, c) } : d;
    },
    "flows.cheatsheet": async () => ({ text: cheatsheet() }),
    "flows.code": async (chain, i) => seeAsCode((await view(need(i, "id", "the Flow's id (flows.list)"), [i.version])).flow, i.format),
    "flows.compile-text": async (chain, i) => fromCode(i.text, i.id ? (await view(i.id)).flow : null, await cat(), i.format),
    "flows.graph": async (chain, i) => graph((await view(i.id, [i.version])).flow, await cat()),
    "flows.simulate": async (chain, i) => {
      const c = await cat();
      const flow = i.flow || (await view(i.id, [i.version])).flow;
      const approver = personOf({ hops: [chain.hops[0]] });
      const sim = await runner.simulate(flow, { approver, since: i.since, until: i.until, samples: i.samples, limit: i.limit });
      // "Try it on last week": with a Flow id (or `against`), set the practice run beside what that Flow really did in the same window
      const against = i.against || i.id;
      if (sim.ok && against && i.since !== undefined) return { ...sim, history: compareHistory(sim, await runner.listRuns({ flow: String(against), limit: 1000 }), { since: i.since, until: i.until }) };
      return sim;
    },
    "flows.start": async (chain, i) => runner.start(need(i, "id", "the Flow's id (flows.list shows each Flow with its id and how it is doing)"), i.input, chain, i.key),
    // pause: one Flow (id), or everything (all: true), or drain (drain: true: finish what is running, start nothing). What arrives while paused is held and runs on resume (backlog: "run", the default) or is
    // dropped and counted (backlog: "drop"). The answer says the state first: the switch, what is held, what was dropped.
    "flows.pause": async (chain, i) => {
      const who = personOf(chain);
      if (i && (i.all === true || i.drain === true)) return { ok: true, control: await runner.pauseAll({ reason: i.reason, by: who.id, drain: i.drain === true }) };
      await runner.pauseFlow(i.id, i.reason || "paused by a person"); return { ok: true, control: await runner.controlState() };
    },
    "flows.resume": async (chain, i) => {
      const who = personOf(chain);
      const o = { by: who.id, ...(i && i.backlog === "drop" ? { backlog: /** @type {'drop'} */ ("drop") } : {}) };
      if (i && i.all === true) return { ok: true, control: await runner.resumeAll(o) };
      const r = await runner.resumeFlow(i.id, o); return { ...r, control: await runner.controlState() };
    },
    "flows.control": async () => runner.controlState(),
    "flows.runs": async (chain, i) => (await runner.listRuns({ flow: i.id, state: i.state, limit: i.limit })).map(r => ({ id: r.id, flow: r.flow, version: r.version, state: r.state, started_at: r.started_at, finished_at: r.finished_at, tainted: r.tainted, ...(r.record ? { record: r.record } : {}), ...(r.label ? { label: r.label } : {}), ...(r.parent ? { parent: r.parent.run } : {}), error: r.error && r.error.code && r.error.code !== "note" ? r.error : null })),
    "flows.run": async (chain, i) => {
      const r = await runner.getRun(need(i, "run", "the run's id (flows.start and flows.runs give it)"));
      if (!r) throw Object.assign(new Error("no such run"), { code: "not_found" });
      const v = await store.getVersion(r.flow, r.version);
      // the lanes of a parallel step are runs of their own: their steps are painted on this run's picture, and each lane is listed with its state
      const lanes = [];
      for (const l of Object.values(r.steps || {})) for (const id of (/** @type {any} */ (l).children || [])) { const k = await runner.getRun(id); if (k && k.parent && k.parent.lane) lanes.push({ lane: k.parent.lane, run: k.id, state: k.state, steps: k.steps }); }
      const shown = lanes.length ? { ...r, steps: Object.assign({}, ...lanes.map(k => k.steps), r.steps) } : r;
      return { run: r, painted: v ? paintRun(v.flow, shown, await cat()) : null, ...(lanes.length ? { lanes: lanes.map(({ lane, run, state }) => ({ lane, run, state })) } : {}) };
    },
    // The Space's daily AI allowance for Flow steps: anyone in the Space may read it; an owner or an admin sets it.
    "flows.budget": async (chain, i) => {
      if (i && (i.tokens_per_day !== undefined || i.context_tokens !== undefined)) {
        const who = personOf(chain);
        const holders = [...(o.ports && o.ports.roles ? await o.ports.roles(who.space, "owner") : []), ...(o.ports && o.ports.roles ? await o.ports.roles(who.space, "admin") : [])];
        if (!holders.some((/** @type {any} */ h) => h.id === who.id)) throw Object.assign(new Error("only an owner or an admin sets the AI budget"), { code: "not_allowed" });
        if (i.context_tokens !== undefined) await runner.setContextTokens(Number(i.context_tokens));
        if (i.tokens_per_day !== undefined) await runner.setAiBudget(Number(i.tokens_per_day));
        return runner.aiBudget();
      }
      return runner.aiBudget();
    },
    // A person's own. `by` is never taken from the call: it is the person at the other end of the chain (who supplied a substitute value for a skipped step is on the record).
    "flows.retry": async (chain, i) => {
      const who = personOf(chain);
      need(i, "run", "the run's id (flows.runs)");
      // An assistant may propose a value for a skipped step, in words; the person accepts it, and the call that carries it is theirs. A call with an assistant in its chain cannot carry the value itself.
      if (i.value !== undefined && (chain.hops || []).some((/** @type {any} */ h) => h.actor.kind === "agent")) throw Object.assign(new Error("an assistant proposes the value to use for a skipped step; the person accepts it"), { code: "person_only_value" });
      await runner.retry(i.run, { skip: i.skip === true, ...(i.value !== undefined ? { value: i.value } : {}), by: who.id, ...(i.version === "latest" ? { version: "latest" } : {}) }); return { ok: true };
    },
    // Needs attention (f3): the runs a person has to look at, and the one answer (the approvals queue draws a card from the first and answers with the second).
    "flows.attention": async () => ({ runs: await runner.attention(), ...(o.stuckTasks ? { tasks: await Promise.resolve(o.stuckTasks()).catch(() => []) } : {}) }),
    "flows.settle": async (chain, i) => {
      const who = personOf(chain);
      const run = need(i, "run", "the run's id (flows.attention)");
      const action = need(i, "action", "retry, skip, stop or advance");
      if (action === "retry") { await runner.retry(run, { by: who.id }); return { ok: true, action }; }
      if (action === "skip") {
        if (i.value !== undefined && (chain.hops || []).some((/** @type {any} */ h) => h.actor.kind === "agent")) throw Object.assign(new Error("an assistant proposes the value to use for a skipped step; the person accepts it"), { code: "person_only_value" });
        await runner.retry(run, { skip: true, ...(i.value !== undefined ? { value: i.value } : {}), by: who.id }); return { ok: true, action };
      }
      if (action === "stop") return { ...(await runner.cancel(run, { by: who.id, reason: i.reason })), action };
      if (action === "advance") {
        if (!stagesRef) throw Object.assign(new Error("stages are not running in this Space"), { code: "unavailable" });
        return { ...(await stagesRef.advance(run, who, need(i, "reason", "why it moves on early"))), action };
      }
      throw Object.assign(new Error("action is retry, skip, stop or advance"), { code: "bad_input" });
    },
    // "Turn this into a Flow" (R031-42): the calls an assistant made by hand become a stored draft (and, with propose, a checked proposal). The draft is an ordinary one: define's errors name the place.
    "flows.from-chat": async (chain, i) => {
      const name = need(i, "name", "a short name for the Flow");
      if (!Array.isArray(i.calls) || !i.calls.length || i.calls.length > 40) throw Object.assign(new Error("calls is the list of { tool, input } the assistant made, 1 to 40"), { code: "bad_input" });
      const c = await cat();
      const m = flowFromCalls({ name: String(name), ...(i.label ? { label: String(i.label) } : {}), calls: i.calls, ...(isPlain(i.variables) ? { variables: i.variables } : {}) }, { types: c.types, actions: c.actions });
      if (!m.flow.steps.length) return { ok: false, errors: [{ path: "calls", message: "none of those calls can be a step of a Flow" }], unmapped: m.unmapped };
      const by = chain.hops[chain.hops.length - 1].actor;
      const d = await runner.define(null, normalizeFlow(m.flow), by);
      if (!d.ok) return { ...d, unmapped: m.unmapped };
      const out = { ok: true, id: d.id, version: d.version, hash: d.hash, lines: printLines(normalizeFlow(m.flow)), inputs: m.inputs, unmapped: m.unmapped, warnings: d.warnings,
        next: "Read the lines, add what is unmapped (flows.patch), save a test case (flows.test.save), then flows.propose, which checks it before a person is asked." };
      if (i.propose === true) return { ...out, proposal: await tools["flows.propose"](chain, { what: "flow", id: d.id, version: d.version }) };
      return out;
    },
    "flows.cancel": async (chain, i) => { const who = personOf(chain); need(i, "run", "the run's id (flows.runs)"); return runner.cancel(i.run, { by: who.id, reason: i.reason }); },
    "kits.card": async (chain, i) => installCard(i.kit, await cat()),
    "kits.diff": async (chain, i) => kits.diff(i.kit),
    // Try a Kit's template on a sample, or on a real record read-only, with nothing sent (s3).
    "kits.test": async (chain, i) => {
      const approver = personOf({ hops: [chain.hops[0]] });
      /** @type {any} */ let record;
      if (i.record) {
        const m = /^vyre:\/\/[^/]+\/([^/]+)\/([^/]+)$/.exec(String(i.record));
        if (!m) throw Object.assign(new Error("record is the record's address, like vyre://space/matter/ID"), { code: "bad_input" });
        const row = await o.kernel.records.get(chain, m[1], m[2]).catch(() => null);
        if (!row) throw Object.assign(new Error("no such record, or you may not read it"), { code: "not_found" });
        record = { type: m[1], id: m[2], data: row.data };
      }
      return testKit({ kit: i.kit, cat: await cat(), runner, approver, sample: i.sample, record });
    },
    // A person, or an assistant acting for them: the person is the approver and the task asks them. An assistant never installs: the install runs only after the approver says yes.
    "kits.propose": async (chain, i) => { const who = proposerOf(chain); if (!who) throw Object.assign(new Error("only a person can do that, in their own name"), { code: "chain_not_person" }); return kits.propose(i.kit, who, chain); },
    // A draft is checked and practice-run before a person is asked (e5): it compiles, its saved test cases pass, and the last week of events is replayed through it with every action stubbed.
    // The result is one line on the card. An assistant cannot skip this; a person may with `unchecked: true`, and the card says so.
    "flows.propose": async (chain, i) => {
      if (!proposals) throw Object.assign(new Error("proposals are not wired here"), { code: "unavailable" });
      if (!i || i.what !== "flow") return proposals.propose(chain, i);
      const byAssistant = chain.hops.some((/** @type {any} */ h) => h.actor.kind === "agent");
      if (i.unchecked === true && byAssistant) throw Object.assign(new Error("an assistant proposes only a checked draft: remove unchecked"), { code: "not_allowed" });
      const v = await store.getVersion(String(i.id || ""), Number(i.version));
      if (!v) return proposals.propose(chain, i);            // the same plain error as before
      if (i.unchecked === true) return proposals.propose(chain, { ...i, note: `Not checked before proposing. ${i.note || ""}`.trim().slice(0, 500) });
      const c = await cat();
      const compiled = compileFlow(v.flow, c);
      if (!compiled.ok) return { ok: false, errors: compiled.errors, message: "not proposed: the draft does not compile; fix these and propose again" };
      const approver = personOf({ hops: [chain.hops[0]] });
      const cases = await runner.tests(v.id);
      const tested = cases.length ? await runCases(runner, v.flow, cases, approver) : null;
      if (tested && !tested.ok) return { ok: false, errors: tested.results.filter(r => !r.ok).map(r => ({ path: "tests", message: r.line })), message: "not proposed: a saved test case fails" };
      const now = runner.now();
      const sim = await runner.simulate(v.flow, { approver, since: now - 7 * 86_400_000, until: now, limit: 200 }).catch(() => null);
      // when this Flow has really run in that week, say how much of it the new version would have done the same
      const hist = sim && sim.ok ? compareHistory(sim, await runner.listRuns({ flow: v.id, limit: 1000 }), { since: now - 7 * 86_400_000, until: now }) : null;
      const bits = ["compiles", tested ? `${tested.passed} test case${tested.passed === 1 ? "" : "s"} pass` : "no saved test cases", sim && sim.ok ? sim.summary.replace(/^This Flow would have run/, "last week it would have run") : "not replayed (its trigger has nothing to replay)",
        ...(hist && hist.ran ? [`${hist.same} of its ${hist.ran} real runs would have gone the same way`] : [])];
      const line = `Checked: ${bits.join("; ")}.`;
      const r = await proposals.propose(chain, { ...i, note: `${line} ${i.note || ""}`.trim().slice(0, 500) });
      return { ...r, checked: line };
    },
    // Move a record on before its stage's tasks are done: the stage's owner or an admin, with a reason, on the gate's ledger (s1).
    "flows.advance": async (chain, i) => {
      const who = personOf(chain);
      if (!stagesRef) throw Object.assign(new Error("stages are not running in this Space"), { code: "unavailable" });
      return stagesRef.advance(need(i, "run", "the stage gate's run id (flows.runs, or a record's stage)"), who, need(i, "reason", "why it moves on early"));
    },
    "kits.remove": async (chain, i) => kits.remove(i.id, personOf(chain), chain),
    "kits.list": async () => kits.list(),
    // The vault asks, before it lends a Connection to a task's doer, which approved Kit version the task is from and which Connections that version names for it (vault.connections.lend).
    "kits.credentials": async (chain, i) => {
      const task = need(i, "task", "the task id");
      const ent = stagesRef ? stagesRef.entries().find((/** @type {any} */ e) => e.tasks.some((/** @type {any} */ t) => t.id === task)) : null;
      const t = ent && ent.tasks.find((/** @type {any} */ x) => x.id === task);
      const hit = ent && t ? await kits.credentialsFor({ type: ent.type, stage: ent.stage, title: t.title }) : null;
      if (!hit) throw Object.assign(new Error("no approved Kit version names credentials for that task"), { code: "not_found" });
      return hit;
    },
  };

  return {
    runner, kits, stages, store, tools,
    /** The host makes the stages module itself and hands it over, so flows.advance, the tick and a restart reach it. @param {any} s */
    attachStages: s => { stagesRef = s; },
    /** One subscription feeds triggers, waits and Kit approvals. @param {any} env */
    onEvent: async env => { await runner.onEvent(env); await kits.onEvent(env); if (proposals) await proposals.onEvent(env); if (stages) await stages.onEvent(env); },
    tick: async () => { const r = await runner.tick(); if (stagesRef && stagesRef.tick) await stagesRef.tick(); return r; },
    /** A watcher found something new (see watcher-bridge.js): starts the Flows armed on it, once per item. */
    watcherItem: w => runner.watcherItem(w),
    /** An inbound call at a web trigger's path (an app module's webhook, a form): the host has authenticated it and labelled its trust. See runner.handleWeb. */
    handleWeb: (path, req) => runner.handleWeb(path, req),
    nextWake: () => runner.nextWake(),
    recover: async () => { await runner.recover(); if (stagesRef && stagesRef.resume) await stagesRef.resume(); },
    text: printFlow,
  };
}
