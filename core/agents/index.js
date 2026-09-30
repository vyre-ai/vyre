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

import fs from "node:fs";
import path from "node:path";
import { isPerson } from "../../lib/caller.js";

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
];

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
export function preamble(a) {
  const scope = a.projects === "*" ? "every project on this machine" : a.projects.length ? `only these projects: ${a.projects.join(", ")}` : "no project";
  const lines = a.kind === "assistant"
    ? [`You are ${a.name}, the user's assistant in Vyre. You can see ${scope}.`,
       "You can start, drive, monitor and stop any Claude Code session with the vyre MCP tools: threads_start, threads_send, threads_list, threads_get, threads_stop, and talk to other agents with agents_ask.",
       "Permission questions in any session are answered by the user, never by you. When a session is waiting on one, tell the user what it asks.",
       "To watch a thread for the user, call threads_watch with {thread, notify: \"capsule\", note: \"<a short label>\"}.",
       "To drive a thread for the user (\"tell the site thread to run the tests and report back\"), call threads_send, then set that watch. If another surface holds the thread's keyboard, threads_send says who; tell the user rather than taking it.",
       "When a watch fires, the user sees it in the Capsule and on their devices. Do not poll threads_get to wait for it."]
    : [`You are ${a.name}, an agent in Vyre. You may use context from ${scope}, and from nothing outside it.`];
  if (a.instructions) lines.push("", String(a.instructions));
  return lines.join("\n");
}

/** agents.update fields that change only what an agent says or which model says it. */
const PLAIN_UPDATE = new Set(["name", "agent", "instructions", "model", "effort", "description"]);

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */

export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const root = ctx.paths ? ctx.paths.root : process.env.VYRE_HOME || "";

    const shape = r => r && ({ name: String(r.name), kind: String(r.kind), projects: JSON.parse(String(r.projects)), auth: JSON.parse(String(r.auth)),
      instructions: r.instructions == null ? null : String(r.instructions), skills: JSON.parse(String(r.skills)), computer: Boolean(r.computer),
      model: r.model == null ? null : String(r.model), effort: r.effort == null ? null : String(r.effort), thread: r.thread == null ? null : String(r.thread) });
    const get = name => shape(db.prepare("SELECT * FROM agents_agents WHERE name = ?").get(name));
    const must = name => { const a = get(name); if (!a) throw Object.assign(new Error(`no agent ${name}`), { code: "not_found" }); return a; };
    const spent = name => Number(/** @type {any} */ (db.prepare("SELECT COALESCE(SUM(usd), 0) AS s FROM agents_spend WHERE agent = ?").get(name)).s);

    /** Tool results unwrapped; an error becomes a throw with its message. */
    const use = async (tool, input) => { const r = await ctx.call(tool, input); if (r.error) throw new Error(r.error.message); return r.data; };

    // Option (a) (the lead's decision, on top of the reviewer's drift MEDIUM): projects.access
    // is kept in step with an agent's own agents.projects as part of the person's already-gated
    // create/update action, never a separate step and never a model's own. ctx.call sets the
    // caller "module:agents" (only the loader can), so this reaches projects.access.grant/revoke
    // (both now list "module" among their callers) with no presence prompt beyond what creating
    // or editing the agent already asked for. Never for the assistant: its reach is the
    // assistant rule (core/memory's reach()), not a per-project grant.
    const BY = `module:${ctx.name}`;
    const syncAccess = async (name, before, after) => {
      const pr = await ctx.call("projects.list", {});
      if (pr.error) return; // projects (or projects.access) is not running: nothing to keep in step with
      const all = (Array.isArray(pr.data) ? pr.data : pr.data?.projects || []).filter(p => p && p.slug).map(p => String(p.slug));
      const was = before === "*" ? new Set(all) : new Set((Array.isArray(before) ? before : []).map(String));
      const now = after === "*" ? new Set(all) : new Set((Array.isArray(after) ? after : []).map(String));
      const added = [...now].filter(s => !was.has(s)), dropped = [...was].filter(s => !now.has(s));
      // Checked, and refused, before anything is written: a project the person explicitly
      // revoked already (by anyone other than this same internal path) is never silently
      // re-granted just because it landed back on this agent's list.
      for (const slug of added) {
        const c = await ctx.call("projects.access.check", { project: slug, agent: name });
        if (!c.error && c.data && c.data.status === "revoked" && c.data.by !== BY) {
          throw new Error(`${slug} was explicitly revoked for ${name} (by ${c.data.by}); grant it back on purpose with projects.access.grant, this will not do it silently`);
        }
      }
      for (const slug of added) {
        const g = await ctx.call("projects.access.grant", { project: slug, agent: name });
        if (g.error) throw new Error(`could not grant ${name} access to ${slug}: ${g.error.message}`);
      }
      for (const slug of dropped) {
        // Skip a project that is already revoked, rather than writing over it: setAccess is an
        // upsert, and overwriting `by` here would erase the record that a person, not this
        // internal path, was the one who revoked it, which the "added" check above depends on.
        const c = await ctx.call("projects.access.check", { project: slug, agent: name });
        if (!c.error && c.data && c.data.status === "revoked") continue;
        const r = await ctx.call("projects.access.revoke", { project: slug, agent: name });
        if (r.error) throw new Error(`could not revoke ${name}'s access to ${slug}: ${r.error.message}`);
      }
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
      try { v = await ctx.vault.fetch(name); }
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

    /** Where an agent works: its one project's home, else a folder of its own in VYRE_HOME. */
    const workdir = async a => {
      if (Array.isArray(a.projects) && a.projects.length === 1) return { project: a.projects[0] };
      const dir = path.join(root, "agents", a.name);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return { cwd: dir };
    };

    /** Start the agent's thread, or bring its current one back, with its credentials and scope. */
    const launch = async (a, { prompt, resume } = {}) => {
      const creds = await credentials(a);
      const input = { agent: a.name, agent_kind: a.kind, auth: creds.auth, append: preamble(a), scope: await scope(a),
        ...(creds.env ? { env: creds.env } : {}), ...(creds.fallback ? { fallback: creds.fallback } : {}),
        ...(creds.budget_usd != null ? { budget_usd: creds.budget_usd } : {}), ...(a.model ? { model: a.model } : {}),
        ...(a.effort ? { effort: a.effort } : {}), ...(prompt ? { prompt } : {}) };
      const t = resume ? await use("threads.launch", { ...input, resume }) : await use("threads.launch", { ...input, ...(await workdir(a)), name: a.name });
      db.prepare("UPDATE agents_agents SET thread = ?, updated_at = ? WHERE name = ?").run(t.id, Date.now(), a.name);
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
      skills: { type: "array", items: { type: "string" } }, computer: { type: "boolean" }, model: { type: "string" }, effort: { type: "string", enum: EFFORTS },
      auth: { type: "object", properties: { vault: { type: "string" }, fallback: { type: "string" }, budget_usd: { type: "number" } } } };

    const checkProjects = p => {
      if (p === undefined) return;
      if (p !== "*" && !(Array.isArray(p) && p.every(x => typeof x === "string"))) throw new Error('projects must be "*" or a list of project slugs');
    };

    /** Only the assistant may drive other sessions, from inside its own thread. */
    const guard = (caller, what) => {
      const m = /^mcp:agent:(.+)$/.exec(String(caller || ""));
      if (m && get(m[1])?.kind !== "assistant") throw new Error(`only the assistant can ${what}; ${m[1]} is an agent`);
    };

    // For vyred only: the stored grant of an agent vyred has already verified (its thread's own
    // socket, or a vouched key), attached to meta so a tool that scopes by project reads what the
    // agent is really granted, never a filter the caller's own input or env carries.
    ctx.tool("agents.scope", {
      description: "The kind and stored project grant (\"*\" or a list of slugs) of one agent, for vyred to put on the meta of that agent's calls.", internal: true, callers: ["module"],
      input: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      run: async i => { const a = get(String(i.name)); return a ? { kind: a.kind, projects: a.kind === "assistant" ? "*" : a.projects } : null; },
    });

    ctx.tool("agents.list", {
      description: "Every agent, the assistant first, with what each is doing now.",
      input: { type: "object", properties: {} },
      run: async (_, { caller }) => {
        guard(caller, "list agents");
        const rows = db.prepare("SELECT * FROM agents_agents ORDER BY kind = 'assistant' DESC, name").all().map(shape);
        return Promise.all(rows.map(async a => ({ name: a.name, kind: a.kind, projects: a.projects, model: a.model, effort: a.effort, computer: a.computer,
          // The Deck's agent page shows and edits the job from this list.
          instructions: a.instructions,
          auth: a.auth.vault ? "subscription" : a.auth.fallback ? "api-key" : "ambient", ...(await status(a)) })));
      },
    });

    ctx.tool("agents.create", {
      description: "Make an agent: a name, its projects (\"*\" for all), its credentials (Vault items for the setup token and an API key fallback, with a budget), instructions and model. kind \"assistant\" makes the one assistant, which sees every project.",
      input: { type: "object", required: ["name"], properties: { name: { type: "string" }, ...fields } },
      // A person's surfaces and vyred's modules (onboarding makes the assistant), with no passkey:
      // making an agent is the person's own business. No model, the assistant included, and no guest.
      callers: ["cli", "local", "deck", "capsule", "module"],
      run: async (i, { caller }) => {
        if (!NAME.test(i.name)) throw new Error("an agent's name is lowercase letters, digits and dashes");
        if (get(i.name)) throw new Error(`there is already an agent ${i.name}`);
        const kind = i.kind || "agent";
        if (kind === "assistant" && db.prepare("SELECT 1 FROM agents_agents WHERE kind = 'assistant'").get()) throw new Error("there is already an assistant; agents.update changes it");
        checkProjects(i.projects);
        const projects = kind === "assistant" ? "*" : i.projects ?? [];
        // Written before the row exists (option (a)): a failed grant means no agent was ever
        // created, rather than one whose memory access silently does not match what it says.
        if (kind !== "assistant") await syncAccess(i.name, [], projects);
        const now = Date.now();
        db.prepare(`INSERT INTO agents_agents (name, kind, projects, auth, instructions, skills, computer, model, effort, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(i.name, kind, JSON.stringify(projects), JSON.stringify(i.auth || {}), i.instructions || null,
          JSON.stringify(i.skills || []), i.computer ? 1 : 0, i.model || null, i.effort || null, now, now);
        return get(i.name);
      },
    });

    ctx.tool("agents.update", {
      description: "Change an agent (name it by name or agent): its projects, credentials, instructions, skills, computer, model or effort. Takes effect on its next thread.",
      // Every other agents.* tool names its agent `agent`, so update takes that too; the Deck's
      // "Give a computer" sent it and got "input.name is required".
      input: { type: "object", properties: { name: { type: "string" }, agent: { type: "string" }, ...fields } },
      // A person's surfaces, with no passkey (the owner's Deck over the tailnet included). Of the
      // models, only the assistant, and only for its words and model: never credentials, budget,
      // projects, skills or a computer. Every other agent, a bare MCP session and a guest are refused.
      callers: ["cli", "local", "deck", "capsule", "module", "mcp"],
      run: async (i, { caller }) => {
        if (/^mcp(?=$|[\s:])/.test(String(caller))) {
          const m = /^mcp:agent:(.+)$/.exec(String(caller));
          const plain = Object.keys(i).every(k => i[k] === undefined || PLAIN_UPDATE.has(k));
          if (!m || get(m[1])?.kind !== "assistant" || !plain) throw Object.assign(new Error("changing agents is the person's"), { code: "denied" });
        }
        if (i.name !== undefined && i.agent !== undefined && i.name !== i.agent) throw new Error("name and agent say different agents; give one");
        const who = i.name ?? i.agent;
        if (who === undefined) throw new Error("say which agent: name is required");
        const a = must(who);
        checkProjects(i.projects);
        if (i.kind && i.kind !== a.kind) throw new Error("an agent's kind is fixed when it is made");
        if (a.kind === "assistant" && i.projects !== undefined && i.projects !== "*") throw new Error("the assistant sees every project");
        const next = { ...a, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => v !== undefined && k !== "name" && k !== "agent")) };
        // Option (a): before the row changes, so a failed grant or an explicit-revoke refusal
        // means the edit never took either. Never for the assistant (a.kind === "assistant"
        // above already refuses any real change to its projects, so there is nothing to sync).
        if (a.kind !== "assistant" && i.projects !== undefined) await syncAccess(a.name, a.projects, next.projects);
        db.prepare(`UPDATE agents_agents SET projects = ?, auth = ?, instructions = ?, skills = ?, computer = ?, model = ?, effort = ?, updated_at = ? WHERE name = ?`)
          .run(JSON.stringify(next.projects), JSON.stringify(next.auth || {}), next.instructions || null, JSON.stringify(next.skills || []),
            next.computer ? 1 : 0, next.model || null, next.effort || null, Date.now(), a.name);
        return get(a.name);
      },
    });

    ctx.tool("agents.ask", {
      description: "Talk to an agent: the text goes to its current thread (started if needed) and the reply comes back when the turn ends. If the thread stops on a permission question, returns with the question instead; the user answers it with threads.answer.",
      input: { type: "object", required: ["agent", "text"], properties: { agent: { type: "string" }, text: { type: "string" }, surface: { type: "string" }, wait: { type: "boolean" },
        mentions: { type: "array", maxItems: 8, items: { type: "object", required: ["kind", "id"], properties: { kind: { type: "string" }, id: { type: "string" }, name: { type: "string" } } }, description: "The # tags the composer picked, from a person's own surface only (as threads.send): each is resolved for the agent's thread." },
        pasted: { type: "array", maxItems: 20, items: { type: "string" }, description: "The spans of the text the person pasted: a #Name inside one tags nothing." } } },
      run: async (i, { caller }) => {
        guard(caller, "talk to other agents");
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
        const sendWords = async thread => {
          await capNotice(thread);
          if (!byPerson) return use("threads.send", { thread, text: i.text, surface });
          const r = await ctx.call("threads.send", { thread, text: i.text, surface, ...(tagged ? { mentions: i.mentions || [], pasted: i.pasted || [] } : {}) }, { as: String(caller) });
          if (r.error) throw new Error(r.error.message);
          return r.data;
        };
        const a = must(i.agent);
        const surface = i.surface || String(caller || "vyre");
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
          const cur = a.thread ? (await ctx.call("threads.get", { thread: a.thread, limit: 1 })).data?.thread : null;
          if (!cur) {
            // A new thread learns its id only from the launch, so the listeners key on it after;
            // the reply cannot beat a model's first token back.
            const t = await launch(a);
            thread = t.id;
            const s = await sendWords(thread);
            if (!s.sent) return { agent: a.name, thread, ok: false, text: "", note: s.note };
          } else {
            thread = cur.id;
            if (cur.status === "stopped") await launch(a, { resume: cur.id });
            const s = await sendWords(thread);
            if (!s.sent) return { agent: a.name, thread, ok: false, text: "", note: s.note };
          }
          if (i.wait === false) return { agent: a.name, thread, ok: true, sent: true, text: "" };
          const timer = new Promise(r => setTimeout(() => r({ ok: false, note: "still working; the reply will stream to the thread" }), ASK_WAIT_MS).unref?.());
          const r = await Promise.race([done, timer]);
          return { agent: a.name, thread, text: heard.text, ...(/** @type {object} */ (r)) };
        } finally {
          for (const off of offs) off();
          // The keyboard is given back once the question is asked. Every word still goes through
          // the one process vyred owns, so there is no second writer on the transcript; holding
          // the lease past the reply would only lock the user's other screens out of the agent.
          if (thread && i.wait !== false) await ctx.call("threads.release", { thread, surface });
        }
      },
    });

    ctx.tool("agents.rollover", {
      description: "Start a fresh thread for an agent (the assistant's daily thread) and make it the agent's current one, optionally seeded with a first message. The old thread is left as it is, and work in it goes on. Refused while the current thread is working or holds a question.",
      input: { type: "object", required: ["agent"], properties: { agent: { type: "string" }, seed: { type: "string" } } },
      run: async (i, { caller }) => {
        if (!/^(module:assistant|cli|local|deck|capsule)$/.test(String(caller || ""))) throw Object.assign(new Error("only the assistant module or the person rolls a thread"), { code: "denied" });
        const a = must(i.agent);
        const st = await status(a);
        if (st.doing === "working" || st.doing === "waiting on your answer") throw Object.assign(new Error(`${a.name} is ${st.doing}; roll the thread when it is idle`), { code: "busy" });
        const t = await launch(a, i.seed ? { prompt: i.seed } : {});
        return { agent: a.name, thread: t.id, previous: a.thread };
      },
    });

    ctx.tool("agents.threads", {
      description: "An agent's threads, newest first.",
      input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
      run: async ({ agent }, { caller }) => { guard(caller, "read other agents"); must(agent); return use("threads.list", { agent }); },
    });

    ctx.tool("agents.usage", {
      description: "What each agent has used: turns, threads, time, tokens and cost (all of it, and on the API key), its budget and what is left, and the last rate-limit report. since: ms since epoch. With no agent, every agent, and agent null for threads no agent ran.",
      input: { type: "object", properties: { agent: { type: "string" }, since: { type: "integer" } } },
      run: async ({ agent, since }, { caller }) => {
        guard(caller, "read other agents' usage");
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
      description: "Past conversations with an agent (or every agent): what was asked, the answer, when, and the thread, newest last. before: an exchange id, for the page before it.",
      input: { type: "object", properties: { agent: { type: "string" }, limit: { type: "integer" }, before: { type: "integer" } } },
      run: async ({ agent, limit, before }, { caller }) => {
        guard(caller, "read other agents' conversations");
        if (agent) must(agent);
        return use("threads.history", { ...(agent ? { agent } : {}), ...(limit ? { limit } : {}), ...(before ? { before } : {}) });
      },
    });

    // Deleting is a person's decision: no model, not even the assistant, removes an agent.
    ctx.tool("agents.delete", {
      description: "Remove an agent's record and its spend. Refused while one of its threads is running (agents.stop first), and for the assistant. Its threads' transcripts and events stay.",
      input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
      callers: ["cli", "local", "deck", "capsule"],
      run: async ({ agent }) => {
        const a = must(agent);
        if (a.kind === "assistant") throw new Error(`${a.name} is the assistant; there must be one, so change it with agents.update instead`);
        const running = (await use("threads.list", { agent })).filter(t => t.status !== "stopped");
        if (running.length) throw new Error(`${a.name} has ${running.length} running thread${running.length === 1 ? "" : "s"}; stop ${running.length === 1 ? "it" : "them"} first: vyre agents stop ${a.name}`);
        // Option (a): the agent is gone, so its projects.access rows are deleted outright, not
        // merely revoked; there is nothing left for a future re-add to weigh against. Before the
        // agent's own rows: a failed clear means the delete never happened either.
        const c = await ctx.call("projects.access.clear", { agent: a.name });
        if (c.error && c.error.code !== "no_such_tool") throw new Error(`could not clear ${a.name}'s projects.access rows: ${c.error.message}`);
        db.prepare("DELETE FROM agents_spend WHERE agent = ?").run(a.name);
        db.prepare("DELETE FROM agents_agents WHERE name = ?").run(a.name);
        return { agent: a.name, deleted: true };
      },
    });

    ctx.tool("agents.stop", {
      description: "Stop every running thread of an agent. Its record and transcripts stay.",
      input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
      run: async ({ agent }, { caller }) => {
        guard(caller, "stop agents");
        must(agent);
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
      run: async ({ agent, thread }, { caller }) => {
        const a = must(agent);
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

    return { async stop() {} };
  },
};
