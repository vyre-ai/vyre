// @ts-check
// Template test mode (s3): try a Kit's template on a sample (or a real record, read only) with nothing sent, nothing stored and nothing emitted. It walks the stages of the type, and says for each
// one who gets which task and what the brief says once the record is filled in, what the checklist asks, what holds the record in the stage, what the next stage's entry condition says of this
// record, and what each Flow that starts at this stage would do (the runner's simulation, every action stubbed). One line each, then a totals line.

import { checkKit } from "./kits.js";
import { renderBrief } from "./checklist.js";
import { holds } from "../../lib/expr/conditions.js";

const cut = (/** @type {string} */ s, n = 110) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * @param {{ kit: any, cat: any, runner: any, approver: any, sample?: { type?: string, data?: Record<string, any> }, record?: { type: string, data: Record<string, any>, id?: string } }} o
 * @returns {Promise<{ ok: boolean, errors?: { path: string, message: string }[], type?: string, lines?: string[], totals?: string, counts?: Record<string, number> }>}
 */
export async function testKit(o) {
  const checked = checkKit(o.kit, o.cat);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const merged = checked.cat;
  const inc = o.kit.includes || {};
  /** @type {any[]} */ const types = (inc.types || []).filter((/** @type {any} */ t) => Array.isArray(t.stages) && t.stages.length);
  const want = (o.record && o.record.type) || (o.sample && o.sample.type);
  const type = want ? types.find(t => t.name === want) : types.find(t => t.stages.some((/** @type {any} */ s) => (s.tasks || []).length)) || types[0];
  if (!type) return { ok: false, errors: [{ path: "type", message: want ? `this Kit has no type ${want} with stages; it has ${types.map(t => t.name).join(", ") || "none"}` : "this Kit has no type with stages to try" }] };
  const data = (o.record && o.record.data) || (o.sample && o.sample.data) || {};
  const stageField = (type.fields || []).find((/** @type {any} */ f) => f.kind === "stage");
  /** @type {string[]} */ const lines = [`Trying ${o.kit.name || o.kit.id} on a ${type.name}${o.record ? " (a real record, read only)" : " (a sample)"}. Nothing is sent, stored or changed.`];
  const counts = { stages: 0, tasks: 0, flows: 0, approvals: 0, sends: 0, held: 0 };
  /** @type {any[]} */ const flows = (inc.flows || []);
  for (let i = 0; i < type.stages.length; i++) {
    const st = type.stages[i];
    const next = type.stages[i + 1];
    counts.stages++;
    lines.push(`Stage ${st.name}${st.owner ? ` (owner ${st.owner})` : ""}:`);
    const tasks = st.tasks || [];
    for (const t of tasks) {
      counts.tasks++;
      lines.push(`  task "${t.title}" for ${t.doer}${t.checker ? `, checked by ${t.checker}` : ""}${t.required === false ? " (optional)" : ""}`);
      if (t.brief) lines.push(`    brief: ${cut(renderBrief(t.brief, data))}`);
      for (const c of t.checklist || []) lines.push(`    must hold: ${c.say} (${Object.keys(c.check)[0]})`);
      if (t.credentials && t.credentials.length) lines.push(`    may use: ${t.credentials.join(", ")}`);
    }
    if (tasks.length) lines.push(`  moves on when ${tasks.some((/** @type {any} */ t) => t.required !== false) ? "the required tasks are done" : "all the tasks are done or skipped"}${st.owner ? `; ${st.owner} or an admin can move it early` : ""}.`);
    else lines.push("  no tasks: a person moves it on.");
    if (next && typeof next.enter_if === "string") {
      const merged2 = { ...data, ...(stageField ? { [stageField.name]: next.name } : {}) };
      lines.push(`  ${next.name} needs ${next.enter_if}: ${holds(next.enter_if, merged2) ? "this record meets it" : "this record does not meet it, so the gate would hold here"}.`);
    }
    for (const f of flows.filter(x => x.trigger && x.trigger.on === "stage" && x.trigger.type === type.name && x.trigger.stage === st.name)) {
      counts.flows++;
      const env = { id: `kit-test:${st.name}`, type: "record.stage-entered", subject: `vyre://${merged.space}/${type.name}/sample`, data: { type: type.name, id: "sample", stage: st.name, ...data }, trust: "internal", received_at: o.runner.now(), time: o.runner.now() };
      const sim = await o.runner.simulate({ ...f, authorship: "kit" }, { approver: o.approver, events: [env], limit: 1, cat: merged, softReads: true }).catch((/** @type {any} */ e) => ({ ok: false, errors: [{ message: e instanceof Error ? e.message : String(e) }] }));
      if (!sim.ok) { lines.push(`  Flow ${f.name} would start here but does not run: ${sim.errors && sim.errors[0] ? sim.errors[0].message : "an error"}`); continue; }
      const t = sim.totals || {};
      const sends = (t.outward || []).reduce((/** @type {number} */ n, /** @type {any} */ x) => n + x.count, 0);
      counts.approvals += t.asks || 0; counts.sends += sends;
      lines.push(`  Flow ${f.name} starts here: ${sim.matched ? `${(t.completed ? "it completes" : t.paused ? "it pauses" : "it fails")}; ` : "its trigger did not match; "}${t.asks || 0} approval${t.asks === 1 ? "" : "s"}, ${Object.entries(t.writes || {}).map(([k, n]) => `${n} ${k} written`).join(", ") || "no writes"}, ${sends} outward act${sends === 1 ? "" : "s"} (stubbed).`);
    }
  }
  const others = flows.filter(x => !(x.trigger && x.trigger.on === "stage" && x.trigger.type === type.name));
  if (others.length) lines.push(`Other Flows (not tried here, they start on ${[...new Set(others.map(x => x.trigger && (x.trigger.event || x.trigger.on)))].join(", ")}): ${others.map(x => x.name).join(", ")}.`);
  const totals = `${counts.stages} stages, ${counts.tasks} tasks, ${counts.flows} Flow${counts.flows === 1 ? "" : "s"} tried, ${counts.approvals} approval${counts.approvals === 1 ? "" : "s"}, ${counts.sends} sent.`;
  lines.push(totals);
  return { ok: true, type: type.name, lines, totals, counts };
}
