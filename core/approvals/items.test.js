// @ts-check
// approvals items: what the owners hold becomes cards in the one queue. The mapping of the vault's pending requests (names only, never a value) and a card's life: held, settled with an outcome.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createItems, fromVault, fromHeld } from "./items.js";

const wait = ms => new Promise(r => setTimeout(r, ms));

test("fromVault: every kind of pending request is an access card answered by vault.approve, with names and never a value", () => {
  const rows = fromVault({
    grants: [{ id: "g_1", name: "billing-key", module: "mail", watcher: "digest", by: "mcp", at: 5 }],
    agentGrants: [{ id: "ag_1", item: "bank-login", agent: "kit", origin: "https://bank.example", by: "mcp", at: 4 }],
    passes: [{ id: "p_1", holder: "dana", items: ["billing-key", "wifi"], mode: "relayed", by: "mcp", created: 3 }],
    people: [{ id: "s_1", name: "alex", fingerprint: "ab12cd", at: 2 }],
    accepts: [{ id: "s_2", owner: "dana", items: ["billing-key"], at: 1 }],
  });
  assert.deepEqual(rows.map(r => r.id), ["vault:g_1", "vault:ag_1", "vault:p_1", "vault:s_1", "vault:s_2"]);
  assert.ok(rows.every(r => r.kind === "access" && r.source === "vault" && r.answer.tool === "vault.approve" && r.answer.input.id === r.id.slice(6)));
  assert.equal(rows[0].title, 'Let mail/digest use "billing-key"');
  assert.equal(rows[1].title, 'Let agent kit use "bank-login" at https://bank.example');
  assert.equal(rows[2].title, 'Share "billing-key", "wifi" with dana'.replace(/"/g, "").replace("billing-key, wifi", "billing-key, wifi"));
  assert.deepEqual(fromVault({}), []);
  assert.deepEqual(fromVault(null), []);
});

test("a card is rebuilt from the owner's list, closes with the outcome the owner's event gave, and an unreadable owner is named and its cards kept", async () => {
  /** @type {any} */ const world = { held: [{ id: "g1", kind: "send", via: "mail", to: ["dana@example.com"], summary: "Re: retainer", at: 9 }], broke: false };
  /** @type {Map<string, (e: any) => void>} */ const handlers = new Map();
  /** @type {any[]} */ const said = [];
  const items = createItems({
    now: () => Date.now(),
    call: async tool => {
      if (tool === "gate.held") { if (world.broke) throw new Error("down"); return { data: world.held }; }
      if (tool === "threads.asks") return { data: [] };
      if (tool === "flows.attention") return { data: { runs: [] } };
      if (tool === "models.evals") return { data: { evals: [] } };
      return { error: { code: "unknown_tool" } };
    },
    on: (pattern, fn) => { handlers.set(pattern, fn); return () => handlers.delete(pattern); },
    emit: (type, payload) => said.push({ type, payload }),
  });
  const first = await items.list();
  assert.deepEqual(first.items.map(i => i.id), ["gate:g1"]);
  assert.deepEqual(first.partial, ["vault"], "the vault answered with an error: named, nothing invented");
  assert.deepEqual(fromHeld(world.held)[0], first.items[0].state ? { ...first.items[0], state: undefined } && fromHeld(world.held)[0] : first.items[0]);

  world.broke = true;
  assert.deepEqual((await items.list()).items.map(i => i.id), ["gate:g1"], "an owner that cannot be read keeps its cards");
  world.broke = false;

  world.held = [];
  /** @type {any} */ (handlers.get("gate.*"))({ type: "gate.rejected", payload: { id: "g1" } });
  await wait(400);
  const after = await items.list();
  assert.deepEqual(after.items, []);
  assert.equal(after.recent[0].id, "gate:g1");
  assert.equal(after.recent[0].outcome, "refused");
  assert.ok(said.some(s => s.type === "approvals.changed"));
  await items.stop();
  assert.equal(handlers.size, 0, "stopping lets go of every event");
});

test("fromAttention: a failed run is one `run` card answered by flows.settle (retry, skip, stop); a stale one is quiet and only stops; a gate moves on with a reason", async () => {
  const { fromAttention } = await import("./items.js");
  const rows = fromAttention([
    { run: "run_1", flow: "fl_1", label: "Welcome", kind: "failed", step: "mail", step_label: "the email", message: "the Acme connection answered 503 three times", since: 5, loud: true },
    { run: "run_2", flow: "fl_1", label: "Welcome", kind: "stale", step: "ask", step_label: "the yes", message: "a person has not answered yet", since: 4, loud: false },
    { run: "run_3", flow: "gate:matter:Intake", label: "Stage gate: matter Intake", kind: "stuck", step: "tasks", step_label: "tasks", message: "a task of Intake is stuck", since: 3, loud: true, gate: true },
  ]);
  assert.deepEqual(rows.map(r => [r.id, r.kind, r.source]), [["flows:run_1", "run", "flows"], ["flows:run_2", "run", "flows"], ["flows:run_3", "run", "flows"]]);
  assert.equal(rows[0].title, "Welcome stopped at the email");
  assert.equal(rows[0].detail, "the Acme connection answered 503 three times");
  assert.deepEqual(rows[0].answer, { tool: "flows.settle", input: { run: "run_1" }, fill: ["action"], choices: ["retry", "skip", "stop"] });
  assert.equal(rows[1].quiet, true);
  assert.deepEqual(rows[1].answer.choices, ["stop"]);
  assert.equal(rows[2].title, "Stage gate: matter Intake is held");
  assert.deepEqual(rows[2].answer, { tool: "flows.settle", input: { run: "run_3", action: "advance" }, fill: ["reason"] });
  assert.equal(rows[0].quiet, undefined);
  assert.deepEqual(fromAttention([]), []);
});

test("a run card opens when the owner lists it and closes with an outcome when the run is retried or stopped", async () => {
  /** @type {any} */ const world = { runs: [{ run: "run_9", flow: "fl_1", label: "Welcome", kind: "failed", step: "mail", step_label: "the email", message: "boom", since: 1, loud: true }] };
  /** @type {Map<string, (e: any) => void>} */ const handlers = new Map();
  const items = createItems({
    now: () => Date.now(),
    call: async tool => (tool === "flows.attention" ? { data: { runs: world.runs } } : { data: [] }),
    on: (pattern, fn) => { handlers.set(pattern, fn); return () => handlers.delete(pattern); },
  });
  const first = await items.list();
  assert.deepEqual(first.items.filter((/** @type {any} */ x) => x.kind === "run").map((/** @type {any} */ x) => x.id), ["flows:run_9"]);
  world.runs = [];
  /** @type {any} */ (handlers.get("flow.*"))({ type: "flow.cancelled", payload: { run: "run_9" } });
  await wait(300);
  const after = await items.list();
  assert.equal(after.items.filter((/** @type {any} */ x) => x.kind === "run").length, 0);
  const closed = after.recent.find((/** @type {any} */ x) => x.id === "flows:run_9");
  assert.equal(closed.outcome, "stopped");
  await items.stop();
});

test("R031-45: a stuck task is one `task` card with its reason, answered by tasks.move, and it closes when the task is unblocked", async () => {
  const { fromStuckTasks } = await import("./items.js");
  const rows = fromStuckTasks([{ task: "t1", label: "Send the engagement letter", reason: "the client has no email on file", since: 7 }]);
  assert.deepEqual(rows.map(r => [r.id, r.kind, r.title, r.detail]), [["tasks:t1", "task", "Send the engagement letter is stuck", "the client has no email on file"]]);
  assert.deepEqual(rows[0].answer, { tool: "tasks.move", input: { id: "t1" }, fill: ["to", "reason"], choices: ["ready", "skipped"] });
  /** @type {any} */ const world = { tasks: [{ task: "t1", label: "Send the engagement letter", reason: "no email", since: 7 }] };
  /** @type {Map<string, (e: any) => void>} */ const handlers = new Map();
  const items = createItems({ now: () => Date.now(), call: async tool => (tool === "flows.attention" ? { data: { runs: [], tasks: world.tasks } } : { data: [] }), on: (p, fn) => { handlers.set(p, fn); return () => handlers.delete(p); } });
  assert.deepEqual((await items.list()).items.filter((/** @type {any} */ x) => x.kind === "task").map((/** @type {any} */ x) => x.id), ["tasks:t1"]);
  world.tasks = [];
  /** @type {any} */ (handlers.get("task.*"))({ type: "task.unblocked", payload: { task: "t1" } });
  await wait(300);
  const after = await items.list();
  assert.equal(after.items.filter((/** @type {any} */ x) => x.kind === "task").length, 0);
  assert.equal(after.recent.find((/** @type {any} */ x) => x.id === "tasks:t1").outcome, "unblocked");
  await items.stop();
});

test("R031-87: a new model's pending evals are one `eval` card with a cost from its price (or the cost unknown), answered by models.eval-approve, declined by models.eval-decline; settled ones are not cards", async () => {
  const { fromEvals } = await import("./items.js");
  const rows = fromEvals([
    { model: "codex/gpt-5.5", label: "GPT-5.5", state: "pending", price_known: true, total_usd: 7.5, types: [{ id: "a" }, { id: "b" }], at: 5 },
    { model: "grok/grok-5", label: "grok-5", state: "pending", price_known: false, total_usd: null, types: [{ id: "a" }], at: 4 },
    { model: "claude/x", state: "approved", types: [], at: 3 },
  ]);
  assert.deepEqual(rows.map(r => [r.id, r.kind, r.title, r.detail]), [
    ["models:codex/gpt-5.5", "eval", "New model GPT-5.5: run evals?", "2 evals, about $7.50 in all"],
    ["models:grok/grok-5", "eval", "New model grok-5: run evals?", "1 evals; the cost is unknown (no price for this model yet)"],
  ]);
  assert.deepEqual(rows[0].answer, { tool: "models.eval-approve", input: { model: "codex/gpt-5.5" }, fill: ["evals"] });
  assert.deepEqual(rows[0].decline, { tool: "models.eval-decline", input: { model: "codex/gpt-5.5" } });
});

test("R031-80s: the vault's health is one calm row of counts, never a row per item, and none when nothing needs attention", async () => {
  const { fromHealth } = await import("./items.js");
  assert.deepEqual(fromHealth({ total: 0 }), []);
  assert.deepEqual(fromHealth(null), []);
  const [row, ...more] = fromHealth({ total: 5, rotate: 2, fix: 3, counts: { rotate: 2, reused: 3 } });
  assert.equal(more.length, 0);
  assert.equal(row.title, "5 vault items need attention");
  assert.equal(row.detail, "2 to rotate, 3 to fix");
  assert.deepEqual(row.answers.map((/** @type {any} */ a) => a.label), ["Rotate", "Fix", "Dismiss"]);
  assert.equal(fromHealth({ total: 1, rotate: 1, fix: 0 })[0].title, "1 vault item needs attention");
  assert.deepEqual(fromHealth({ total: 1, rotate: 1, fix: 0 })[0].answers.map((/** @type {any} */ a) => a.label), ["Rotate", "Dismiss"]);
  assert.ok(JSON.stringify(row).includes("password") === false && !JSON.stringify(row).includes("name"), "counts only");
});

test("a document waiting for a signature is one quiet `signing` card naming the signer, answered by a reminder, with no link or code on it, and it closes when the owner stops listing it", async () => {
  const { fromSigning, OWNERS } = await import("./items.js");
  const rows = fromSigning([
    { submission: 4411, signer: "Dana Harlow", email: "dana@harlow.test", template: "Engagement letter", at: 5, slug: "abc123", url: "https://documents.harlow.vyre.run/sign/4411/abc123" },
    { submission: 4412, signer: "", email: "sam@harlow.test", template: "", at: 4 },
    { signer: "no id" },
  ]);
  assert.deepEqual(rows.map(r => [r.id, r.kind, r.title, r.detail, r.quiet]), [
    ["documents:4411", "signing", "Dana Harlow has not signed Engagement letter", "Sent to dana@harlow.test", true],
    ["documents:4412", "signing", "sam@harlow.test has not signed the document", undefined, true],
  ]);
  assert.deepEqual(rows[0].answer, { tool: "documents.signing.remind", input: { submission: 4411 }, fill: [] });
  assert.ok(!JSON.stringify(rows).includes("abc123") && !JSON.stringify(rows).includes("/sign/"), "no signer's code and no link on a card");
  // it is one of the owners, quiet when Documents is not there, and the signature's own event says why it closed
  const owner = OWNERS.find(o => o.name === "documents");
  assert.ok(owner && /** @type {any} */ (owner).quiet && owner.tool === "documents.signing.waiting");
  assert.deepEqual(owner.map({ requests: [{ submission: 9, signer: "A", email: "a@b.test", template: "T", at: 1 }] }).map((/** @type {any} */ r) => r.id), ["documents:9"]);
  assert.deepEqual(owner.map(null), []);
  const hint = owner.watch[0][1];
  assert.deepEqual(hint && hint("documents.signed", { submission: 9 }), ["documents:9", "signed"]);
  assert.deepEqual(hint && hint("documents.declined", { submission: 9 }), ["documents:9", "declined"]);
  assert.equal(hint && hint("documents.sent", { submission: 9 }), null);
});

test("R031-79: a website Connection that waits for a person is one `signin` card that says what to do; a box opens the agent's computer, a stopped account can be resumed, and nothing else is a card", async () => {
  const { fromSignIn, OWNERS } = await import("./items.js");
  const rows = fromSignIn([
    { id: "linkedin", host: "www.linkedin.com", site: "https://www.linkedin.com", class: "auth", words: "sign in to www.linkedin.com again in the browser Vyre uses (ops's computer: open its screen and sign in once)", agent: "ops", at: 5 },
    { id: "crm", host: "crm.example.com", class: "blocked", words: "crm.example.com is challenging the browser: a person has to clear it once", stopped: true, at: 4 },
    { id: "mac", host: "app.example.com", class: "no_browser", words: "needs your Chrome: the Mac is offline", at: 3 },
    { id: "slow", host: "x.example.com", class: "rate", words: "slow down", at: 2 }, { id: "fine", class: "ok" }, null, { class: "auth" },
  ]);
  assert.deepEqual(rows.map(r => [r.id, r.kind, r.title]), [
    ["connectors:linkedin", "signin", "Sign in to www.linkedin.com again"],
    ["connectors:crm", "signin", "crm.example.com is checking the browser"],
    ["connectors:mac", "signin", "No browser is signed in to app.example.com"],
  ]);
  assert.deepEqual(rows[0].answers.map((/** @type {any} */ a) => a.label), ["Open the computer's screen", "Check it now"]);
  assert.equal(rows[0].answers[0].open, "/u/glass/ops");
  assert.deepEqual(rows[0].answer, { tool: "connectors.connection.check", input: { id: "linkedin" }, fill: [] });
  assert.deepEqual(rows[1].answer, { tool: "connectors.site.resume", input: { id: "crm" }, fill: [] }, "a stopped account is resumed by the person once the check is cleared");
  assert.deepEqual(rows[1].answers.map((/** @type {any} */ a) => a.label), ["Check it now", "I cleared it"]);
  assert.deepEqual(rows[2].answers.map((/** @type {any} */ a) => a.label), ["Check it now"], "a Mac's own Chrome has no screen of ours");
  assert.ok(!JSON.stringify(rows).includes("https://www.linkedin.com"), "no page address rides on a card");
  assert.equal(fromSignIn([{ id: "x", class: "auth", agent: "../etc", host: "h.example.com" }])[0].answers[0].label, "Check it now", "an agent name that is not a name opens nothing");
  const owner = OWNERS.find(o => o.name === "connectors");
  assert.ok(owner && /** @type {any} */ (owner).quiet && owner.tool === "connectors.site.attention");
  assert.deepEqual(owner.map(null), []);
  const hint = owner.watch[0][1];
  assert.deepEqual(hint && hint("connectors.connection-checked", { id: "linkedin", light: "green" }), ["connectors:linkedin", "signed in"]);
});
