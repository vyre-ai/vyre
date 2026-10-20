// @ts-check
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
import { OWNER_UPKEEP } from "./index.js";

const SPACE = "spc_aaaaaaaaaaab", OWNER = "per_owner", ANA = "per_ana", ADA = "per_ada";
const ACCOUNTS = pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "sessions", "accounts.js")).href;

const THREADS = `export default { async start(ctx) {
  ctx.tool("threads.launch", { internal: true, run: async i => { (globalThis.__launched ||= []).push(i); return { id: "job" + globalThis.__launched.length }; } });
  ctx.tool("threads.get", { effect: "read", run: async () => ({ thread: null }) });
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
  writeModule(root, "threads", { roles: ["box", "local"], does: { tools: ["threads.launch", "threads.get"] } }, THREADS);
  writeModule(root, "projects", { roles: ["box", "local"], does: { tools: ["projects.list"] } }, PROJECTS);
  writeModule(root, "assistant", { roles: ["box", "local"], does: { tools: ["assistant.capabilities"] } }, ASSISTANT);
  writeModule(root, "sessions", { roles: ["box", "local"], does: { tools: ["sessions.accounts.resolve"] } }, SESSIONS);
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 6) });
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, paths: { root: home }, log: () => {}, kernelFor: k.kernelFor });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "agents");
  await reg.start([...core, ...discover([root])], { role: "local" });
  t.after(async () => { await reg.stop?.(); db.close(); delete /** @type {any} */ (globalThis).__launched; delete /** @type {any} */ (globalThis).__accounts; });
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

test("a task wake runs on the AI account of the person who gave the task: hers for a member, never the home's", async t => {
  const w = await world(t);
  const hers = await w.accounts.add({ provider: "claude", label: "Ana's Claude", kind: "login", person: ANA });
  const r = await w.wake(ANA);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const l = w.last();
  assert.equal(l.account, hers.id, "her own account");
  assert.equal(l.person, ANA);
  assert.equal(l.provider, "claude");
  assert.equal(l.for_person, ANA);
  assert.equal(l.run_as, ANA, "the job acts as her");
  assert.equal(l.auth, "ambient", "the agent's own credentials are not in the launch");
  assert.equal(l.env, undefined);
  // NEGATIVE: never the home's account (the owner's) for her
  assert.notEqual(l.account, w.home0.id);
});

test("a member with no AI account of her own is refused for a task wake in plain words, nothing is launched, and the wake can be retried", async t => {
  const w = await world(t);
  const before = w.count();
  const r = await w.wake(ANA);
  assert.match(String(r.error && r.error.message), NONE, JSON.stringify(r));
  assert.equal(w.count(), before, "NEGATIVE: nothing ran, so nothing ran on the owner's or the home's account");
  // an admin is a person like any other: the same
  const a = await w.wake(ADA);
  assert.match(String(a.error && a.error.message), NONE);
  assert.equal(w.count(), before);
});

test("the owner's task wake and a wake for nobody run as before: the owner's own (the agent's or the home's), no member account named", async t => {
  const w = await world(t);
  await w.accounts.add({ provider: "claude", label: "Ana's Claude", kind: "login", person: ANA });
  assert.equal((await w.wake(OWNER)).error, undefined);
  assert.equal(w.last().account, undefined, "the owner's run names no member's account");
  assert.equal(w.last().run_as, OWNER);
  assert.equal((await w.wake(undefined)).error, undefined);
  assert.equal(w.last().account, undefined);
  assert.equal(w.last().for_person, undefined);
});

test("a member with only Codex, or only an API key, runs agents on it", async t => {
  const w = await world(t);
  const codex = await w.accounts.add({ provider: "codex", label: "Ana's Codex", kind: "login", person: ANA });
  assert.equal((await w.wake(ANA)).error, undefined);
  assert.deepEqual([w.last().provider, w.last().account, w.last().person], ["codex", codex.id, ANA]);
  assert.equal(w.last().model, undefined, "the agent's Claude model is not sent to Codex");
  const key = await w.accounts.add({ provider: "openrouter", label: "Bob's key", kind: "api-key", vault_item: "bob-or", person: "per_bob", own_vault: true });
  assert.equal((await w.job("per_bob")).error, undefined);
  assert.deepEqual([w.last().provider, w.last().account, w.last().person, w.last().for_person], ["openrouter", key.id, "per_bob", "per_bob"]);
  // NEGATIVE: one member's account never runs another member's job
  assert.notEqual(w.last().account, codex.id);
});

test("a scheduled run uses the account of the person who made the schedule; one with none is refused; a schedule with no maker is refused, never run as the owner", async t => {
  const w = await world(t);
  const hers = await w.accounts.add({ provider: "grok", label: "Ana's Grok", kind: "login", person: ANA });
  assert.equal((await w.job(ANA)).error, undefined);
  assert.deepEqual([w.last().provider, w.last().account, w.last().run_as], ["grok", hers.id, ANA]);
  const before = w.count();
  const r = await w.job(ADA);
  assert.match(String(r.error && r.error.message), NONE, "an admin with none is refused, never run on the owner's");
  assert.equal(w.count(), before);
  // Rule 2: no person, no agent work. A schedule with nobody recorded starts nothing, and never on the owner's or the home's account
  const none = await w.job(undefined);
  assert.equal(none.error && none.error.code, "denied", JSON.stringify(none));
  assert.match(none.error.message, /No person asked for this, so no agent was started\./);
  assert.equal(w.count(), before, "NEGATIVE: nothing was launched for a schedule with no maker");
  // the owner's own schedule runs on the owner's own (the agent's picked sign-in or the home's), acting as the owner
  assert.equal((await w.job(OWNER)).error, undefined);
  assert.deepEqual([w.last().account, w.last().run_as], [undefined, OWNER]);
});

test("a model picked on OpenRouter runs on OpenRouter even with Claude connected: its provider is stored with the model and read at launch", async t => {
  const w = await world(t);
  const up = await w.call("agents.update", { name: "juno", model: "x-ai/grok-4", model_provider: "openrouter" });
  assert.equal(up.error, undefined, JSON.stringify(up.error));
  // the owner's run: no Claude credentials in the launch, the provider named for the switchboard (accountProviderFor) to pick the asker's OpenRouter account
  assert.equal((await w.job(OWNER)).error, undefined);
  assert.deepEqual([w.last().model, w.last().model_provider, w.last().auth, w.last().env], ["x-ai/grok-4", "openrouter", "ambient", undefined]);
  // a member with Claude AND OpenRouter of her own: the model's provider is preferred
  await w.accounts.add({ provider: "claude", label: "Ana's Claude", kind: "login", person: ANA });
  const or = await w.accounts.add({ provider: "openrouter", label: "Ana's OpenRouter", kind: "api-key", vault_item: "ana-or", person: ANA, own_vault: true });
  assert.equal((await w.wake(ANA)).error, undefined);
  assert.deepEqual([w.last().provider, w.last().account, w.last().model], ["openrouter", or.id, "x-ai/grok-4"]);
  // a new model with no provider is Claude's again: the old provider does not carry over
  assert.equal((await w.call("agents.update", { name: "juno", model: "opus" })).error, undefined);
  assert.equal((await w.wake(ANA)).error, undefined);
  assert.equal(w.last().provider, "claude");
  assert.equal(w.last().model, "opus");
  assert.equal((await w.call("agents.update", { name: "juno", model: "x", model_provider: "Not A Provider!" })).error.code, "bad_input");
});

test("a rollback to a version with another model clears the provider: the old provider never carries over to the model it restores", async t => {
  const w = await world(t);
  assert.equal((await w.call("agents.update", { name: "juno", model: "x-ai/grok-4", model_provider: "openrouter" })).error, undefined);
  assert.equal((await w.job(OWNER)).error, undefined);
  assert.equal(w.last().model_provider, "openrouter", "picked on OpenRouter");
  // back to how it began (no model): Claude's, never the OpenRouter provider left from the pick
  const back = await w.call("agents.update", { name: "juno", rollback: 0 });
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.equal((await w.job(OWNER)).error, undefined);
  assert.equal(w.last().model_provider, undefined, "NEGATIVE: no stale provider on the restored model");
  assert.notEqual(w.last().model, "x-ai/grok-4");
  // a model picked again with its provider: as named
  assert.equal((await w.call("agents.update", { name: "juno", model: "x-ai/grok-4", model_provider: "openrouter" })).error, undefined);
  assert.equal((await w.job(OWNER)).error, undefined);
  assert.equal(w.last().model_provider, "openrouter");
});

test("a run on a model picked on another provider is held to the agent's budget: what is left goes with it, and none left is refused before anything starts", async t => {
  const w = await world(t);
  assert.equal((await w.call("agents.update", { name: "juno", model: "x-ai/grok-4", model_provider: "openrouter", auth: { budget_usd: 1 } })).error, undefined);
  w.db.prepare("INSERT INTO agents_spend (thread, agent, at, usd) VALUES (?,?,?,?)").run("t-old", "juno", Date.now(), 0.25);
  assert.equal((await w.job(OWNER)).error, undefined);
  assert.equal(w.last().budget_usd, 0.75, "what is left of the budget is the run's own backstop");
  w.db.prepare("INSERT INTO agents_spend (thread, agent, at, usd) VALUES (?,?,?,?)").run("t-old2", "juno", Date.now(), 0.75);
  const before = w.count();
  const r = await w.job(OWNER);
  assert.match(String(r.error && r.error.message), /has spent its \$1 budget/, JSON.stringify(r));
  assert.equal(w.count(), before, "NEGATIVE: nothing started past the budget");
});

test("resuming a member's own thread with the agent brings it back as her, on her own account; one whose account is gone is refused", async t => {
  const w = await world(t);
  const hers = await w.accounts.add({ provider: "claude", label: "Ana's Claude", kind: "login", person: ANA });
  w.db.prepare("INSERT INTO agents_person_threads (agent, person, thread, at) VALUES (?,?,?,?)").run("juno", ANA, "th-ana", Date.now());
  const r = await w.call("agents.resume", { agent: "juno", thread: "th-ana" }, "module:switchboard");
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const l = w.last();
  assert.deepEqual([l.resume, l.account, l.person, l.for_person, l.run_as], ["th-ana", hers.id, ANA, ANA, ANA]);
  assert.equal(l.env, undefined, "NEGATIVE: none of the agent's credentials in her resume");
  // a thread that is no person's (the agent's own) resumes as before
  assert.equal((await w.call("agents.resume", { agent: "juno", thread: "th-own" }, "module:switchboard")).error, undefined);
  assert.equal(w.last().account, undefined);
  assert.equal(w.last().run_as, undefined);
  // her account gone: refused, never resumed on the agent's or the owner's
  w.accounts.remove(hers.id);
  w.db.prepare("INSERT INTO agents_person_threads (agent, person, thread, at) VALUES (?,?,?,?) ON CONFLICT(agent, person) DO UPDATE SET thread = excluded.thread").run("juno", ANA, "th-ana", Date.now());
  const before = w.count();
  const g = await w.call("agents.resume", { agent: "juno", thread: "th-ana" }, "module:switchboard");
  assert.match(String(g.error && g.error.message), NONE, JSON.stringify(g));
  assert.equal(w.count(), before, "NEGATIVE: nothing resumed on anyone else's account");
});

test("Rule 2: a call whose chain is only the home's own services starts no agent; only the named upkeep, which starts no thread, reads it as the owner's", async t => {
  const w = await world(t);
  const before = w.count();
  // a module's own call, and a surface label with no person proved: both name nobody
  for (const caller of ["module:onboard", "local"]) {
    const r = await w.call("agents.ask", { agent: "juno", text: "hello", wait: false }, caller);
    assert.equal(r.error && r.error.code, "denied", `${caller}: ${JSON.stringify(r)}`);
    assert.match(r.error.message, /No person asked for this, so no agent was started\./);
  }
  assert.equal(w.count(), before, "NEGATIVE: no agent was started, on the owner's account or any other");
  // the allow-list: each entry says why it is upkeep that runs no AI turn
  assert.deepEqual(Object.keys(OWNER_UPKEEP).sort(), ["agents.access.set", "agents.context.link", "agents.create", "agents.docs.set", "agents.update", "agents.vault.assign"]);
  for (const [tool, why] of Object.entries(OWNER_UPKEEP)) assert.match(why, /starts no thread/, `${tool} says why it is upkeep`);
  // the upkeep still runs with no person on the call: a module makes an agent and changes it, and the owner is named as its maker and on its version
  const made = await w.call("agents.create", { name: "kit", kind: "agent", projects: [] }, "module:onboard");
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  assert.equal(made.data.owner, OWNER);
  const up = await w.call("agents.update", { name: "kit", instructions: "Answer in one line." }, "module:onboard");
  assert.equal(up.error, undefined, JSON.stringify(up.error));
  assert.equal(w.db.prepare("SELECT by FROM agents_versions WHERE agent = 'kit' ORDER BY n DESC").get().by, OWNER);
  assert.equal(w.count(), before, "and none of it started a thread");
});
