// @ts-check
// A one-page cheat sheet of the Flows language (e6), generated from the code so it cannot go stale: every trigger and step kind with its keys and an example in the lines form, the policy
// keys with their limits and defaults, what an expression can read and call. The examples are real steps: the test checks each against the schema.

import { STEP_KINDS, STEP_KEYS, POLICY_LIMITS, RETRY_CODES, LIMITS, BLOCK_KINDS } from "./schema.js";
import { TRIGGER_REGISTRY } from "./triggers.js";
import { FUNCTIONS } from "./expr.js";
import { POLICY } from "./runner.js";
import { printLines } from "./lines.js";

/** One real, valid step of every kind. The cheat sheet shows it in the lines form; the test checks it. @type {Record<string, any>} */
export const EXAMPLES = Object.freeze({
  find: { id: "who", kind: "find", type: "client", where: "record.email == trigger.email", limit: 5 },
  pick: { id: "one", kind: "pick", type: "client", where: "record.email == trigger.email" },
  filter: { id: "open", kind: "filter", from: "steps.who.rows", where: "record.status == \"Open\"" },
  create: { id: "make", kind: "create", type: "matter", set: { client: { expr: "trigger.client" }, stage: "Intake" } },
  update: { id: "mark", kind: "update", type: "matter", record: { expr: "steps.make.record.id" }, set: { stage: "Active" } },
  upsert: { id: "save", kind: "upsert", type: "client", match: { email: { expr: "trigger.email" } }, set: { name: { expr: "trigger.name" } } },
  remove: { id: "drop", kind: "remove", type: "matter", record: { expr: "steps.make.record.id" } },
  decide: { id: "big", kind: "decide", if: "trigger.amount > 1000", then: [{ id: "alert", kind: "assign", to: "role:partner", title: "Large payment", output: { kind: "note" } }], else: [] },
  repeat: { id: "each", kind: "repeat", over: "steps.who.rows", as: "row", max: 50, steps: [{ id: "tag", kind: "update", type: "client", record: { expr: "row.id" }, set: { tagged: true } }] },
  parallel: { id: "both", kind: "parallel", steps: [{ id: "left", kind: "branch", steps: [{ id: "mail", kind: "create", type: "matter", set: { client: "A" } }] }, { id: "right", kind: "branch", steps: [{ id: "note", kind: "create", type: "matter", set: { client: "B" } }] }] },
  branch: { id: "left", kind: "branch", steps: [{ id: "mail", kind: "create", type: "matter", set: { client: "A" } }] },
  subflow: { id: "welcome", kind: "subflow", flow: "send_welcome", input: { client: { expr: "trigger.client" } } },
  wait: { id: "pause", kind: "wait", for_ms: 3_600_000 },
  ask: { id: "yes", kind: "ask", to: "role:partner", title: "Send the welcome email?" },
  assign: { id: "task", kind: "assign", to: "teammate:paralegal", title: "Draft the engagement letter", output: { kind: "draft" } },
  call: { id: "mail", kind: "call", action: "email.send", resource: "vyre://space/email/outbox", input: { to: { expr: "trigger.email" }, subject: "Welcome" } },
  stage: { id: "move", kind: "stage", type: "matter", record: { expr: "steps.make.record.id" }, to: "Active" },
  agent: { id: "draft", kind: "agent", assistant: "teammate:paralegal", title: "Summarise the file", instructions: "Read the file and write a short summary.", output: { kind: "note" } },
  classify: { id: "kind", kind: "classify", input: { expr: "trigger.message" }, labels: ["new client", "existing client", "spam"] },
  extract: { id: "facts", kind: "extract", input: { expr: "trigger.message" }, fields: [{ name: "phone", kind: "text" }] },
  service: { id: "crm", kind: "service", connection: "orbit-crm", operation: "customers.list", input: { limit: 1 } },
  fn: { id: "calc", kind: "fn", language: "js", source: "return { total: inputs.a + inputs.b };", inputs: { a: 1, b: { expr: "trigger.amount" } }, outputs: ["total"] },
});

/** Trigger examples. @type {Record<string, any>} */
const TRIGGER_EXAMPLES = Object.freeze({
  event: { on: "event", event: "payment.received", where: "trigger.amount > 0" },
  stage: { on: "stage", type: "matter", stage: "Intake" },
  time: { on: "time", cron: "0 9 * * 1-5" },
  web: { on: "web", path: "intake" },
  manual: { on: "manual" },
  watcher: { on: "watcher", watcher: "new-mail" },
});

const oneLine = (/** @type {any} */ step) => printLines({ steps: [step] }).split("\n").slice(1).filter(Boolean).map(l => l.slice(2)).join("\n    ");
const ms = (/** @type {number} */ n) => (n >= 60_000 ? `${n / 60_000} min` : `${n / 1000} s`);

/** The cheat sheet, as text. */
export function cheatsheet() {
  /** @type {string[]} */ const out = [];
  out.push("# Flows cheat sheet", "", "A Flow is a trigger and steps. Write it in the lines form (flows.code format lines; flows.patch edits it). Names a step makes are read as `steps.<id>`; the trigger as `trigger`; a failure path reads `error`; a check reads `output`.", "");
  out.push("## Shape", "```", "name: my_flow", "authorship: model", "trigger: {on: event, event: payment.received}", "steps:", "  who find type=client where=`record.email == trigger.email`", "  mark update type=client record=`steps.who.rows[0].id` set={tagged: true}", "on_failure:", "  tell assign to=role:partner title=\"A run failed\" output={kind: note}", "```", "A `key=value` value is a word, number, \"string\", [list], {key: value}, or a `backtick expression`. Optional keys: label, description, caps, concurrency, lock, stuck_after_ms, on_failure. In `if`, `where`, `over`, `from` and `check` the whole value is expression text; inside `set`, `match`, `input` and the like a value is a plain value, or a `backtick expression` to compute it.", "");
  out.push("## Triggers", ...Object.values(TRIGGER_REGISTRY).map(t => `- ${t.on.join(" | ")}: keys ${t.keys.join(", ")}; reads ${t.scope.join(", ")}${TRIGGER_EXAMPLES[t.on[0]] ? `; e.g. \`${JSON.stringify(TRIGGER_EXAMPLES[t.on[0]]).replace(/"/g, "")}\`` : ""}`), "");
  out.push("## Steps (id kind key=value; each also takes timeout_ms, retry, on_fail, verify unless it says otherwise)");
  for (const kind of STEP_KINDS) {
    const keys = /** @type {Record<string, string[]>} */ (STEP_KEYS)[kind] || [];
    // the default policy keys are said once above; a step that takes fewer says which
    const policy = kind === "branch" ? "no policy keys (its steps have their own)" : BLOCK_KINDS[/** @type {keyof typeof BLOCK_KINDS} */ (kind)] || kind === "subflow" ? "only on_fail, verify" : kind === "wait" ? "no timeout_ms" : "";
    out.push(`- ${kind}: ${keys.join(", ")}${policy ? `; ${policy}` : ""}`, `    ${EXAMPLES[kind] ? oneLine(EXAMPLES[kind]) : ""}`);
  }
  out.push("", "## Lanes, other Flows, schedules");
  out.push("- `parallel`: lanes (2 to 8 `branch` steps) run together; the next step waits for all and reads any lane's step as `steps.<id>` (lanes cannot read each other). A failed lane fails the step; a retry reruns only it.");
  out.push("- `subflow flow=<name> input={...}` runs another active Flow; its top-level `returns` is `steps.<id>.result`.");
  out.push("- `call` step `with=<earlier send step>`: this send rides that step's yes (one question names both; the earlier tool must list this one in its `covers`; same path, not out of a loop or lane).");
  out.push("- A time trigger: `hours=true` (weekdays 9 to 17) or `{days, from, to}`; `holidays=[dates]` or `space`; `catch_up=once|all|skip` after downtime.");
  out.push("", "## If it can fail");
  out.push(`- timeout_ms ${POLICY_LIMITS.timeoutMin}-${POLICY_LIMITS.timeoutMax}; retry false | {attempts 1-${POLICY_LIMITS.attempts}, backoff_ms n | [n...], on [${RETRY_CODES.join(", ")}]}. Defaults: ${Object.entries(POLICY).map(([k, p]) => `${k} ${ms(/** @type {any} */ (p).timeout_ms)} x${/** @type {any} */ (p).attempts}`).join(", ")}; other kinds do not retry. A refusal is never retried.`);
  out.push("- on_fail={then: continue|stop, steps}: steps run if this one fails for good (they read `error.code`, `error.message`, `error.step`); `continue` carries on, `stop` (default) fails the run after them. No on_fail inside an on_fail.");
  out.push("- verify={check: `output.record`, essential: true|false, say: \"what was checked\"} or {readback: true} on create, update, upsert, stage. Put an essential verify on every step that changes something.", "");
  out.push("## Expressions", `- Read: trigger, steps.<id>, run, now, the loop name in a repeat, error in a failure path, output in a check. Operators: == != < <= > >= && || ! + - * / %, a ? b : c, a.b, a[0].`);
  out.push("- An event a module emits (documents.signed, comms.sent) keeps its facts under `payload`: `trigger.payload.<fact>`, and in a wait's where `event.data.payload.<fact>`.");
  out.push(`- Functions: ${Object.keys(FUNCTIONS).join(", ")}. Nothing else is callable.`, "");
  out.push("## Limits", `- ${LIMITS.steps} steps a Flow, ${LIMITS.depth} levels of nesting, repeat at most ${LIMITS.repeatMax}, a Code step's source at most ${LIMITS.codeSource / 1024} KB. Step ids: lowercase letters, digits, underscores, starting with a letter.`);
  out.push("- A resource is a written-out vyre:// address. A sealed field cannot be written by a Flow. Nothing runs until a person approves the version; flows.propose checks it and runs its test cases first.");
  return out.join("\n") + "\n";
}
