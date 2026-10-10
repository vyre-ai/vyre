// @ts-check
// Fixtures for contracts/approvals.md (team/contracts/approvals.md). A consumer (chat's Needs-you list, design's cards, projects-flows' Now) builds against these while link keeps the queue: `owners` are the rows
// each owner holds, `cards` what the one queue makes of them. test/contracts/approvals.test.js runs the real mappers over `owners` and a real daemon, so a fixture that drifts from the producer fails there.
export { shapeDiff } from "./operator-cards.fixtures.js";

export const owners = {
  ask: { id: "ask1", kind: "permission", tool: "Bash", summary: "Run npm test", thread: "thr_1", thread_name: "Fix the build", agent: "kit", project: "website", at: 1760000000000, source: "box" },
  question: { id: "ask2", kind: "question", summary: "", questions: [{ question: "Which environment?", header: "Env", multiSelect: false, options: [{ label: "Staging" }, { label: "Production", description: "live" }] }], thread: "thr_1", thread_name: "Deploy", agent: "kit", at: 1760000000100 },
  mac: { id: "ask3", kind: "permission", tool: "Edit", thread: "thr_2", thread_name: "Notes", source: "mac", machine: "Office Mac", at: 1760000000200 },
  held: { id: "g1", kind: "send", via: "mail", to: ["dana@example.com"], summary: "Re: retainer", agent: "kit", thread: "thr_1", project: "website", at: 1760000000300 },
  vault: { grants: [{ id: "g_1", name: "billing-key", module: "mail", watcher: "digest", by: "mcp", at: 1760000000400 }] },
  attention: { run: "run_1", kind: "failed", label: "Welcome sequence", step_label: "Send email", message: "The mail server refused the message", since: 1760000000500 },
  gate: { run: "run_2", gate: true, label: "Engagement letter", since: 1760000000600 },
  stuck: { task: "t_1", label: "Collect the signed retainer", reason: "Waiting on the client", since: 1760000000700 },
  health: { total: 3, rotate: 1, fix: 2 },
  eval: { model: "claude-x", label: "Claude X", state: "pending", price_known: true, total_usd: 1.5, types: ["a", "b"], at: 1760000000800 },
};

/** One card of each kind, as `approvals.items` lists it. `answer` names the OWNER's tool that settles the card; `fill` names the values the screen still asks the person for. */
export const cards = {
  ask: { id: "threads:ask1", kind: "ask", title: "Run npm test", detail: "kit in Fix the build", project: "website", thread: "thr_1", at: 1760000000000, source: "threads",
    facts: { id: "ask1", kind: "permission", tool: "Bash", summary: "Run npm test", thread: "thr_1", thread_name: "Fix the build", agent: "kit", project: "website", at: 1760000000000, source: "box" },
    answer: { tool: "threads.answer", input: { ask: "ask1" }, fill: ["decision"] } },
  question: { id: "threads:ask2", kind: "ask", title: "Which environment?", detail: "kit in Deploy", thread: "thr_1", at: 1760000000100, source: "threads",
    facts: { id: "ask2", kind: "question", summary: "", thread: "thr_1", thread_name: "Deploy", agent: "kit", at: 1760000000100,
      questions: [{ question: "Which environment?", header: "Env", multiSelect: false, options: [{ label: "Staging" }, { label: "Production", description: "live" }] }] },
    answer: { tool: "threads.answer", input: { ask: "ask2" }, fill: ["decision", "answers"] } },
  askOnAMac: { id: "threads:ask3", kind: "ask", title: "Allow Edit?", detail: "Notes", thread: "thr_2", machine: "Office Mac", at: 1760000000200, source: "threads",
    facts: { id: "ask3", kind: "permission", tool: "Edit", thread: "thr_2", thread_name: "Notes", at: 1760000000200, source: "mac", machine: "Office Mac" },
    answer: { tool: null, input: null, fill: [], on: "Office Mac" } },
  draft: { id: "gate:g1", kind: "draft", title: "Re: retainer", detail: "mail to dana@example.com", project: "website", thread: "thr_1", at: 1760000000300, source: "gate",
    facts: { id: "g1", kind: "send", via: "mail", to: ["dana@example.com"], summary: "Re: retainer", agent: "kit", thread: "thr_1", project: "website", at: 1760000000300 },
    answer: { tool: "gate.approve", input: { id: "g1" }, fill: [] } },
  access: { id: "vault:g_1", kind: "access", title: 'Let mail/digest use "billing-key"', detail: "asked by mcp", at: 1760000000400, source: "vault", answer: { tool: "vault.approve", input: { id: "g_1" }, fill: [] } },
  run: { id: "flows:run_1", kind: "run", title: "Welcome sequence stopped at Send email", detail: "The mail server refused the message", at: 1760000000500, source: "flows",
    answer: { tool: "flows.settle", input: { run: "run_1" }, fill: ["action"], choices: ["retry", "skip", "stop"] } },
  gate: { id: "flows:run_2", kind: "run", title: "Engagement letter is held", at: 1760000000600, source: "flows", answer: { tool: "flows.settle", input: { run: "run_2", action: "advance" }, fill: ["reason"] } },
  task: { id: "tasks:t_1", kind: "task", title: "Collect the signed retainer is stuck", detail: "Waiting on the client", at: 1760000000700, source: "flows",
    answer: { tool: "tasks.move", input: { id: "t_1" }, fill: ["to", "reason"], choices: ["ready", "skipped"] } },
  health: { id: "vault:health", kind: "health", title: "3 vault items need attention", detail: "1 to rotate, 2 to fix", at: 0, source: "vault-health", facts: { rotate: 1, fix: 2 },
    answer: { tool: "vault.health.dismiss", input: { days: 7 }, fill: [] },
    answers: [{ label: "Rotate", open: "/u/vault" }, { label: "Fix", open: "/u/vault" }, { label: "Dismiss", tool: "vault.health.dismiss", input: { days: 7 }, fill: [] }] },
  eval: { id: "models:claude-x", kind: "eval", title: "New model Claude X: run evals?", detail: "2 evals, about $1.50 in all", at: 1760000000800, source: "models",
    answer: { tool: "models.eval-approve", input: { model: "claude-x" }, fill: ["evals"] }, decline: { tool: "models.eval-decline", input: { model: "claude-x" } } },
  /** A yes waiting on the phone (a vault reveal, a pairing, an outward call from an agent): the queue's own card. The phone signs it (see `pending`). */
  approval: { id: "ap_01a12328-33b9-4708-8430-e35ce6a2454f", kind: "approval", title: 'A device wants to show "stripe" from your vault', at: 1760000000900, source: "approvals", answer: { tool: "approvals.answer", input: { id: "ap_01a12328-33b9-4708-8430-e35ce6a2454f" }, fill: ["yes"] } },
};

/** What `approvals.items` adds to every waiting card for the calling device: whether answering takes a proof (a yes, a draft that sends, access to a secret) and whether the device already has a live presence session (a covered device answers a swipe at once). `recent` cards carry none. */
export const itemPresence = { required: true, covered: false, since: null };

/** `approvals.items`, whole: the cards waiting, and the ones settled in the last ten minutes with what became of them. */
export const itemsAnswer = { items: [cards.approval, cards.draft], recent: [{ ...cards.access, state: "settled", outcome: "settled", settled_at: 1760000001000 }] };

/** What `approvals.pending` lists for the phone: the exact request a yes is signed over. `sign` is what the key signs; nothing else. */
export const pendingCard = {
  id: "ap_01a12328-33b9-4708-8430-e35ce6a2454f", title: "task.vault_use", body: "Approve with Face ID on this phone, or say no and nothing changes.", op: "task.vault_use", space: "spc_tzw2zlaob7zz",
  fields: { what: "vault.reveal", fields: { name: "stripe" } }, payload_hash: "uOviJi1HVVikyEbMc8kiLf0YeXwPmTXslxZferl4jFc", asked_from: "cli", expires_in_s: 300,
  moment: "vault", request: { op: "vault.reveal", fields: { name: "stripe" } }, line: 'A device wants to show "stripe" from your vault',
  sign: { op: "task.vault_use", space: "spc_tzw2zlaob7zz", fields: { what: "vault.reveal", fields: { name: "stripe" } } },
};

export const kinds = ["approval", "ask", "draft", "access", "run", "task", "eval", "health"];
export const limits = { askMinutes: 5, openCards: 5, groupSeconds: 90, groupMax: 20, recentMinutes: 10, recentMax: 50, titleMax: 120, detailMax: 160 };
