// @ts-check
// An agent's own Routine or Watcher is due: the watchers module asks agents.wake (with watcher) to post its words into the chat the person asked in, for that person,
// on that person's own AI account (any provider), never the owner's for someone else. Harness from own-account.test.js.
// The owner's rule (20 Oct 2026): every agent run is on the AI account of the PERSON it is for, on whatever provider they hold one on, and the owner's or the home's is never used for someone else.
// The agents module's side, for the runs nobody is chatting in: a task wake (the person who gave the task, a Flow's run_as) and a scheduled job (the schedule's maker); and the model picked for an agent
// naming its provider. In-process registry with the real agents module, a real kernel (the Space's owner), the real account resolution (core/sessions/accounts.js behind a stand-in of the one internal
// tool), and a stand-in threads module that records each launch: no daemon, no session is started.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { createKernel } from "../../kernel/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const SPACE = "spc_aaaaaaaaaaab", OWNER = "per_owner", ANA = "per_ana", ADA = "per_ada";
const ACCOUNTS = pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "sessions", "accounts.js")).href;

const THREADS = `export default { async start(ctx) {
  const known = { "t-ana": { id: "t-ana", agent: "juno", status: "idle" }, "t-other": { id: "t-other", agent: "kit", status: "idle" } };
  ctx.tool("threads.launch", { internal: true, run: async i => { (globalThis.__launched ||= []).push(i); return { id: "job" + globalThis.__launched.length }; } });
  ctx.tool("threads.get", { effect: "read", run: async i => ({ thread: known[i.thread] || null }) });
  ctx.tool("threads.post", { internal: true, run: async (i, m) => { (globalThis.__posted ||= []).push({ ...i, caller: m.caller }); return { sent: true, thread: i.thread }; } });
  return {};
} };`;
const PROJECTS = `export default { async start(ctx) {
  ctx.tool("projects.list", { effect: "read", run: async () => ({ projects: [] }) });
  return {};
} };`;
const ASSISTANT = `export default { async start(ctx) {
  ctx.tool("assistant.capabilities", { effect: "read", run: async () => ({ text: "CAPS" }) });
  return {};
} };`;
// The one internal tool the agents module asks, with the sessions module's own body (core/sessions/index.js sessions.accounts.resolve) over the real resolver.
const SESSIONS = `import { DatabaseSync } from "node:sqlite";
import { Accounts, ACCOUNTS_MIGRATION, ACCOUNTS_PENDING_MIGRATION, ACCOUNTS_ENDPOINT_MIGRATION, ACCOUNTS_PERSON_MIGRATION, ACCOUNTS_OWN_VAULT_MIGRATION } from ${JSON.stringify(ACCOUNTS)};
export default { async start(ctx) {
  const db = new DatabaseSync(":memory:");
  for (const m of [ACCOUNTS_MIGRATION, ACCOUNTS_PENDING_MIGRATION, ACCOUNTS_ENDPOINT_MIGRATION, ACCOUNTS_PERSON_MIGRATION, ACCOUNTS_OWN_VAULT_MIGRATION]) db.exec(m);
  const accounts = globalThis.__accounts = new Accounts(db, { owner: () => ${JSON.stringify(OWNER)} });
  ctx.tool("sessions.accounts.resolve", { internal: true, run: async i => (i.any === true && !i.account ? accounts.own(i) : accounts.resolve(i)) });
  return {};
} };`;

async function world(/** @type {any} */ t) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "threads", { roles: ["box", "local"], does: { tools: ["threads.launch", "threads.get", "threads.post"] } }, THREADS);
  writeModule(root, "projects", { roles: ["box", "local"], does: { tools: ["projects.list"] } }, PROJECTS);
  writeModule(root, "assistant", { roles: ["box", "local"], does: { tools: ["assistant.capabilities"] } }, ASSISTANT);
  writeModule(root, "sessions", { roles: ["box", "local"], does: { tools: ["sessions.accounts.resolve"] } }, SESSIONS);
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 6) });
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, paths: { root: home }, log: () => {}, kernelFor: k.kernelFor });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "agents");
  await reg.start([...core, ...discover([root])], { role: "local" });
  t.after(async () => { await reg.stop?.(); db.close(); delete /** @type {any} */ (globalThis).__launched; delete /** @type {any} */ (globalThis).__posted; delete /** @type {any} */ (globalThis).__accounts; });
  const call = (/** @type {string} */ tool, /** @type {any} */ input = {}, caller = "local") => reg.call(tool, input, caller);
  const made = await call("agents.create", { name: "juno", kind: "agent", projects: [] });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  /** @type {any} */ const accounts = /** @type {any} */ (globalThis).__accounts;
  const home0 = await accounts.add({ provider: "claude", label: "The home's Claude", kind: "api-key", vault_item: "claude-home" });
  const last = () => /** @type {any} */ ((/** @type {any} */ (globalThis).__launched || []).at(-1));
  const count = () => ((/** @type {any} */ (globalThis).__launched || []).length);
  let n = 0;
  const wake = (/** @type {string | undefined} */ approver) => call("agents.wake", { task: `t${++n}`, agent: "juno", title: "Refund R-9", ...(approver ? { approver } : {}) }, "module:vyred");
  const job = (/** @type {string | undefined} */ person) => call("agents.job", { agent: "juno", prompt: "Draft the digest", ...(person ? { person } : {}) }, "module:planner");
  return { call, accounts, home0, last, count, wake, job, db };
}
const NONE = /Connect your own AI account in Settings, AI accounts, to use juno\./;
const posted = () => /** @type {any[]} */ ((/** @type {any} */ (globalThis).__posted || []));
const due = (w, o) => w.call("agents.wake", { task: "watcher:northwind-invoices", agent: "juno", title: "northwind-invoices", watcher: "northwind-invoices", text: "Your watcher northwind-invoices found 1 new item.", ...o }, "module:watchers");

test("only the watchers module wakes an agent for its own Routine or Watcher", async t => {
  const w = await world(t);
  for (const who of ["module:vyred", "module:planner", "local", "mcp:agent:juno"]) assert.ok((await w.call("agents.wake", { task: "watcher:x", agent: "juno", title: "x", watcher: "x", text: "hi" }, who)).error, who);
  assert.equal(posted().length, 0);
});

test("it posts into the chat it was asked in, when that chat is the agent's, for that person on her own account", async t => {
  const w = await world(t);
  await w.accounts.add({ provider: "codex", label: "Ana's Codex", kind: "login", person: ANA });
  const r = await due(w, { approver: ANA, thread: "t-ana" });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual([r.data.thread, posted()[0].thread, posted()[0].from, posted()[0].kind], ["t-ana", "t-ana", "watcher:northwind-invoices", "watcher.item"]);
  assert.equal(posted()[0].text, "Your watcher northwind-invoices found 1 new item.", "the watchers module's quoted words, as given");
  assert.equal(w.count(), 0, "her chat was there: nothing new started");
});

test("a chat that is not the agent's is not used: her own thread with the agent starts on her own account, a non-Claude one too", async t => {
  const w = await world(t);
  const codex = await w.accounts.add({ provider: "codex", label: "Ana's Codex", kind: "login", person: ANA });
  const r = await due(w, { approver: ANA, thread: "t-other" });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const l = w.last();
  assert.deepEqual([l.provider, l.account, l.person, l.run_as, l.for_person], ["codex", codex.id, ANA, ANA, ANA]);
  assert.equal(posted()[0].thread, r.data.thread);
  assert.notEqual(r.data.thread, "t-other");
});

test("a person with no AI account of her own is refused in plain words, and nothing is posted or started; the owner's runs on the owner's own", async t => {
  const w = await world(t);
  const r = await due(w, { approver: ADA, thread: "t-ana" });
  assert.match(r.error.message, NONE);
  assert.deepEqual([posted().length, w.count()], [0, 0]);
  const o = await due(w, { approver: OWNER });
  assert.equal(o.error, undefined, JSON.stringify(o.error));
  assert.equal(w.last().account, undefined, "the owner's run takes no member's account");
  assert.equal(posted().length, 1);
});
