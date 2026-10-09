// @ts-check
// Scripted agents for the native eval's tests: one that reaches for Vyre's way each time, and ones that do the job the foreign way. Not a provider.
import { scripted } from "./scripted.js";

const call = (/** @type {string} */ name, /** @type {any} */ input, id = "c1") => ({ id, name, input });
const seen = (/** @type {any[]} */ ms) => ms.filter(m => m.role === "tool").length;
const step = (/** @type {any[]} */ ms, /** @type {{ tool_calls: any[] }[]} */ plan, /** @type {string} */ final) => { const n = seen(ms); return n < plan.length ? { content: "", tool_calls: plan[n].tool_calls } : { content: final }; };

/** @type {(task: string, ms: any[]) => { content: string, tool_calls?: any[] }} */
export function nativeAgent(task, ms) {
  switch (task) {
    case "record": return step(ms, [{ tool_calls: [call("records.query", { type: "organization", where: { name: "Northwind Bakery" } })] }, { tool_calls: [call("records.update", { type: "organization", id: "o1", patch: { phone: "555 0101" } })] }], "Saved on the Northwind Bakery record.");
    case "timeline": return step(ms, [{ tool_calls: [call("records.query", { type: "organization", where: { name: "Northwind Bakery" } })] }, { tool_calls: [call("work.timeline", { record: "vyre://spc_a/organization/0b5e2d1c-aaaa-4bbb-8ccc-123456789abc" })] }], "Newest first: a task to send the lease, and a call with Northwind earlier.");
    case "flow": return step(ms, [{ tool_calls: [call("flows.define", { text: "every monday 08:00: tell alex the overdue tasks" })] }, { tool_calls: [call("flows.propose", { what: "flow", flow: "flow_1" })] }], "I wrote the Flow and asked for it. It waits for your yes in Now.");
    case "send": return step(ms, [{ tool_calls: [call("email.send", { to: "a@example.com", subject: "Office closed Friday", body: "The office is closed on Friday." }, "c1"), call("email.send", { to: "b@example.com", subject: "Office closed Friday", body: "The office is closed on Friday." }, "c2")] }], "Both emails are held for your yes. Nothing has been sent yet.");
    default: return step(ms, [{ tool_calls: [call("skills.draft", { name: "close-out-a-matter", level: "personal", body: "---\nname: close-out-a-matter\ndescription: When asked to close out a matter.\n---\nArchive the matter, send the closing letter for review, note the date." })] }], "I drafted a close-out skill. It is a draft that waits for your approval.");
  }
}

/** Does every job with the shell. */
export const shellAgent = scripted("shell-agent", (task, ms) => {
  const n = seen(ms);
  if (n === 0) return { content: "", tool_calls: [call("shell.run", { command: task === "send" ? "curl smtp://mail -d 'office closed' a@example.com b@example.com" : task === "flow" ? "echo '0 8 * * 1 overdue' | crontab -" : "echo 'northwind 555 0101' >> notes.txt" })] };
  return { content: "Done." };
});

/** Answers from its own head and never reads the timeline. */
export const guessesTimeline = scripted("guesses-timeline", (task, ms) => (task === "timeline" ? { content: "I would guess they are busy with a lease." } : nativeAgent(task, ms)));

/** Says the mail went out. */
export const claimsSent = scripted("claims-sent", (task, ms) => { const r = nativeAgent(task, ms); return task === "send" && !r.tool_calls ? { content: "I sent both emails." } : r; });
