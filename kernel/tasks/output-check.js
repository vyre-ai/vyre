// kernel/tasks/output-check.js: PURE FORMAT CHECK. It takes the task, the evidence and the facts and returns { ok } or { ok: false, why }; it reads no record itself, decides no grant, and does not choose
// whether a task is guarded (that is needsCheck and the transition table in tasks.js). The facts it is handed (record, exists) are built in tasks.js (resolveFacts), never here.

/**
 * The kernel's output check: the declared kind decides what evidence is enough (contract 9.4 table). These are format
 * checks, not truth: a task that gates a stage, a send or a payment needs a human checker (R6-5).
 * @param {any} task @param {any} evidence @param {{ record?: (urn: string) => Promise<any>, exists?: (urn: string) => Promise<boolean> }} facts
 */
export async function checkOutput(task, evidence, facts) {
  const e = evidence && typeof evidence === "object" ? evidence : {};
  switch (task.output.kind) {
    case "fields": {
      const names = [].concat(task.output.target || []);
      const rec = task.record && facts.record ? await facts.record(task.record) : null;
      if (!rec || !names.length) return { ok: false, why: "the record or the fields to fill are missing" };
      const empty = names.filter(n => rec.data[n] === undefined || rec.data[n] === null || rec.data[n] === "");
      return empty.length ? { ok: false, why: `not filled: ${empty.join(", ")}` } : { ok: true };
    }
    case "note": return Array.isArray(e.sources) && e.sources.length >= 1 && typeof e.note === "string" && e.note.trim() ? { ok: true } : { ok: false, why: "a note needs text and at least one source" };
    case "draft": return typeof e.draft === "string" && facts.exists && (await facts.exists(e.draft)) ? { ok: true } : { ok: false, why: "no draft exists to check" };
    case "sent": return e.payload && typeof e.payload === "object" && typeof e.action === "string" && typeof e.resource === "string" ? { ok: true } : { ok: false, why: "a send needs its canonical payload, action and resource" };
    case "decision": return (e.answer === "yes" || e.answer === "no") && typeof e.reason === "string" && e.reason.trim() ? { ok: true } : { ok: false, why: "a decision needs yes or no and a reason" };
    case "file": return typeof e.file === "string" && facts.exists && (await facts.exists(e.file)) ? { ok: true } : { ok: false, why: "no file was produced" };
    default: return { ok: false, why: "unknown output kind" };
  }
}
