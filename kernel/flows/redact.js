// @ts-check
// A run as someone else's authority shows it: the shape and the timings, never what the steps read or made. A run executes as the person who approved its version, so a step's input and output can hold
// any record that person may read. The member door shows a member the whole run (state, steps, times, the kind of each error) and replaces every step's data with words that name that person.

/** What a run's step carries that is data, not shape. */
const DATA_KEYS = ["input", "output", "attempts_log", "verify", "value", "result", "answered", "note"];

/** An error with its message replaced by the kind of error. @param {any} e @param {string} who */
const kindOnly = (e, who) => (e && typeof e === "object" ? { ...(e.step !== undefined ? { step: e.step } : {}), ...(e.code !== undefined ? { code: e.code } : {}), message: `This step stopped (${e.code || "error"}). The detail is for ${who}, whose authority the run used; ask them.` } : e);

/**
 * The run with its data replaced. @param {any} run @param {string} who the person the run executed as
 */
export function hideRun(run, who) {
  if (!run || typeof run !== "object") return run;
  const out = { ...run };
  out.trigger = run.trigger ? Object.fromEntries(["kind", "source", "key"].filter(k => run.trigger[k] !== undefined).map(k => [k, run.trigger[k]])) : run.trigger;
  out.steps = Object.fromEntries(Object.entries(run.steps || {}).map(([k, e]) => {
    if (!e || typeof e !== "object") return [k, e];
    const s = { ...e };
    for (const d of DATA_KEYS) delete s[d];
    if (s.error) s.error = kindOnly(s.error, who);
    if (e.output !== undefined || e.input !== undefined) s.output_hidden = `Hidden: this ran on ${who}'s authority. Ask them for what it read or made.`;
    return [k, s];
  }));
  if (run.error) out.error = kindOnly(run.error, who);
  for (const k of ["failing_error", "attention"]) if (out[k]) out[k] = typeof out[k] === "object" ? kindOnly(out[k], who) : "see the run's state";
  out.hidden_for = `This run used ${who}'s authority, so what its steps read and made is hidden. Ask them.`;
  return out;
}
