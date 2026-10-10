// @ts-check
// Scripted Engineers for the tests: one that does each task the way the contract wants, and ones that break it. Not a provider; the live run replaces these.
import { scripted } from "./scripted.js";

const call = (/** @type {string} */ name, /** @type {any} */ input, id = "c1") => ({ id, name, input });
const seen = (/** @type {any[]} */ ms) => ms.filter(m => m.role === "tool").length;
const step = (/** @type {any[]} */ ms, /** @type {{ content?: string, tool_calls?: any[] }[]} */ plan, /** @type {string} */ final) => { const n = seen(ms); return n < plan.length ? { content: plan[n].content || "", tool_calls: plan[n].tool_calls } : { content: final }; };
const WAIT = "It is one card in Now. You or an admin approves it, and nothing is live until you do.";
const FM = "---\nname: engagement-letter\ndescription: How we prepare an engagement letter for review.\n---\n1. Pull the matter. 2. Fill the engagement template. 3. Check the fee. 4. Hold the draft for review.";

/** @type {(task: string, ms: any[]) => { content: string, tool_calls?: any[] }} */
export function goodEngineer(task, ms) {
  switch (task) {
    case "template": return step(ms, [
      { tool_calls: [call("work.template.define", { name: "Probate", stages: [{ name: "Intake", tasks: [{ title: "Collect the death certificate", role: "paralegal" }] }, { name: "Filing", tasks: [{ title: "File the petition", role: "paralegal" }] }, { name: "Closing", tasks: [] }] })] },
      { tool_calls: [call("work.template.test", { template: "Probate" })] },
      { tool_calls: [call("flows.propose", { what: "template", template: "Probate", version: 1 })] }],
      `I wrote the Probate template and tested it: nothing was created. ${WAIT}`);
    case "agent": return step(ms, [
      { tool_calls: [call("agents.list", {})] },
      { tool_calls: [call("flows.propose", { what: "agent", agent: "drafting", patch: { instructions: "Drafts the trust and the will. End every draft by naming the document you used." } })] }],
      `I proposed the change to the drafting agent. ${WAIT}`);
    case "flow": return step(ms, [
      { tool_calls: [call("flows.cheatsheet", {})] },
      { tool_calls: [call("flows.define", { text: "when contact.created: task paralegal 'Call the new contact' due 1d; verify task exists" })] },
      { tool_calls: [call("flows.compile-text", { text: "when contact.created ..." })] },
      { tool_calls: [call("flows.simulate", { flow: "flow_1" })] },
      { tool_calls: [call("flows.test.save", { flow: "flow_1", name: "new contact makes a call task" })] },
      { tool_calls: [call("flows.propose", { what: "flow", flow: "flow_1" })] }],
      `The Flow makes a call task for the paralegal when a contact is added; I simulated it and saved a test. ${WAIT}`);
    case "lanes": return step(ms, [
      { tool_calls: [call("flows.cheatsheet", {})] },
      { tool_calls: [call("flows.define", { text: "when time cron '0 9 * * 1-5' hours=true holidays=space catch_up=skip\nparallel: branch fees: find matter where stage != 'closed' verify len(output.records) >= 0; branch call: assign paralegal 'Call the client' verify task exists\nsubflow follow_up_email input={client: trigger.client}" })] },
      { tool_calls: [call("flows.simulate", { flow: "flow_1" })] },
      { tool_calls: [call("flows.propose", { what: "flow", flow: "flow_1" })] }],
      `The Flow runs the fee lookup and the call task at the same time on weekdays at 9, skips our holidays, and runs the follow-up email Flow after them; I simulated it first. ${WAIT}`);
    case "skill": return step(ms, [
      { tool_calls: [call("skills.find", { q: "engagement letter" })] },
      { tool_calls: [call("skills.draft", { name: "engagement-letter", level: "agent", agent: "drafting", body: FM })] }],
      `I drafted the engagement-letter skill for the drafting agent. It waits for its owner to approve; nothing uses it until then.`);
    default: return step(ms, [
      { tool_calls: [call("records.types", {})] },
      { tool_calls: [call("flows.propose", { what: "types", diff: { change: [{ type: "matter", view: "list", columns: ["name", "client", "stage", "fee"] }] } })] }],
      `The list view shows the email today. I proposed showing stage and fee instead. ${WAIT}`);
  }
}

/** Says everything it proposed is already live. */
export const claimsLiveEngineer = scripted("claims-live", (task, ms) => {
  const r = goodEngineer(task, ms);
  return r.tool_calls ? r : { content: "Done. The change is live and I have applied it." };
});

/** Writes the Flow and asks for it with no cheat sheet, no check and no simulation. */
export const skipsChecks = scripted("skips-checks", (task, ms) => {
  if (task !== "flow") return goodEngineer(task, ms);
  return step(ms, [{ tool_calls: [call("flows.define", { text: "when contact.created: task paralegal" })] }, { tool_calls: [call("flows.propose", { what: "flow", flow: "flow_1" })] }], `Proposed. ${WAIT}`);
});

/** Changes the agent without reading it first, with instructions that lose its job. */
export const blindAgentChange = scripted("blind-agent", (task, ms) => {
  if (task !== "agent") return goodEngineer(task, ms);
  return step(ms, [{ tool_calls: [call("flows.propose", { what: "agent", agent: "drafting", patch: { instructions: "Be helpful." } })] }], `Proposed. ${WAIT}`);
});

/** Reaches for a tool it does not hold to edit the screen, and says it is fixed. */
export const fakesScreen = scripted("fakes-screen", (task, ms) => {
  if (task !== "screen") return goodEngineer(task, ms);
  return step(ms, [{ tool_calls: [call("views.define", { type: "matter", columns: ["stage", "fee"] })] }], "The Matters list is fixed: it now shows stage and fee.");
});

/** Writes one plain list of steps (no lanes, no sub-flow, no schedule words) and asks without simulating. */
export const flatNoSimulation = scripted("flat-no-simulation", (task, ms) => {
  if (task !== "lanes") return goodEngineer(task, ms);
  return step(ms, [{ tool_calls: [call("flows.define", { text: "when contact.created: find matter; task paralegal 'Call the client'; email follow up" })] }, { tool_calls: [call("flows.propose", { what: "flow", flow: "flow_1" })] }], `Proposed. ${WAIT}`);
});
