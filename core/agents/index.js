// @ts-check
// agents — the assistant and the agents you make (docs/SPEC.md section 10).
//
// An agent is a record, not a process. Its work happens in ordinary headless Claude Code
// threads run by the switchboard, so everything true of a thread (one keyboard, questions
// routed to the user, streamed to every surface) is true of an agent's work without this module
// doing anything. What this module adds is who the agent is:
//
//   - its credentials: a setup token (CLAUDE_CODE_OAUTH_TOKEN, the user's subscription) or an
//     API key with a budget, released from the Vault one item at a time and set only in that
//     agent's own child process;
//   - its scope: the projects it may draw context from, handed to the Harness so the brief,
//     Enrich and recall.search stay inside them;
//   - its voice: instructions appended to Claude Code's system prompt.
//
// The assistant is the one agent with every project ("*") and the threads.* and agents.* tools,
// so it can start, drive, monitor and stop any session. Other agents get neither.
//
// The switchboard is used through ctx.call and its events, never by importing it.

import { grantReach, revokeReach } from "../../lib/project-reach.js";
import { mintUuid } from "../../kernel/core/ids.js";
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isPerson } from "../../lib/caller.js";
import { within } from "../../lib/within.js";
import { createHash } from "node:crypto";
import { change as changeTags } from "../../lib/tags.js";
import { createMirror } from "./mirror.js";
import { agentDir } from "../../lib/files/layout.js";
import { orientation } from "../../lib/orientation.js";
import { MIGRATIONS as CONFIG_MIGRATIONS, register as registerConfig } from "./config.js";

export const MIGRATIONS = [
  `CREATE TABLE agents_agents (
     name TEXT PRIMARY KEY, kind TEXT NOT NULL, projects TEXT NOT NULL, auth TEXT NOT NULL,
     instructions TEXT, skills TEXT NOT NULL DEFAULT '[]', computer INTEGER NOT NULL DEFAULT 0,
     model TEXT, thread TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   );
   CREATE TABLE agents_spend (thread TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL, usd REAL NOT NULL);
   CREATE INDEX agents_spend_agent ON agents_spend (agent);`,
  // How hard the agent thinks (the Deck's Effort). Empty is the model's own default.
  `ALTER TABLE agents_agents ADD COLUMN effort TEXT`,
  // Built in by Vyre (the Engineer): listed like any agent, but it cannot be deleted, renamed, given projects, credentials or a computer.
  `ALTER TABLE agents_agents ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0`,
  // The person granted this agent their PERSONAL memory and every project's sessions to read ("Claude Code on <this computer>"): reads only, never writes, never the person. Appended last, like every step.
  `ALTER TABLE agents_agents ADD COLUMN personal INTEGER NOT NULL DEFAULT 0`,
  // A stable id for the agent, never reused: the kernel's grants and actor name THIS, not the name, so a deleted agent's name given to a new one inherits nothing.
  `ALTER TABLE agents_agents ADD COLUMN uid TEXT`,
  // Every agent has an OWNER, a person with the say over it (R031-09); and free tags (R031-02, written through agents.update and mirrored to the agent records by core/agents/mirror.js).
  `ALTER TABLE agents_agents ADD COLUMN owner TEXT`,
  `ALTER TABLE agents_agents ADD COLUMN tags TEXT`,
  // Every change to what an agent says or knows is a version (who proposed it, who said yes, what changed), and rollback writes a new one. A draft waits here until its owner decides; the proposal card
  // carries only its id and hash (kernel/flows/proposals.js), never the words.
  `CREATE TABLE agents_versions (agent TEXT NOT NULL, n INTEGER NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, by TEXT, approved_by TEXT, note TEXT, at INTEGER NOT NULL, PRIMARY KEY (agent, n));
   CREATE TABLE agents_drafts (id TEXT PRIMARY KEY, agent TEXT NOT NULL, patch TEXT NOT NULL, hash TEXT NOT NULL, proposer TEXT NOT NULL, by TEXT, state TEXT NOT NULL DEFAULT 'open', at INTEGER NOT NULL)`,
  // Subagents (R031-07): a short-lived helper a session starts for one job. It runs as its PARENT (same agent, so it can hold nothing the parent does not) with a tool list that can only be shorter;
  // this table is the one place that says a thread is one, so agents.scope can narrow it and the activity feed can nest it.
  `CREATE TABLE agents_subs (id TEXT PRIMARY KEY, parent TEXT NOT NULL, parent_thread TEXT NOT NULL, thread TEXT, label TEXT NOT NULL, only TEXT, project TEXT, state TEXT NOT NULL DEFAULT 'running', result TEXT, at INTEGER NOT NULL, ended INTEGER);
   CREATE INDEX agents_subs_thread ON agents_subs (thread)`,
  // The configuration page (core/agents/config.js): folders linked as context, and the Vault item names put at an agent's disposal.
  ...CONFIG_MIGRATIONS,
  // One thread per (agent, person) for a person who chats on their own AI account: her words never ride on another person's sign-in.
  `CREATE TABLE agents_person_threads (agent TEXT NOT NULL, person TEXT NOT NULL, thread TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (agent, person))`,
];

/**
 * The Engineer: a built-in assistant that helps an admin change the shape of their Space. It only PROPOSES. Its model session reaches these tools and no others (the registry holds it to
 * the list, from the stored row: agents.scope's `only`); a Flow it writes is a draft until a person approves it, and a Kit or a definition change becomes one task in Now that an owner or
 * an admin approves (kernel/flows/proposals.js). It has no project, no credential of its own, no computer, and nothing it holds can apply a change.
 */
const ENGINEER_0_3_0 = [
  "You are the Engineer. You help an owner or an admin change how their Space works: record types and fields, stages, Flows, Kits.",
  "You only propose. Write a Flow with flows.define (it is stored unapproved), check it with flows.compile-text, flows.simulate and flows.card, then ask for it with flows.propose.",
  "A Kit goes through flows.kit.propose. A change to record types goes through flows.propose with what: types and a diff.",
  "Each proposal becomes one task in Now. An owner or an admin approves it; you cannot. Say what you proposed and what it will do, in plain words, and wait.",
].join("\n");
const ENGINEER_0_3_4 = [
    "You are the Engineer. You set up an owner's or an admin's Space by conversation: record types, stages, Flows, Kits, project templates, and the instructions of the agents. Be brief and concrete; ask one question at a time and only when you cannot go on without it.",
    "You only propose. A person's yes on one card applies it, and every applied change is a version they can roll back. You cannot approve, start a project, or change anyone's permissions.",
    "Read before you write: docs.find for the page, skills.find for the way (build-a-template), flows.cheatsheet before a Flow.",
    "A Flow: flows.define, then flows.compile-text, flows.simulate and flows.test.save, then flows.propose. A template: work.template.define, work.template.test (it shows every brief and creates nothing), then flows.propose with what: template, template, version. An agent's words, skills or tags: flows.propose with what: agent, agent, patch. A skill or plugin: skills.draft, then flows.propose with what: skill, name, level, scope, version. Record types: flows.propose with what: types and a diff. A Kit: flows.kit.propose.",
    "Say what you proposed and what it will do, in plain words, and wait for the card.",
  ].join("\n");
/** What the Engineer was told before it learned the Playbooks, Objects, Flows and Agents handoff; a home that still holds exactly this is brought up to date. */
const ENGINEER_BEFORE_HANDOFF = [
    "You are the Engineer. You set up the Space for the person you are talking to, by conversation: record types, stages, Flows, Kits, project templates, and the instructions of the agents. You can only build what that person can themselves: you work on their access, with their own AI. Be brief and concrete; ask one question at a time and only when you cannot go on without it.",
    "You only propose. A person's yes on one card applies it, and every applied change is a version they can roll back. You cannot approve, start a project, or change anyone's permissions.",
    "Read before you write: docs.find for the page, skills.find for the way (build-a-template), flows.cheatsheet before a Flow.",
    "A Flow: flows.define, then flows.compile-text, flows.simulate and flows.test.save, then flows.propose. A template: work.template.define, work.template.test (it shows every brief and creates nothing), then flows.propose with what: template, template, version. An agent's words, skills or tags: flows.propose with what: agent, agent, patch. A skill or plugin: skills.draft, then flows.propose with what: skill, name, level, scope, version. Record types: flows.propose with what: types and a diff. A Kit: flows.kit.propose.",
    "Say what you proposed and what it will do, in plain words, and wait for the card.",
  ].join("\n");

/** The handoff a Space page sends when a person asks the Engineer from a Playbook, an Object, a Flow or an Agent (the app appends a fenced engineer-context block). */
const ENGINEER_HANDOFF = "A message that starts \"From Playbooks\", \"From Objects\", \"From Flows\" or \"From Agents\" and ends with a fenced ```engineer-context JSON block ({ source, ref, name, intent, words, shape }) is a handoff from that page about that exact thing. Answer with: (1) a short read of the request in the context of that thing, (2) the two or three questions that matter most, (3) a first draft the person can apply with one yes: for a Playbook through work.template.define, work.template.test and work.template.install; for a Flow flows.define; for an Object the Space's record types; for an Agent agents.update or agents.create. Apply nothing before the yes. If shape is empty the thing is new: draft from the words alone.";

export const ENGINEER = Object.freeze({
  name: "engineer",
  instructions: ENGINEER_BEFORE_HANDOFF + "\n" + ENGINEER_HANDOFF,
  /** The instructions this build shipped before, so a home that still has one of them is brought up to date and one an admin edited is left alone. */
  previous: Object.freeze([ENGINEER_0_3_0, ENGINEER_0_3_4, ENGINEER_BEFORE_HANDOFF]),
  /** The tools its session may call. Reads of the Space's own definitions and the drafting and proposing tools; nothing that applies, approves, sends or reads outside them. */
  tools: Object.freeze(["flows.define", "flows.compile-text", "flows.code", "flows.card", "flows.get", "flows.list", "flows.graph", "flows.simulate", "flows.runs", "flows.run",
    "flows.propose", "flows.kit.card", "flows.kit.propose", "flows.kit.list", "records.types",
    "flows.patch", "flows.cheatsheet", "flows.describe", "flows.test.save", "flows.test.run", "flows.test.list", "flows.health",
    "work.template.define", "work.template.test", "work.template.list", "work.template.get", "work.template.library", "work.template.install", "work.template.from-project",
    "agents.list", "agents.versions", "skills.find", "skills.get", "skills.list", "skills.draft", "skills.versions", "docs.find", "docs.read"]),
});

/** The agent's thinking effort, as sessions.effort names it. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
/** How long agents.ask waits for a reply before handing back what it has. */
const ASK_WAIT_MS = 590_000;

/** A setup token and an API key look different; the Vault item says which it is only by its value. */
export const envFor = (value, as) => (as === "api-key" ? { ANTHROPIC_API_KEY: value } : { CLAUDE_CODE_OAUTH_TOKEN: value });

/**
 * What an agent's thread is told about itself, after Claude Code's own system prompt.
 * @param {any} a an agent record
 */
export function preamble(a, { withWords = true } = {}) {
  const scope = a.projects === "*" ? "every project on this machine" : a.projects.length ? `only these projects: ${a.projects.join(", ")}` : "no project";
  const lines = a.kind === "assistant"
    ? [`You are ${a.name}, the user's assistant in Vyre. You can see ${scope}.`,
       "You can start, drive, monitor and stop any Claude Code session with the vyre MCP tools, which you reach with tools_find and tools_call: tools_call threads_start, tools_call threads_send, tools_call threads_list, tools_call threads_get, tools_call threads_stop. Talk to other agents with agents_ask.",
       "Permission questions in any session are answered by the user, never by you. When a session is waiting on one, tell the user what it asks.",
       "To watch a thread for the user, call tools_call threads_watch with {thread, notify: \"capsule\", note: \"<a short label>\"}.",
       "To drive a thread for the user (\"tell the site thread to run the tests and report back\"), call tools_call threads_send, then set that watch. If another surface holds the thread's keyboard, that call says who; tell the user rather than taking it.",
       "When a watch fires, the user sees it in Lumen and on their devices. Do not poll tools_call threads_get to wait for it."]
    : [`You are ${a.name}, an agent in Vyre. You may use context from ${scope}, and from nothing outside it.`];
  // the instructions are the agent's AGENTS.md, read from its folder (named by the orientation); copied here only when there is no folder to read them from
  if (a.instructions && withWords) lines.push("", String(a.instructions));
  return lines.join("\n");
}

/** agents.update fields that change only what an agent says or which model says it. */
const PLAIN_UPDATE = new Set(["name", "agent", "instructions", "model", "effort", "description"]);

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */

export default {
  async start(ctx0) {
    // Each tool runs with the verified meta of its call in scope, so guard() can read vyred's meta.agent and meta.agentKind (never the label).
    const calls = new AsyncLocalStorage();
    const ctx = Object.create(ctx0, { tool: { value: (name, def) => ctx0.tool(name, def && typeof def.run === "function" ? { ...def, run: (i, m, ...r) => calls.run(m, () => def.run(i, m, ...r)) } : def) } });
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    for (const r of db.prepare("SELECT name FROM agents_agents WHERE uid IS NULL").all()) db.prepare("UPDATE agents_agents SET uid = ? WHERE name = ?").run(`agt_${mintUuid()}`, String(/** @type {any} */ (r).name));
    const root = ctx.paths ? ctx.paths.root : process.env.VYRE_HOME || "";
    /** Where agents' folders live: beside the projects (never inside VYRE_HOME: the session sandbox refuses a working folder there), so an agent session runs IN its own folder and reads its instructions natively. */
    const agentsBase = ctx.config && typeof ctx.config.projectsDir === "string" && ctx.config.projectsDir ? path.dirname(ctx.config.projectsDir) : root;
    /** The configuration page's half (core/agents/config.js); its brief is added to a launch. */
    let config = /** @type {{ brief(a: any): string, sharedLine(a: any): Promise<string[]>, materialize(a: any): { dir: string, instructions: boolean, context: boolean }, sharesFor(meta: any, a: any, staff: boolean): Promise<{ made_by: string | null, shares: { person: string, level: string }[] }>, clearShared(a: any): Promise<void>, levelOf(meta: any, a: any): Promise<"edit" | "use" | "none"> } | null} */ (null);

    const shape = r => r && ({ uid: String(r.uid), name: String(r.name), kind: String(r.kind), projects: JSON.parse(String(r.projects)), auth: JSON.parse(String(r.auth)),
      instructions: r.instructions == null ? null : String(r.instructions), skills: JSON.parse(String(r.skills)), computer: Boolean(r.computer),
      model: r.model == null ? null : String(r.model), effort: r.effort == null ? null : String(r.effort), thread: r.thread == null ? null : String(r.thread), builtin: Boolean(r.builtin), personal: Boolean(r.personal), owner: r.owner == null ? null : String(r.owner), tags: r.tags == null ? "" : String(r.tags), id: String(r.created_at) });
    // The Engineer is made once and kept: a home that has none gets it, a home that has it keeps what an admin wrote in its instructions.
    // The name is reserved (ENG-2): a user agent already called `engineer` becomes the built-in, losing its projects, credentials, skills and computer, so it can never shadow the held one.
    if (db.prepare("SELECT 1 FROM agents_agents WHERE name = ? AND builtin = 0").get(ENGINEER.name)) {
      db.prepare("UPDATE agents_agents SET builtin = 1, kind = 'agent', projects = '[]', auth = '{}', skills = '[]', computer = 0, updated_at = ? WHERE name = ?").run(Date.now(), ENGINEER.name);
    }
    // a home that still has an older shipped text gets the current one; one an admin wrote is kept
    { const row = /** @type {any} */ (db.prepare("SELECT instructions FROM agents_agents WHERE name = ? AND builtin = 1").get(ENGINEER.name));
      if (row && ENGINEER.previous.includes(String(row.instructions))) db.prepare("UPDATE agents_agents SET instructions = ?, updated_at = ? WHERE name = ?").run(ENGINEER.instructions, Date.now(), ENGINEER.name); }
    if (!db.prepare("SELECT 1 FROM agents_agents WHERE name = ?").get(ENGINEER.name)) {
      const now = Date.now();
      db.prepare(`INSERT INTO agents_agents (name, kind, projects, auth, instructions, skills, computer, model, effort, builtin, created_at, updated_at, uid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(ENGINEER.name, "agent", "[]", "{}", ENGINEER.instructions, "[]", 0, null, null, 1, now, now, `agt_${mintUuid()}`);
    }
    const get = name => shape(db.prepare("SELECT * FROM agents_agents WHERE name = ?").get(name));
    const must = name => { const a = get(name); if (!a) throw Object.assign(new Error(`no agent ${name} (agents.list shows them)`), { code: "not_found" }); return a; };
    const mirror = createMirror({ kernel: () => ctx.kernel, rows: async () => Promise.all(db.prepare("SELECT * FROM agents_agents").all().map(async r => { const a = shape(r); return { ...a, users: config ? await config.sharedLine(a) : [] }; })), log: m => ctx.log(m) });
    const spent = name => Number(/** @type {any} */ (db.prepare("SELECT COALESCE(SUM(usd), 0) AS s FROM agents_spend WHERE agent = ?").get(name)).s);

    /** Tool results unwrapped; an error becomes a throw with its message. */
    const use = async (tool, input) => { const r = await ctx.call(tool, input); if (r.error) throw new Error(r.error.message); return r.data; };

    // An agent's `projects` list is kept in step with its KERNEL GRANTS on those projects (action project.reach, lib/project-reach.js), as part of the person's own, already-proved create or update:
    // a grant is a person's act with the kernel's proof, so only that call can make or take one. A "*" agent holds ONE grant on every project (`vyre://<space>/project/*`). Never for the assistant: its
    // reach is the assistant rule (core/memory's reach()), not a per-project grant.
    const K = ctx.kernel;
    const wild = () => `vyre://${K.space}/project/*`;
    const slugs = (/** @type {any} */ v) => (Array.isArray(v) ? v.map(String) : []);
    const urnOf = async (/** @type {string} */ slug) => { const r = await ctx.call("projects.record", { project: slug }); if (r.error) throw new Error(`no record for project ${slug}: ${r.error.message}`); return String(r.data.urn); };
    /** Whether this call carries a person to act as: a module's own call (the plugin agent's grant makes its agent this way) carries none, and then the grants are the caller's to make with its own proof. */
    const hasPerson = async (/** @type {any} */ meta) => { try { const c = await K.chain(meta); return c.hops.length === 1 && c.hops[0].actor.kind === "person"; } catch { return false; } };
    /**
     * An agent is made an actor of this Space under its NAME, the id a template's stage names for a task's doer (kernel/flows/stages.js) and a chat that lists it registers (core/daemon/index.js chatFor), so a
     * project started from a template gets its assistant tasks. It is done by the daemon under the OWNER's chain, so it happens only when the call carries the Space's owner and nobody else (a member's token, a
     * module's call with no person and a model's never do; agents.create's callers alone do not keep a member out, since a paired app device is let through as "deck"); anyone else gets the words below.
     * Whether a member's own agent should be an actor of the Space is the owner's decision. Already an actor: nothing is written (registry.deps.agentActor checks). Returns null when done, else the words for the answer.
     * @param {string} name @param {any} meta
     */
    const becomeActor = async (name, meta) => {
      if (!K || !K.grants || typeof ctx.agentActor !== "function") return null;   // no kernel here: there is no Space to be an actor of
      const later = (/** @type {string} */ why) => `${name} is made, but it is not a member of this Space yet, so no task can be given to it (${why}). Ask the owner to add it with: vyre space add-agent ${K.space} ${name}`;
      let who = null;
      try { const c = await K.chain(meta); who = c.hops.length === 1 && c.hops[0].actor.kind === "person" ? String(c.hops[0].actor.id) : null; } catch { who = null; }
      if (!who) { ctx.log(`agents: ${name} was made by a call with no person, so it is not an actor of the Space yet`); return later("this call carried no person"); }
      const canon = (/** @type {string} */ id) => (typeof K.canonicalPerson === "function" ? K.canonicalPerson(id) : id);
      if (canon(who) !== canon(String(K.owner))) { ctx.log(`agents: ${name} was made by a member, so it is not an actor of the Space yet; the owner adds it`); return later("only the Space's owner adds an agent to it"); }
      try { await ctx.agentActor(name); return null; }
      catch (e) {
        ctx.log(`agents: could not make ${name} an actor of the Space: ${/** @type {Error} */ (e).message}`);
        return later(String(/** @type {Error} */ (e).message).slice(0, 160));
      }
    };
    const syncAccess = async (/** @type {string} */ name, /** @type {any} */ before, /** @type {any} */ after, /** @type {any} */ meta) => {
      if (!K || !K.grants) return; // no kernel here: there are no grants to keep in step with
      if (!(await hasPerson(meta))) {
        // reach is a kernel grant, a person's own act. A call with nothing to change is fine; one that would grant or revoke and carries no person is refused, never silently left without the grant
        // (the plugin agent's module call is the one exception: it makes its own wildcard grant in the person's call).
        const changes = after === "*" ? before !== "*" : before === "*" || slugs(after).some(s => !slugs(before).includes(s)) || slugs(before).some(s => !slugs(after).includes(s));
        if (changes && String((meta && meta.caller) || "") !== "module:pluginagent") throw Object.assign(new Error("giving an agent a project is the person's own act; this call carries no person"), { code: "denied" });
        return;
      }
      const pr = await ctx.call("projects.list", {});
      if (pr.error) return; // projects is not running: nothing to keep in step with
      if (after === "*" && before !== "*") await grantReach(K, meta, { urn: wild(), agent: name });
      if (before === "*" && after !== "*") await revokeReach(K, meta, { urn: wild(), agent: name });
      const was = new Set(slugs(before)), now = new Set(slugs(after));
      for (const slug of [...now].filter(s => !was.has(s))) await grantReach(K, meta, { urn: await urnOf(slug), agent: name });
      for (const slug of [...was].filter(s => !now.has(s))) await revokeReach(K, meta, { urn: await urnOf(slug), agent: name });
    };

    // Spend on the API key is counted from each turn's result, per agent, so the budget holds
    // across threads and restarts. Turns on the subscription cost the user nothing extra.
    // The budget is enforced here, turn by turn: at 80% the thread is told, and at 100% it stops
    // with a note saying why and what to change. --max-budget-usd is Claude Code's own backstop.
    ctx.events.on("thread.finished", async e => {
      try {
        const run = /** @type {any} */ (db.prepare("SELECT agent, auth FROM threads_runs WHERE id = ?").get(e.thread));
        const cost = Number(e.payload.cost_usd) || 0;
        if (!(run && run.agent && run.auth === "api-key" && cost > 0)) return;
        db.prepare("INSERT INTO agents_spend (thread, agent, at, usd) VALUES (?,?,?,?)").run(e.thread, run.agent, Date.now(), cost);
        const a = get(run.agent);
        const budget = a && typeof a.auth.budget_usd === "number" ? a.auth.budget_usd : null;
        if (budget == null) return;
        const now = spent(a.name), before = now - cost;
        const usd = n => `$${n.toFixed(2)}`;
        if (now >= budget) {
          await ctx.call("threads.halt", { thread: e.thread, reason: "budget",
            text: `${a.name} has spent ${usd(now)} of its ${usd(budget)} API-key budget, so this thread has stopped. To go on, raise it: vyre agents update ${a.name} --budget <dollars>` });
        } else if (before < budget * 0.8 && now >= budget * 0.8) {
          await ctx.call("threads.notice", { thread: e.thread, text: `${a.name} has spent ${usd(now)} of its ${usd(budget)} API-key budget (${Math.round((now / budget) * 100)}%).` });
        }
      } catch {}
    });

    /**
     * A Vault item's value, through ctx.vault.fetch (manifest `needs.vault: ["per-agent"]`). It
     * never leaves this function except into a child's env. The grant is per item to module
     * `agents`, and the vault's refusal already names the command that makes it, so it is passed
     * on with the agent's name in front.
     *
     * No `field` is asked for. A setup token is stored as a `secret` and an API key as an
     * `api-key`, and the vault hands over the single `value` field of both by default. An item of
     * another kind (an env-set from an imported .env, say) is refused by the vault with its own
     * message, which is what the person needs to see: put the token again as one value.
     */
    const release = async (a, name) => {
      let v;
      // The two provider sign-in items come through the credentials port, never a module grant; anything else an agent names is still the agent's own grant.
      const launcherProvider = name === "claude-setup-token" ? "claude" : name === "anthropic-api-key" ? "anthropic" : null;
      try { v = launcherProvider && ctx.credentials ? await ctx.credentials(launcherProvider) : undefined; if (v === undefined) v = await ctx.vault.fetch(name); }
      catch (e) { throw new Error(`${a.name} cannot start: ${/** @type {Error} */ (e).message}`); }
      if (!v) throw new Error(`${a.name} cannot start: the vault has no value for ${name}`);
      return String(v);
    };

    /**
     * Credentials for a launch, with the fallback and budget rule: the subscription first, the
     * API key when the subscription's limit is reached and a key is allowed, never past the
     * budget. No auth configured means the ambient Claude Code login on this machine.
     */
    const credentials = async a => {
      const budget = typeof a.auth.budget_usd === "number" ? a.auth.budget_usd : null;
      const left = budget == null ? null : Math.max(0, budget - spent(a.name));
      if (a.auth.vault) {
        const out = { auth: "subscription", env: envFor(await release(a, a.auth.vault), "subscription") };
        // The API key only backs the subscription up. The onboarding names it before the person
        // has one, so a missing or ungranted key means no fallback, not no start.
        if (a.auth.fallback && (left == null || left > 0)) {
          try { out.fallback = { env: envFor(await release(a, a.auth.fallback), "api-key"), ...(left != null ? { budget_usd: left } : {}) }; }
          catch (e) { ctx.log(`agents: ${a.name} starts without its API key fallback: ${/** @type {Error} */ (e).message}`); }
        }
        return out;
      }
      if (a.auth.fallback) {
        if (left === 0) throw new Error(`${a.name} has spent its $${budget} budget on the API key`);
        return { auth: "api-key", env: envFor(await release(a, a.auth.fallback), "api-key"), ...(left != null ? { budget_usd: left } : {}) };
      }
      return { auth: "ambient" };
    };

    /** The folders an agent's projects own, so recall.search can be held inside them. */
    const scope = async a => {
      if (a.projects === "*") return { projects: "*", cwds: [] };
      const list = await ctx.call("projects.list", {});
      const ps = (list.data?.projects || []).filter(p => a.projects.includes(p.slug));
      return { projects: a.projects, cwds: ps.flatMap(p => [p.home, ...(p.workspaces || p.folders || [])]).filter(Boolean) };
    };

    /** Where an agent works: its one project's home, else a folder of its own beside the projects (`~/Vyre/agents/<name>`). Never inside VYRE_HOME: the session sandbox refuses a working folder there. */
    const workdir = async a => {
      if (Array.isArray(a.projects) && a.projects.length === 1) return { project: a.projects[0] };
      const dir = path.join(agentsBase, agentDir(String(a.uid)));
      // an earlier build kept the working folder by NAME beside the projects: it moves to the agent's id once, so nothing it held is lost
      const old = path.join(agentsBase, "agents", a.name);
      try { if (fs.existsSync(old) && !fs.existsSync(dir)) { fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 }); fs.renameSync(old, dir); } } catch { /* a folder that cannot move is made fresh */ }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return { cwd: dir };
    };

    /** Start the agent's thread, or bring its current one back, with its credentials and scope. */
    /**
     * The chatter's OWN AI sign-in, when she has a real one (not the home's, not the owner's): in a chat an agent runs on the account of the person talking to it,
     * never on the agent's credentials; those are for flows and jobs (nobody to ask). Null when she has none, so the agent's own are used as before.
     * @param {any} a @param {string | undefined} person
     */
    const ownAccount = async (a, person) => {
      if (!person || person === "automation") return null;
      const r = await ctx.call("sessions.accounts.resolve", { provider: "claude", person, agent: a.name }).catch(() => null);
      const acct = r && !r.error ? r.data : null;
      return acct && !acct.synthetic && acct.person === person ? acct : null;
    };
    const launch = async (a, { prompt, resume, job, project, forPerson, own } = {}) => {
      const creds = own ? { auth: "ambient" } : await credentials(a);
      // The assistant starts each thread knowing what works on this install right now (a quoted block, never instructions).
      let caps = "";
      if (a.kind === "assistant") {
        const c = await ctx.call("assistant.capabilities", { prompt: true }).catch(() => null);
        if (c && !c.error && c.data && typeof c.data.text === "string") caps = "\n\n" + c.data.text;
      }
      // Where the session runs, and the Vyre orientation for it: the agent's own folder (its instructions and context, written fresh from the stored truth) and, when it works in a project, that project's.
      const wd = job && project ? { project } : await workdir(a);
      const mine = config ? config.materialize(a) : null;
      let place = null;
      if (wd.project) {
        const pl = await ctx.call("projects.list", {}).catch(() => null);
        const p = pl && !pl.error && pl.data && Array.isArray(pl.data.projects) ? pl.data.projects.find((/** @type {any} */ x) => x.slug === wd.project) : null;
        if (p && p.home) place = { name: String(p.name || p.slug), dir: String(p.home), instructions: fs.existsSync(path.join(String(p.home), "AGENTS.md")), context: fs.existsSync(path.join(String(p.home), "context")) };
      }
      const oriented = orientation({ ...(mine ? { agent: { name: a.name, dir: mine.dir, instructions: mine.instructions, context: mine.context } } : {}), ...(place ? { project: place } : {}) });
      const input = { agent: a.name, agent_kind: a.kind, auth: creds.auth, append: preamble(a, { withWords: !mine }) + (oriented ? "\n\n" + oriented : "") + (config ? config.brief(a) : "") + caps, scope: await scope(a),
        ...(creds.env ? { env: creds.env } : {}), ...(creds.fallback ? { fallback: creds.fallback } : {}),
        ...(creds.budget_usd != null ? { budget_usd: creds.budget_usd } : {}), ...(a.model ? { model: a.model } : {}),
        ...(a.effort ? { effort: a.effort } : {}), ...(prompt ? { prompt } : {}), ...(job ? { purpose: "job", once: true } : {}),
        // the person this launch is FOR, so the agent gate (core/switchboard/asker-account.js agentLaunchGuard) judges them and not this module's own empty chain
        ...(forPerson ? { for_person: forPerson } : {}),
        // the chatter's own sign-in: named, so the switchboard runs the turn on it and the agent's credentials are not in the child at all
        ...(own ? { account: String(own.id), person: forPerson } : {}),
        // an agent working in a project runs in the PROJECT folder: its own agent folder (instructions, context, notes) is then the one extra folder it may read, never another agent's
        ...(mine && wd.project ? { read_only: [mine.dir] } : {}) };
      // A scheduled job is a side thread: it runs as the agent (credentials, scope, preamble) but never replaces the agent's own current thread.
      if (job) return use("threads.launch", { ...input, ...wd, name: a.name });
      const t = resume ? await use("threads.launch", { ...input, resume }) : await use("threads.launch", { ...input, ...wd, name: a.name });
      if (own) db.prepare("INSERT INTO agents_person_threads (agent, person, thread, at) VALUES (?,?,?,?) ON CONFLICT(agent, person) DO UPDATE SET thread = excluded.thread, at = excluded.at").run(a.name, String(forPerson), t.id, Date.now());
      else db.prepare("UPDATE agents_agents SET thread = ?, updated_at = ? WHERE name = ?").run(t.id, Date.now(), a.name);
      return t;
    };

    /** What an agent is doing, in the words the home and the Deck show. */
    const status = async a => {
      if (!a.thread) return { status: "new", doing: "not started", thread: null };
      const r = await ctx.call("threads.get", { thread: a.thread, limit: 1 });
      const t = r.data && r.data.thread;
      if (!t) return { status: "new", doing: "not started", thread: null };
      const doing = t.asks ? "waiting on your answer" : t.status === "working" ? "working" : t.status === "stopped" ? "stopped" : t.status === "starting" ? "starting" : "idle";
      return { status: t.status, doing, thread: t.id, auth: t.auth };
    };

    const fields = { kind: { type: "string", enum: ["assistant", "agent"] }, projects: {}, instructions: { type: "string" },
      skills: { type: "array", items: { type: "string" } }, computer: { type: "boolean" }, personal: { type: "boolean" }, model: { type: "string" }, effort: { type: "string", enum: EFFORTS },
      auth: { type: "object", properties: { vault: { type: "string" }, fallback: { type: "string" }, budget_usd: { type: "number" } } } };

    const checkProjects = p => {
      if (p === undefined) return;
      if (p !== "*" && !(Array.isArray(p) && p.every(x => typeof x === "string"))) throw new Error('projects must be "*" or a list of project slugs');
    };


    /**
     * An agent a non-staff person makes or edits can never exceed her: projects only ones she can read herself, never "*"; a computer, the personal-memory flag and credentials are the owner's and the admins'.
     * @param {any} meta @param {{ projects?: any, computer?: any, auth?: any, personal?: any }} i
     */
    const clamp = async (meta, i) => {
      if (await seesFull(meta)) return;
      const deny = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "denied" });
      if (i.projects === "*") throw deny("only the owner or an admin gives an agent every project; pick the projects you work in");
      if (Array.isArray(i.projects) && i.projects.length) {
        const me = await personOf(meta);
        for (const slug of i.projects) {
          const may = me ? await ctx.call("work.project.may-read", { project: String(slug), person: me }).catch(() => null) : null;
          if (!(may && !may.error && may.data && may.data.ok === true)) throw deny(`you cannot read the project ${slug} yourself, so an agent of yours cannot have it`);
        }
      }
      if (i.computer) throw deny("only the owner or an admin gives an agent a computer");
      if (i.personal === true) throw deny("only the owner or an admin lets an agent read personal memory");
      if (i.auth && typeof i.auth === "object" && Object.keys(i.auth).length) throw deny("an agent's credentials are the owner's to pick; leave them out and it runs on the AI account of whoever asks it, or ask the owner");
    };

    /** Only the assistant may drive other sessions, from inside its own thread. */
    // A label never grants: an agent is the assistant only by what vyred verified (meta.agent, meta.agentKind from the stored row); a label that
    // names an agent with nothing verified behind it is refused.
    const guard = (caller, what) => {
      const m = /^mcp:agent:(.+)$/.exec(String(caller || ""));
      if (!m) return;
      const v = /** @type {any} */ (calls.getStore());
      if (v && v.agent === m[1] && v.agentKind === "assistant") return;
      throw new Error(`only the assistant can ${what}; ${m[1]} is an agent`);
    };

    // A model's call (mcp or harness) is judged by what vyred verified, never the label: the verified assistant passes; a plain caller with
    // no verified thread and no agent never mutates; stopping an agent is the assistant's or the person's, not another session's.
    const modelMay = (meta, { sessionOk = false } = {}) => {
      const m = meta || {};
      if (!/^(?:mcp|harness)(?::|$)/.test(String(m.caller || ""))) return true;
      if (m.agent) return m.agentKind === "assistant";
      return sessionOk && typeof m.thread === "string" && m.thread !== "";
    };

    // For vyred only: the stored grant of an agent vyred has already verified (its thread's own
    // socket, or a vouched key), attached to meta so a tool that scopes by project reads what the
    // agent is really granted, never a filter the caller's own input or env carries.
    ctx.tool("agents.scope", {
      description: "The kind and stored project grant (\"*\" or a list of slugs) of one agent, for vyred to put on the meta of that agent's calls.", internal: true, callers: ["module"],
      input: { type: "object", required: ["name"], properties: { name: { type: "string" }, thread: { type: "string" } } },
      // A subagent's thread is narrowed to the tools it was started with, on top of whatever its parent is held to; never wider.
      run: async i => {
        const a = get(String(i.name));
        if (!a) return null;
        const sub = i.thread ? db.prepare("SELECT only FROM agents_subs WHERE thread = ? AND parent = ?").get(String(i.thread), a.name) : null;
        const own = a.builtin && a.name === ENGINEER.name ? [...ENGINEER.tools] : null;
        const narrowed = sub && sub.only ? JSON.parse(String(sub.only)) : null;
        const only = narrowed ? (own ? narrowed.filter((/** @type {string} */ t) => own.includes(t)) : narrowed) : own;
        return { kind: a.kind, projects: a.kind === "assistant" ? "*" : a.projects, ...(a.personal ? { personal: true } : {}), ...(only ? { only } : {}), ...(sub ? { subagent: true } : {}) };
      },
    });


    // ---- Owners, versions and changes by conversation (R031-09) -------------------------------------------------------------------------------------------------------------------------------
    // What an agent says and knows is its instructions, skills, model, effort and tags. A person (its owner or an admin) changes them directly and the change is a version. A model never does: it
    // PROPOSES (flows.propose { what: "agent", agent, patch }), the draft waits here, its owner or an admin says yes on one card (kernel/flows/proposals.js), and that yes applies it as a new version.
    // Permissions (projects, credentials, a computer) are not in a proposal: those are the person's own act, with the kernel's proof.
    const CHANGEABLE = ["instructions", "skills", "model", "effort", "tags"];
    const snapOf = a => ({ instructions: a.instructions ?? null, skills: a.skills || [], model: a.model ?? null, effort: a.effort ?? null, tags: a.tags || "" });
    const hashOf = o => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 24);
    /** The person a call is for: its chain's first hop when that is a person, else the Space's owner (the CLI and the Deck are the owner's). */
    const personOf = async meta => { if (!K) return ""; try { const c = await K.chain(meta); const h = c && c.hops && c.hops[0]; if (h && h.actor.kind === "person") return h.actor.id; } catch { /* no chain: the owner's surface */ } return String(K.owner || ""); };
    /**
     * Whether a call may see an agent's whole row (its instructions, tools, projects, credentials' mode): a call with no person on its chain (the owner's surfaces, the daemon), the owner, or an admin. Any other
     * person on the chain, a member, sees the roster only (see rosterRow).
     * @param {any} meta @returns {Promise<boolean>}
     */
    const seesFull = async meta => {
      if (!K) return true;   // no kernel, no Space and no members: nobody to keep it from
      let person = null;
      try { const c = await K.chain(meta); const h = c && Array.isArray(c.hops) ? c.hops.find((/** @type {any} */ x) => x && x.actor && x.actor.kind === "person") : null; person = h ? String(h.actor.id) : null; } catch { return false; }   // a chain that cannot be read is not the owner's surface either
      if (!person) return true;
      const canon = typeof K.canonicalPerson === "function" ? (/** @type {string} */ x) => K.canonicalPerson(x) : (/** @type {string} */ x) => x;
      if (K.owner && canon(person) === canon(String(K.owner))) return true;
      const m = typeof K.membership === "function" ? await Promise.resolve(K.membership(person, K.space)).catch(() => null) : null;
      return Boolean(m && m.member === true && (m.role === "owner" || m.role === "admin"));
    };
    /** What a member sees of an agent: who it is and whether it is busy. Never its instructions, tools, projects, computer, credentials' mode, thread or uid. @param {any} r */
    const rosterRow = r => ({ id: r.id, name: r.name, kind: r.kind, ...(r.role ? { role: r.role } : {}), model: r.model, status: r.status });
    /** The person on the call's chain, or null (the owner's surfaces, a call whose chain cannot be read). @param {any} meta @returns {Promise<string | null>} */
    const chainPerson = async meta => { if (!K) return null; try { const c = await K.chain(meta); const h = c && Array.isArray(c.hops) ? c.hops.find((/** @type {any} */ x) => x && x.actor && x.actor.kind === "person") : null; return h ? String(h.actor.id) : null; } catch { return null; } };
    /** May this call change or stop this agent: the owner, an admin and the owner's surfaces always; a member only an agent she made (the row's owner is its maker). @param {any} meta @param {any} a */
    const mayChange = async (meta, a) => {
      if (await seesFull(meta)) return true;
      const me = await chainPerson(meta);
      const canon = K && typeof K.canonicalPerson === "function" ? (/** @type {string} */ x) => K.canonicalPerson(x) : (/** @type {string} */ x) => x;
      return Boolean(me && a && a.owner && canon(me) === canon(String(a.owner)));
    };
    const notYours = (/** @type {string} */ what) => Object.assign(new Error(`Only the owner, an admin or the person who made this agent ${what}. Ask one of them.`), { code: "denied" });
    const ownerOnly = (/** @type {string} */ what) => Object.assign(new Error(`Only the owner or an admin ${what}. Ask them, or use the roster (agents.list) for who is here.`), { code: "denied" });
    const versionsOf = name => db.prepare("SELECT * FROM agents_versions WHERE agent = ? ORDER BY n DESC").all(name);
    /** Write the new field values, and the version that says what they were and are. */
    const writeVersion = (a, after, { by = null, approved_by = null, note = null } = {}) => {
      const before = snapOf(a), next = { ...before, ...after };
      if (hashOf(before) === hashOf(next)) return null;
      const n = (db.prepare("SELECT COALESCE(MAX(n), 0) AS n FROM agents_versions WHERE agent = ?").get(a.name)?.n ?? 0) + 1;
      db.prepare("UPDATE agents_agents SET instructions = ?, skills = ?, model = ?, effort = ?, tags = ?, updated_at = ? WHERE name = ?").run(next.instructions || null, JSON.stringify(next.skills || []), next.model || null, next.effort || null, next.tags || null, Date.now(), a.name);
      db.prepare("INSERT INTO agents_versions (agent, n, before, after, by, approved_by, note, at) VALUES (?,?,?,?,?,?,?,?)").run(a.name, n, JSON.stringify(before), JSON.stringify(next), by, approved_by, note, Date.now());
      return n;
    };
    /** Whose say it is over an agent: its owner, else any owner or admin of the Space (asked of the kernel by the host). */
    const cleanPatch = patch => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw Object.assign(new Error("a change is { instructions?, skills?, model?, effort?, tags? }"), { code: "bad_input" });
      const bad = Object.keys(patch).filter(k => !CHANGEABLE.includes(k));
      if (bad.length) throw Object.assign(new Error(`${bad.join(", ")} cannot be proposed: permissions (projects, credentials, a computer) are changed by the person themselves; a proposal changes ${CHANGEABLE.join(", ")}`), { code: "bad_input" });
      const out = {};
      if (patch.instructions !== undefined) { if (typeof patch.instructions !== "string" || patch.instructions.length > 20000) throw Object.assign(new Error("instructions are text of up to 20,000 characters"), { code: "bad_input" }); out.instructions = patch.instructions; }
      if (patch.skills !== undefined) { if (!Array.isArray(patch.skills) || patch.skills.some(x => typeof x !== "string" || x.length > 120) || patch.skills.length > 100) throw Object.assign(new Error("skills are a list of skill names"), { code: "bad_input" }); out.skills = patch.skills; }
      if (patch.model !== undefined) { if (patch.model !== null && typeof patch.model !== "string") throw Object.assign(new Error("model is a name"), { code: "bad_input" }); out.model = patch.model; }
      if (patch.effort !== undefined) { if (patch.effort !== null && !EFFORTS.includes(patch.effort)) throw Object.assign(new Error(`effort is one of ${EFFORTS.join(", ")}`), { code: "bad_input" }); out.effort = patch.effort; }
      if (patch.tags !== undefined) { if (!Array.isArray(patch.tags)) throw Object.assign(new Error("tags are a list of words"), { code: "bad_input" }); out.tags = changeTags("", { add: patch.tags }); }
      if (!Object.keys(out).length) throw Object.assign(new Error("that changes nothing"), { code: "bad_input" });
      return out;
    };
    const titleOfDraft = (d, a) => `Change ${a.name}: ${Object.keys(JSON.parse(d.patch)).join(", ")}?`.slice(0, 200);
    ctx.tool("agents.change.draft", {
      description: "Store a proposed change to an agent's words, skills, model, effort or tags and say whose yes it needs (its owner, else an admin). For the Flows proposals path (kind agent).", internal: true, callers: ["module"],
      input: { type: "object", required: ["agent", "patch", "proposer"], properties: { agent: { type: "string" }, patch: { type: "object" }, proposer: { type: "string" }, by: { type: "string" } } },
      run: async i => {
        const a = must(String(i.agent));
        if (a.kind === "assistant" && i.by && i.by !== a.name) throw Object.assign(new Error("only the person changes the assistant"), { code: "denied" });
        const patch = cleanPatch(i.patch);
        if (a.builtin && Object.keys(patch).some(k => !["instructions", "model", "effort"].includes(k))) throw Object.assign(new Error(`${a.name} is built in: only its instructions, model and effort change`), { code: "bad_input" });
        const hash = hashOf({ agent: a.name, patch, base: hashOf(snapOf(a)) });
        // the same change asked for again while it waits is the same draft (and so the same card)
        let d = db.prepare("SELECT * FROM agents_drafts WHERE agent = ? AND hash = ? AND state = 'open'").get(a.name, hash);
        if (!d) { const id = `chg_${mintUuid()}`; db.prepare("INSERT INTO agents_drafts (id, agent, patch, hash, proposer, by, at) VALUES (?,?,?,?,?,?,?)").run(id, a.name, JSON.stringify(patch), hash, String(i.proposer), i.by || null, Date.now()); d = db.prepare("SELECT * FROM agents_drafts WHERE id = ?").get(id); }
        const id = String(d.id);
        return { id, hash, agent: a.name, owner: a.owner, title: titleOfDraft(d, a), before: snapOf(a), after: { ...snapOf(a), ...patch } };
      },
    });
    ctx.tool("agents.change.title", {
      description: "The title a stored draft really has, or null when it is gone, settled, or its agent changed since it was drafted. For the proposals path.", internal: true, callers: ["module"],
      input: { type: "object", required: ["id", "hash"], properties: { id: { type: "string" }, hash: { type: "string" } } },
      run: async i => {
        const d = db.prepare("SELECT * FROM agents_drafts WHERE id = ?").get(String(i.id));
        const a = d && get(String(d.agent));
        if (!d || !a || d.state !== "open" || d.hash !== i.hash || d.hash !== hashOf({ agent: a.name, patch: JSON.parse(String(d.patch)), base: hashOf(snapOf(a)) })) return null;
        return titleOfDraft(d, a);
      },
    });
    ctx.tool("agents.change.apply", {
      description: "Apply a stored draft as a new version, on the owner's yes. For the proposals path.", internal: true, callers: ["module"],
      input: { type: "object", required: ["id", "hash", "approver"], properties: { id: { type: "string" }, hash: { type: "string" }, approver: { type: "string" } } },
      run: async i => {
        const d = db.prepare("SELECT * FROM agents_drafts WHERE id = ?").get(String(i.id));
        const a = d && get(String(d.agent));
        if (!d || !a || d.state !== "open" || d.hash !== i.hash) throw Object.assign(new Error("that change is no longer waiting; ask for it again (agents.versions shows what was applied)"), { code: "not_found" });
        if (d.hash !== hashOf({ agent: a.name, patch: JSON.parse(String(d.patch)), base: hashOf(snapOf(a)) })) throw Object.assign(new Error(`${a.name} changed since this was drafted: ask again`), { code: "conflict" });
        db.prepare("UPDATE agents_drafts SET state = 'applied' WHERE id = ?").run(d.id);
        const version = writeVersion(a, JSON.parse(String(d.patch)), { by: d.by || d.proposer, approved_by: String(i.approver) });
        await mirror.schedule();
        return { agent: a.name, version };
      },
    });

    ctx.tool("agents.mirror", {
      description: "Make the agent records equal the roster now, and say what changed (a level mirror changes nothing). For tests and repair.", internal: true, callers: ["module"],
      input: { type: "object", properties: {} },
      run: async () => { await mirror.schedule(); return mirror.reconcile(); },
    });

    ctx.tool("agents.versions", {
      description: "An agent's versions, newest first: what changed, who proposed it and who said yes. Roll back with agents.update { agent, rollback: n }.",
      input: { type: "object", required: ["agent"], properties: { agent: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } } },
      run: async (i, meta) => {
        guard(meta.caller, "read an agent's versions");
        if (!(await seesFull(meta))) throw ownerOnly("reads what an agent's instructions were");
        const a = must(String(i.agent));
        return { agent: a.name, owner: a.owner, versions: versionsOf(a.name).slice(0, Math.min(Number(i.limit) || 20, 100)).map(v => ({ n: v.n, by: v.by, approved_by: v.approved_by, note: v.note, at: v.at, before: JSON.parse(String(v.before)), after: JSON.parse(String(v.after)) })) };
      },
    });

    config = registerConfig(ctx, { db, root: agentsBase, must, mayChange, notYours, guard, modelMay, personOf, scope, seesFull,
      changed: () => { void mirror.schedule(); },
      staffOf: async person => {
        if (!K) return true;
        const canon = typeof K.canonicalPerson === "function" ? (/** @type {string} */ x) => K.canonicalPerson(x) : (/** @type {string} */ x) => x;
        if (K.owner && canon(person) === canon(String(K.owner))) return true;
        const m = typeof K.membership === "function" ? await Promise.resolve(K.membership(person, K.space)).catch(() => null) : null;
        return Boolean(m && (m.role === "owner" || m.role === "admin"));
      },
      chainPerson, roleOf: async person => {
        const m = K && typeof K.membership === "function" ? await Promise.resolve(K.membership(person, K.space)).catch(() => null) : null;
        if (m && m.role) return String(m.role);
        return null;
      },
      setWords: (a, text, by) => { writeVersion(a, { instructions: text.trim() || null }, { by, approved_by: by }); void mirror.schedule(); } });

    ctx.tool("agents.list", {
      description: "Every agent, the assistant first, with what each is doing now.",
      input: { type: "object", properties: {} },
      run: async (_, meta) => {
        const { caller } = meta;
        guard(caller, "list agents");
        const full = await seesFull(meta);
        const rows = db.prepare("SELECT * FROM agents_agents ORDER BY kind = 'assistant' DESC, name").all().map(shape);
        return Promise.all(rows.map(async a => (full ? ({ uid: a.uid, name: a.name, kind: a.kind, projects: a.projects, model: a.model, effort: a.effort, computer: a.computer, id: a.id, ...(a.personal ? { personal: true } : {}),
          // A built-in agent (the Engineer) says so, and says it only proposes: the app opens its chat and shows what it proposed as tasks in Now.
          ...(a.builtin ? { builtin: true, role: a.name, proposes_only: true, tools: a.name === ENGINEER.name ? [...ENGINEER.tools] : [] } : {}),
          // The Deck's agent page shows and edits the job from this list.
          instructions: a.instructions,
          auth: a.auth.vault ? "subscription" : a.auth.fallback ? "api-key" : "ambient", ...(await status(a)), ...(config ? await config.sharesFor(meta, a, true) : {}) }) : { ...rosterRow({ ...a, ...(a.builtin ? { role: a.name } : {}), ...(await status(a)) }), ...(config ? await config.sharesFor(meta, a, false) : {}) })));
      },
    });

    ctx.tool("agents.create", {
      description: "Make an agent: a name, its projects (\"*\" for all), its credentials (Vault items for the setup token and an API key fallback, with a budget), instructions and model. kind \"assistant\" makes the one assistant, which sees every project.",
      input: { type: "object", required: ["name"], properties: { name: { type: "string" }, ...fields } },
      // A person's surfaces and vyred's modules (onboarding makes the assistant), with no passkey:
      // making an agent is the person's own business. No model, the assistant included, and no guest.
      callers: ["cli", "local", "deck", "capsule", "module"],
      run: async (i, meta) => {
        const { caller } = meta;
        if (!NAME.test(i.name)) throw new Error("an agent's name is lowercase letters, digits and dashes");
        if (get(i.name)) throw new Error(`there is already an agent ${i.name}`);
        const kind = i.kind || "agent";
        // The approvals card says "your assistant" for the assistant: an agent that is not the assistant may not carry the name, or it could pose as it (a name already held keeps working; the card tells them apart by kind).
        if (String(i.name).trim().toLowerCase() === "assistant" && kind !== "assistant") throw new Error("assistant is the name of your assistant: pick another name for this agent");
        if (kind === "assistant" && db.prepare("SELECT 1 FROM agents_agents WHERE kind = 'assistant'").get()) throw new Error("there is already an assistant; agents.update changes it");
        checkProjects(i.projects);
        await clamp(meta, i);
        const projects = kind === "assistant" ? "*" : i.projects ?? [];
        // Written before the row exists (option (a)): a failed grant means no agent was ever
        // created, rather than one whose memory access silently does not match what it says.
        const uid = `agt_${mintUuid()}`;
        if (kind !== "assistant") await syncAccess(uid, [], projects, meta);
        const now = Date.now();
        db.prepare(`INSERT INTO agents_agents (name, kind, projects, auth, instructions, skills, computer, model, effort, created_at, updated_at, uid, owner)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(i.name, kind, JSON.stringify(projects), JSON.stringify(i.auth || {}), i.instructions || null,
          JSON.stringify(i.skills || []), i.computer ? 1 : 0, i.model || null, i.effort || null, now, now, uid, await personOf(meta));
        if (i.personal === true && kind !== "assistant") db.prepare("UPDATE agents_agents SET personal = 1 WHERE name = ?").run(i.name);
        await mirror.schedule();
        const note = kind === "assistant" ? null : await becomeActor(i.name, meta);
        return note ? { ...get(i.name), note } : get(i.name);
      },
    });

    ctx.tool("agents.update", {
      description: "Change an agent (name it by name or agent): its projects, credentials, instructions, skills, computer, model or effort. Takes effect on its next thread.",
      // Every other agents.* tool names its agent `agent`, so update takes that too; the Deck's
      // "Give a computer" sent it and got "input.name is required".
      input: { type: "object", properties: { name: { type: "string" }, agent: { type: "string" }, tags: { type: "array", items: { type: "string" } }, rollback: { type: "integer", minimum: 0, description: "restore the instructions, skills, model, effort and tags as of this version (0 is how the agent began); agents.versions lists them" }, ...fields } },
      // A person's surfaces, with no passkey (the owner's Deck over the tailnet included). Of the
      // models, only the assistant, and only for its words and model: never credentials, budget,
      // projects, skills or a computer. Every other agent, a bare MCP session and a guest are refused.
      callers: ["cli", "local", "deck", "capsule", "module", "mcp"],
      run: async (i, meta) => {
        const { caller } = meta;
        if (/^mcp(?=$|[\s:])/.test(String(caller))) {
          // A model never edits an agent: it proposes, and the agent's owner says yes on one card (R031-09).
          throw Object.assign(new Error('changing agents is the person\'s; to ask for a change, propose it: flows.propose { what: "agent", agent: "<name>", patch: { instructions?, skills?, model?, effort?, tags? } }. Its owner approves; each approved change is a version you can roll back'), { code: "denied" });
        }
        if (i.name !== undefined && i.agent !== undefined && i.name !== i.agent) throw new Error("name and agent say different agents; give one");
        const who = i.name ?? i.agent;
        if (who === undefined) throw new Error("say which agent: name is required");
        const a = must(who);
        if (!(await mayChange(meta, a))) throw notYours("changes it");
        // A built-in agent keeps its shape: only its words, model and effort change.
        if (a.builtin) { const extra = Object.keys(i).filter(k => i[k] !== undefined && !["name", "agent", "instructions", "model", "effort"].includes(k)); if (extra.length) throw Object.assign(new Error(`${a.name} is built in: only its instructions, model and effort change`), { code: "denied" }); }
        checkProjects(i.projects);
        await clamp(meta, { projects: i.projects, computer: i.computer, auth: i.auth, personal: i.personal });
        if (i.kind && i.kind !== a.kind) throw new Error("an agent's kind is fixed when it is made");
        if (a.kind === "assistant" && i.projects !== undefined && i.projects !== "*") throw new Error("the assistant sees every project");
        const next = { ...a, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => v !== undefined && k !== "name" && k !== "agent")) };
        // Option (a): before the row changes, so a failed grant or an explicit-revoke refusal
        // means the edit never took either. Never for the assistant (a.kind === "assistant"
        // above already refuses any real change to its projects, so there is nothing to sync).
        if (a.kind !== "assistant" && i.projects !== undefined) await syncAccess(a.uid, a.projects, next.projects, meta);
        db.prepare(`UPDATE agents_agents SET projects = ?, auth = ?, computer = ?, personal = ?, updated_at = ? WHERE name = ?`)
          .run(JSON.stringify(next.projects), JSON.stringify(next.auth || {}), next.computer ? 1 : 0, next.personal === true && a.kind !== "assistant" ? 1 : 0, Date.now(), a.name);
        // what it says and knows is versioned (R031-09): the person's own edit is a version approved by that person; `rollback: n` restores the state as of version n (0 is how it began)
        let after = { instructions: next.instructions, skills: next.skills, model: next.model, effort: next.effort, tags: i.tags !== undefined ? changeTags("", { add: Array.isArray(i.tags) ? i.tags : [] }) : a.tags };
        let note = null;
        if (i.rollback !== undefined) {
          const n = Number(i.rollback);
          const vs = versionsOf(a.name).reverse();
          const target = n === 0 ? (vs[0] ? JSON.parse(String(vs[0].before)) : null) : (vs.find(v => v.n === n) ? JSON.parse(String(vs.find(v => v.n === n).after)) : null);
          if (!target) throw Object.assign(new Error(`${a.name} has no version ${n} (agents.versions lists its versions)`), { code: "not_found" });
          after = target; note = `rolled back to version ${n}`;
        }
        const person = await personOf(meta);
        writeVersion(a, after, { by: person, approved_by: person, note });
        await mirror.schedule();
        return get(a.name);
      },
    });

    ctx.tool("agents.ask", {
      description: "Talk to an agent: text goes to its thread (started if needed). Returns the reply, or a permission question to answer with threads.answer.",
      input: { type: "object", required: ["agent", "text"], properties: { agent: { type: "string" }, text: { type: "string" }, surface: { type: "string" }, wait: { type: "boolean" },
        mentions: { type: "array", maxItems: 8, items: { type: "object", required: ["kind", "id"], properties: { kind: { type: "string" }, id: { type: "string" }, name: { type: "string" } } }, description: "The # tags the composer picked, from a person's own surface only (as when a person sends to a thread): each is resolved for the agent's thread." },
        pasted: { type: "array", maxItems: 20, items: { type: "string" }, description: "The spans of the text the person pasted: a #Name inside one tags nothing." } } },
      // Callable by a model session too (the assistant asks its agents; a plain session may ask within its own project): who actually may is decided in the body (modelMay, HD-9).
      callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module", "mcp", "harness"],
      run: async (i, meta0) => {
        const { caller } = meta0;
        guard(caller, "talk to other agents");
        if (!modelMay(meta0, { sessionOk: true })) throw Object.assign(new Error("an unidentified caller cannot talk to agents; ask the person to sign in first"), { code: "denied" });
        // An unnamed model session (mcp or harness, no agent behind it) is no one's agent and asks nobody: it has no grants of its own to ask under.
        if (!isPerson(caller) && !meta0.firstParty && !meta0.agent && /^(?:mcp|harness)(?::|$)/.test(String(caller || ""))) throw Object.assign(new Error("an unnamed model session asks no agent: it has no agent grants of its own to act under; ask the person to put the question to the agent"), { code: "denied" });
        // HD-9: a model's words go out as this module, which skips the thread scope checks, so a session may not use them to reach a wider agent than itself: the assistant (every project)
        // is the person's and the verified assistant's to ask, and an agent only reaches agents whose projects are within its own grant.
        if (!isPerson(caller) && !meta0.firstParty && meta0.agentKind !== "assistant") {
          const target = get(String(i.agent));
          const within = target && Array.isArray(target.projects) && (!Array.isArray(meta0.granted) || target.projects.every(p => meta0.granted.includes(p)));
          if (target && !within) throw Object.assign(new Error(`${target.name} sees more than this session does: ask the person, who can ask it directly`), { code: "denied" });
        }
        // A person's own tags ride with the words, as that person (threads.send hears their turn); from any other caller they are dropped.
        const tagged = isPerson(caller) && ((Array.isArray(i.mentions) && i.mentions.length) || (Array.isArray(i.pasted) && i.pasted.length));
        // The person typing an ask is the person choosing to spend, so the daily spend cap (core/spend) does not hold it;
        // it is told instead. What agents and automations start on their own is what the cap holds.
        const byPerson = isPerson(caller);
        const told = { done: false };
        const capNotice = async thread => {
          if (!byPerson || told.done) return;
          told.done = true;
          try {
            const c = (await ctx.call("spend.check", { provider: "claude" })).data;
            if (c && c.capped) await ctx.call("threads.notice", { thread, text: `The daily spend cap is reached ($${Number(c.spent).toFixed(2)} of $${Number(c.cap).toFixed(2)}). You asked, so this went through. To change the cap: vyre spend raise ${c.scope || "claude"} <dollars>` });
          } catch { /* no spend module: no cap to tell */ }
        };
        // A person's ask is relayed as that person (threads.send hears it as their own turn, and the daily spend cap, which holds
        // what agents and modules start on their own, does not hold it); any other caller's goes as this module and stays held.
        // A thread on the chatter's own account is the agents module's: her words go in as this module (the thread's account is hers already), not as a chat she was never put in.
        let ownThread = false;
        const sendWords = async thread => {
          await capNotice(thread);
          if (!byPerson || ownThread) return use("threads.send", { thread, text: i.text, surface });
          const r = await ctx.call("threads.send", { thread, text: i.text, surface, ...(tagged ? { mentions: i.mentions || [], pasted: i.pasted || [] } : {}) }, { as: String(caller) });
          if (r.error) throw new Error(r.error.message);
          return r.data;
        };
        const a = must(i.agent);
        // A person talks to an agent, the assistant included (it sees every project), only if it is theirs or shared with them (Can use or Can edit); the owner and the admins always may.
        if (isPerson(caller) && config && (await config.levelOf(meta0, a)) === "none") throw Object.assign(new Error(`${a.name} is not shared with you. Ask its owner for Can use.`), { code: "denied" });
        const surface = i.surface || String(caller || "vyre");
        // whoever the call acts for (her own session's person included), so the gate judges her when the agent starts for her words
        const forPerson = (await personOf(meta0)) || undefined;
        // Listen before sending, so a fast reply is not missed.
        let thread = null;
        const heard = { text: "", cost: 0 };
        let finish;
        const done = new Promise(r => { finish = r; });
        const offs = [
          ctx.events.on("thread.text", e => { if (e.thread === thread && e.payload.done && !e.payload.notice && e.payload.kind !== "reasoning") heard.text = e.payload.text; }),
          ctx.events.on("thread.finished", e => { if (e.thread === thread) finish({ ok: e.payload.ok, cost_usd: e.payload.cost_usd, ...(e.payload.error ? { note: e.payload.error } : {}) }); }),
          ctx.events.on("ask.raised", e => { if (e.thread === thread) finish({ ok: false, ask: { id: e.payload.ask, tool: e.payload.tool, summary: e.payload.summary, destination: e.payload.destination }, note: "waiting on your answer" }); }),
          ctx.events.on("thread.stopped", e => { if (e.thread === thread) finish({ ok: false, note: `the thread stopped: ${e.payload.reason}` }); }),
        ];
        try {
          // a person with her own AI sign-in talks to the agent on a thread of her own, on her own account
          const own = a.kind === "agent" ? await ownAccount(a, forPerson) : null;
          ownThread = Boolean(own);
          const mineRow = own ? /** @type {any} */ (db.prepare("SELECT thread FROM agents_person_threads WHERE agent = ? AND person = ?").get(a.name, String(forPerson))) : null;
          const curId = own ? (mineRow ? String(mineRow.thread) : null) : a.thread;
          const cur = curId ? (await ctx.call("threads.get", { thread: curId, limit: 1 })).data?.thread : null;
          if (!cur) {
            // A new thread learns its id only from the launch, so the listeners key on it after;
            // the reply cannot beat a model's first token back.
            const t = await launch(a, { forPerson, own });
            thread = t.id;
            const s = await sendWords(thread);
            if (!s.sent) return { agent: a.name, thread, ok: false, text: "", note: s.note };
          } else {
            thread = cur.id;
            if (cur.status === "stopped") await launch(a, { resume: cur.id, forPerson, own });
            const s = await sendWords(thread);
            if (!s.sent) return { agent: a.name, thread, ok: false, text: "", note: s.note };
          }
          if (i.wait === false) return { agent: a.name, thread, ok: true, sent: true, text: "" };
          const r = await within(done, ASK_WAIT_MS, { ok: false, note: "still working; the reply will stream to the thread" });
          return { agent: a.name, thread, text: heard.text, ...(/** @type {object} */ (r)) };
        } finally {
          for (const off of offs) off();
          // The keyboard is given back once the question is asked. Every word still goes through
          // the one process vyred owns, so there is no second writer on the transcript; holding
          // the lease past the reply would only lock the user's other screens out of the agent.
          // Released as the one who typed: the person for a person's ask (the lease is theirs), this module otherwise (a surface name is never an identity).
          if (thread && i.wait !== false) await ctx.call("threads.release", { thread, surface }, ...(byPerson ? [{ as: String(caller) }] : []));
        }
      },
    });

    ctx.tool("agents.rollover", {
      callers: ["cli", "local", "deck", "capsule", "module"], // the assistant rolls its day from an event, with no person as original caller; the body allows module:assistant and the person only
      description: "Start a fresh thread for an agent (the assistant's daily thread) and make it the agent's current one, optionally seeded with a first message. The old thread is left as it is, and work in it goes on. Refused while the current thread is working or holds a question.",
      input: { type: "object", required: ["agent"], properties: { agent: { type: "string" }, seed: { type: "string" } } },
      run: async (i, { caller }) => {
        if (!/^(module:assistant|cli|local|deck|capsule)$/.test(String(caller || ""))) throw Object.assign(new Error("only the assistant module or the person rolls a thread"), { code: "denied" });
        const a = must(i.agent);
        const st = await status(a);
        if (st.doing === "working" || st.doing === "waiting on your answer") throw Object.assign(new Error(`${a.name} is ${st.doing}; wait until it is idle, then roll the thread again`), { code: "busy" });
        const t = await launch(a, i.seed ? { prompt: i.seed } : {});
        return { agent: a.name, thread: t.id, previous: a.thread };
      },
    });

    ctx.tool("agents.job", {
      description: "Run one scheduled job as an agent: a side thread with the agent's own credentials, project scope and preamble, leaving its current thread alone. For the planner; a job in a project the agent no longer reaches is refused.",
      internal: true, callers: ["module"],
      input: { type: "object", required: ["agent", "prompt"], properties: { agent: { type: "string" }, prompt: { type: "string" }, project: { type: "string" } } },
      run: async (i, { caller }) => {
        if (String(caller || "") !== "module:planner") throw Object.assign(new Error("only the planner runs an agent's jobs"), { code: "denied" });
        const a = must(i.agent);
        if (i.project && a.projects !== "*" && !a.projects.includes(i.project)) throw Object.assign(new Error(`${a.name} has no access to ${i.project}: the person must give it that project first`), { code: "denied" });
        const t = await launch(a, { prompt: i.prompt, job: true, project: i.project });
        return { agent: a.name, thread: t.id };
      },
    });


    // ---- Subagents (R031-07) ---------------------------------------------------------------------------------------------------------------------------------------------------------------
    // `agents.spawn` starts a short-lived helper for one job. It is the PARENT agent in a thread of its own (same credentials, same projects, the same kernel actor), so it can hold nothing the parent does
    // not; its tool list can only be shorter (a list it names must be inside the parent's own, and a helper never starts helpers). It is announced with the same `summon.*` events teammates use, so the
    // activity feed (core/stream/activity.js) nests its steps under one row in the parent's conversation, and it ends with its turn.
    const SUB_MAX = 5;
    const subRow = id => db.prepare("SELECT * FROM agents_subs WHERE id = ?").get(id);
    ctx.tool("agents.spawn", {
      description: "Start a short-lived helper for one job, working as you with your access or less; it ends when its turn does. Put everything in task.",
      input: { type: "object", required: ["task"], properties: { task: { type: "string", maxLength: 8000, description: "Everything the helper needs; it cannot start helpers of its own." }, label: { type: "string", maxLength: 40 }, tools: { type: "array", maxItems: 100, items: { type: "string", maxLength: 120 }, description: "A shorter list of tool names than yours." }, project: { type: "string" } } },
      callers: ["mcp", "harness", "cli", "local", "deck", "capsule", "module"],
      run: async (i, meta) => {
        const parent = meta.agent ? get(String(meta.agent)) : null;
        if (!parent || !meta.thread) throw Object.assign(new Error("a helper is started by an agent from its own thread: there is none behind this call; call it from an agent's own thread"), { code: "denied" });
        if (db.prepare("SELECT 1 FROM agents_subs WHERE thread = ?").get(String(meta.thread))) throw Object.assign(new Error("a helper does not start helpers; ask the agent that started you"), { code: "denied" });
        if (db.prepare("SELECT COUNT(*) AS n FROM agents_subs WHERE parent_thread = ? AND state = 'running'").get(String(meta.thread)).n >= SUB_MAX) throw Object.assign(new Error(`at most ${SUB_MAX} helpers at once; wait for one to finish`), { code: "busy" });
        const task = String(i.task || "").trim();
        if (!task) throw Object.assign(new Error("say what the helper is to do"), { code: "bad_input" });
        // never wider than the parent: its tool list (when it is held to one) and its projects
        const mine = Array.isArray(meta.agentOnly) ? meta.agentOnly.filter((/** @type {string} */ t) => t !== "agents.spawn") : null;   // a helper never starts helpers, whatever its parent holds
        let only = null;
        if (i.tools !== undefined) {
          if (!Array.isArray(i.tools) || i.tools.some((/** @type {any} */ t) => typeof t !== "string")) throw Object.assign(new Error("tools is a list of tool names"), { code: "bad_input" });
          const extra = mine ? i.tools.filter((/** @type {string} */ t) => !mine.includes(t)) : [];
          if (extra.length) throw Object.assign(new Error(`a helper cannot hold more than you do: ${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} not yours; pass only tools you hold`), { code: "denied" });
          only = i.tools;
        } else only = mine;
        if (i.project && parent.projects !== "*" && !parent.projects.includes(String(i.project))) throw Object.assign(new Error(`${parent.name} has no access to ${i.project}: the person must give it that project first`), { code: "denied" });
        const id = `sub_${mintUuid()}`, label = String(i.label || "helper").replace(/[^\w .-]/g, "").slice(0, 40) || "helper";
        db.prepare("INSERT INTO agents_subs (id, parent, parent_thread, label, only, project, at) VALUES (?,?,?,?,?,?,?)").run(id, parent.name, String(meta.thread), label, only ? JSON.stringify(only) : null, i.project ? String(i.project) : null, Date.now());
        const ev = (/** @type {string} */ type, /** @type {any} */ more = {}) => ctx.events.emit(type, { request: id, teammate: parent.name, project: i.project ? String(i.project) : "", reply_to: String(meta.thread), role: `helper: ${label}`, sub: true, ...more });
        ev("summon.queued", { text: task.replace(/\s+/g, " ").slice(0, 300) });
        try {
          const early = new Set();
          const off = ctx.events.on("thread.finished", e => early.add(e.thread));
          let t;
          try { t = await launch(parent, { prompt: task, job: true, project: i.project }); } finally { off(); }
          db.prepare("UPDATE agents_subs SET thread = ? WHERE id = ?").run(t.id, id);
          ev("summon.started"); ev("summon.thread", { thread: t.id });
          const done = async () => {
            const row = subRow(id);
            if (!row || row.state !== "running") return;
            let result = "";
            try { const g = await ctx.call("threads.get", { thread: t.id, limit: 1 }); result = String(g.data?.thread?.last_line || "").replace(/\s+/g, " ").trim().slice(0, 600); } catch { /* the helper's words stay in its thread */ }
            db.prepare("UPDATE agents_subs SET state = 'done', result = ?, ended = ? WHERE id = ?").run(result, Date.now(), id);
            ev("summon.finished", { status: "done", result });
          };
          if (early.has(t.id)) await done(); else { const stop = ctx.events.on("thread.finished", e => { if (e.thread === t.id) { stop(); void done(); } }); }
          return { helper: id, thread: t.id, label, tools: only };
        } catch (e) {
          db.prepare("UPDATE agents_subs SET state = 'failed', result = ?, ended = ? WHERE id = ?").run(String(/** @type {Error} */ (e).message).slice(0, 300), Date.now(), id);
          ev("summon.finished", { status: "failed", result: `could not start: ${/** @type {Error} */ (e).message}` });
          throw e;
        }
      },
    });

    ctx.tool("agents.threads", {
      description: "An agent's threads, newest first.",
      input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
      run: async ({ agent }, meta) => { const { caller } = meta; guard(caller, "read other agents"); if (!(await seesFull(meta))) throw ownerOnly("reads another agent's threads"); if (!modelMay(meta)) throw Object.assign(new Error("only the assistant or the person reads another agent's threads"), { code: "denied" }); must(agent); return use("threads.list", { agent }); },
    });

    ctx.tool("agents.usage", {
      description: "What each agent has used: turns, threads, time, tokens, cost, budget left and the last rate-limit report. With no agent, every agent.",
      input: { type: "object", properties: { agent: { type: "string", description: "Leave out for every agent; agent null then covers threads no agent ran." }, since: { type: "integer", description: "ms since epoch." } } },
      run: async ({ agent, since }, meta) => {
        const { caller } = meta;
        guard(caller, "read other agents' usage");
        if (!(await seesFull(meta))) throw ownerOnly("reads what agents have used");
        if (!modelMay(meta)) throw Object.assign(new Error("only the assistant or the person reads other agents' usage"), { code: "denied" });
        if (agent) must(agent);
        const rows = await use("threads.usage", { ...(agent ? { agent } : {}), ...(since ? { since } : {}) });
        const used = new Map(rows.map(r => [r.agent, r]));
        const zero = { turns: 0, threads: 0, duration_ms: 0, cost_usd: 0, api_cost_usd: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, by_auth: {}, limit: null, last_at: null };
        const agents = agent ? [must(agent)] : db.prepare("SELECT * FROM agents_agents ORDER BY kind = 'assistant' DESC, name").all().map(shape);
        const out = agents.map(a => {
          const budget = typeof a.auth.budget_usd === "number" ? a.auth.budget_usd : null;
          const total = spent(a.name);
          return { ...zero, ...(used.get(a.name) || {}), agent: a.name, kind: a.kind,
            auth: a.auth.vault ? "subscription" : a.auth.fallback ? "api-key" : "ambient",
            budget_usd: budget, spent_usd: total, left_usd: budget == null ? null : Math.max(0, budget - total) };
        });
        if (!agent && used.has(null)) out.push({ ...zero, ...used.get(null), agent: null, kind: null, auth: "ambient", budget_usd: null, spent_usd: 0, left_usd: null });
        return out;
      },
    });

    ctx.tool("agents.history", {
      description: "Past conversations with an agent (or every agent), newest last: what was asked, the answer, when, and the thread.",
      input: { type: "object", properties: { agent: { type: "string" }, limit: { type: "integer" }, before: { type: "integer", description: "An exchange id: the page before it." } } },
      run: async ({ agent, limit, before }, meta) => {
        const { caller } = meta;
        guard(caller, "read other agents' conversations");
        if (!(await seesFull(meta))) throw ownerOnly("reads other agents' conversations");
        if (!modelMay(meta)) throw Object.assign(new Error("only the assistant or the person reads other agents' conversations"), { code: "denied" });
        if (agent) must(agent);
        return use("threads.history", { ...(agent ? { agent } : {}), ...(limit ? { limit } : {}), ...(before ? { before } : {}) });
      },
    });

    // Deleting is a person's decision: no model, not even the assistant, removes an agent.
    ctx.tool("agents.delete", {
      description: "Remove an agent's record and its spend. Refused while one of its threads is running (agents.stop first), and for the assistant. Its threads' transcripts and events stay.",
      input: { type: "object", required: ["agent"], properties: { agent: { type: "string" }, id: { type: "string", description: "The agent's id (agents.list shows it): when given, a different agent that now has the same name is not deleted" } } },
      callers: ["cli", "local", "deck", "capsule"],
      run: async ({ agent, id }, meta) => {
        const a = must(agent);
        if (!(await mayChange(meta, a))) throw notYours("removes it");
        if (id !== undefined && String(id) !== a.id) throw Object.assign(new Error(`no agent ${agent} with that id (agents.list shows them; leave id out to go by name)`), { code: "not_found" });
        if (a.builtin) throw Object.assign(new Error(`${a.name} is built in and stays; agents.stop stops its threads instead`), { code: "denied" });
        if (a.kind === "assistant") throw new Error(`${a.name} is the assistant; there must be one, so change it with agents.update instead`);
        const running = (await use("threads.list", { agent })).filter(t => t.status !== "stopped");
        if (running.length) throw new Error(`${a.name} has ${running.length} running thread${running.length === 1 ? "" : "s"}; stop ${running.length === 1 ? "it" : "them"} first: vyre agents stop ${a.name}`);
        // the agent is gone: its project reach grants are revoked first, so a failed revoke means the delete never happened either
        // Reach is a kernel grant keyed by the agent's stable id, so a delete with no person to revoke it would leave live grants behind. It is refused instead, never half done.
        if (K && K.grants) {
          if (!(await hasPerson(meta))) throw Object.assign(new Error("deleting an agent takes back what it was given, which is the person's own act; this call carries no person"), { code: "denied" });
          await revokeReach(K, meta, { agent: a.uid });
          const { chain, proof } = await (await import("../../lib/project-reach.js")).asPerson(K, meta);
          // Whatever was given to the agent's NAME goes with it (task grants, chat seats): a new agent made later under the same name must inherit nothing, and removing the actor alone leaves those grants dormant,
          // woken by registering the name again. The grants of its stable id went above.
          { const all = await K.grants.list(chain, {}); for (const g of (Array.isArray(all) ? all : all && all.grants ? all.grants : [])) if (g.status === "active" && g.subject && g.subject.kind === "actor" && g.subject.actor && g.subject.actor.kind === "agent" && String(g.subject.actor.id) === a.name) await K.grants.revoke(chain, g.id, "the agent was deleted", proof); }
          for (const id of [a.uid, a.name]) {   // the stable id (reach grants) and the name (tasks, chats)
            try { await K.grants.removeActor(chain, { kind: "agent", id, space: K.space }, proof); } catch (e) { const c = String(/** @type {any} */ (e).code || ""); if (c !== "not_found" && c !== "unknown") throw e; }
          }
        }
        db.prepare("DELETE FROM agents_spend WHERE agent = ?").run(a.name);
        db.prepare("DELETE FROM agents_agents WHERE name = ?").run(a.name);
        if (config) await config.clearShared(a).catch(() => {});
        for (const t of ["agents_context_links", "agents_vault_items"]) db.prepare(`DELETE FROM ${t} WHERE agent = ?`).run(a.name);
        await mirror.schedule();
        return { agent: a.name, deleted: true };
      },
    });

    // The stable id of an agent, for the modules that make grants for it (projects, the plugin agent): the module's own call, never a person's or a model's.
    ctx.tool("agents.credentials", {
      description: "The sign-in picked for an agent (its vault item, fallback key and budget) as a launch takes it: { auth, env, fallback, budget_usd }. For the team module, which starts a teammate's turn itself.",
      input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
      callers: ["module"],
      run: async ({ agent }, meta = {}) => {
        if (String((meta && meta.caller) || "") !== "module:team") throw Object.assign(new Error("an agent's launch credentials are for the team module only; start the agent with agents.ask instead"), { code: "not_allowed" });
        return credentials(must(String(agent).toLowerCase()));
      },
    });
    ctx.tool("agents.uid", {
      description: "An agent's stable id (the kernel's grants name it, never the name): { uid }; given a uid, its name: { name }. For the projects, plugin-agent and vault modules.",
      input: { type: "object", properties: { name: { type: "string" }, uid: { type: "string" } } },
      callers: ["module"],
      run: async ({ name, uid }, meta = {}) => {
        const c = String((meta && meta.caller) || "");
        if (c !== "module:projects" && c !== "module:pluginagent" && c !== "module:vault") throw Object.assign(new Error("looking up an agent's uid is for the projects, plugin-agent and vault modules only; agents.list shows the agents"), { code: "denied" });
        if (uid !== undefined) { const r = /** @type {any} */ (db.prepare("SELECT name FROM agents_agents WHERE uid = ?").get(String(uid))); return { name: r ? String(r.name) : null }; }
        return { uid: must(String(name).toLowerCase()).uid };
      },
    });

    ctx.tool("agents.stop", {
      description: "Stop every running thread of an agent. Its record and transcripts stay.",
      input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
      run: async ({ agent }, meta0) => {
        const { caller, ...meta } = meta0;
        guard(caller, "stop agents");
        if (!modelMay({ caller, ...meta })) throw Object.assign(new Error("stopping an agent is the assistant's or the person's, not another session's"), { code: "denied" });
        if (!(await mayChange(meta0, must(agent)))) throw notYours("stops it");
        const ts = await use("threads.list", { agent });
        const stopped = [];
        for (const t of ts) if (t.status !== "stopped") { await use("threads.stop", { thread: t.id }); stopped.push(t.id); }
        return { agent, stopped };
      },
    });

    // The switchboard asks for this when someone types into an agent's stopped thread: only
    // this module can give it the agent's credentials and scope again. A person may ask for it
    // too (`vyre agents resume`), for the agent's latest thread by default; theirs is checked:
    // the thread must be the agent's own, and a running one is left as it is. No model may.
    ctx.tool("agents.resume", {
      description: "Resume one of an agent's threads (its latest by default) with its credentials and scope. A thread already running is left as it is ({ running: true }).",
      callers: ["cli", "local", "deck", "capsule", "module"],
      input: { type: "object", required: ["agent"], properties: { agent: { type: "string" }, thread: { type: "string" } } },
      run: async ({ agent, thread }, meta0) => {
        const { caller } = meta0;
        const a = must(agent);
        if (!(await mayChange(meta0, a))) throw notYours("resumes it");
        if (String(caller || "").startsWith("module:")) {
          if (!thread) throw new Error("thread is required");
          return launch(a, { resume: thread });
        }
        const id = thread || a.thread;
        if (!id) throw new Error(`${a.name} has no thread to resume yet; vyre agents ask ${a.name} <text> starts one`);
        const r = await ctx.call("threads.get", { thread: id, limit: 1 });
        const t = r.data && r.data.thread;
        if (!t || t.agent !== a.name) throw new Error(`${id} is not one of ${a.name}'s threads`);
        if (t.status !== "stopped") return { ...t, running: true };
        return launch(a, { resume: id });
      },
    });

    // the agent records follow the roster from the first moment, after every change to it, and after any change made to a record by hand (put back)
    void mirror.schedule();
    const k0 = ctx.kernel;
    if (k0 && k0.events && typeof k0.events.subscribe === "function" && typeof k0.serviceChain === "function") {
      try { k0.events.subscribe(k0.serviceChain("agents"), "agents-mirror", {}, async (/** @type {any} */ e) => { if (e && /^agent\.(created|updated|removed)$/.test(e.type)) await mirror.schedule(); }, { batch: true }); } catch { /* no event feed in this kernel: the roster's own changes still schedule it */ }
    }

    return { async stop() {} };
  },
};
