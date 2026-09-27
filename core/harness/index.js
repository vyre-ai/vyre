// @ts-check
// harness — what the Claude Code hooks ask vyred (docs/SPEC.md section 8).
//
// The hooks in harness/hooks/ are a few lines each: they read the hook's JSON from stdin, call
// one of these tools, and print what comes back. All the logic is here, where it can be tested
// and where it can use the other modules. Those modules are reached only through ctx.call, and
// every one of them may be missing (not installed, failed, not built yet): each tool then
// returns less, never an error, so Claude Code behaves exactly as it would without Vyre.

import os from "node:os";
import path from "node:path";
import { rules } from "./rules.js";

const MIGRATIONS = [
  `CREATE TABLE harness_files (
     session TEXT NOT NULL, path TEXT NOT NULL, tool TEXT NOT NULL, at INTEGER NOT NULL,
     PRIMARY KEY (session, path, tool)
   );
   CREATE INDEX harness_files_at ON harness_files (at);`,
];

/** Tools that change files, and where each keeps the path it changed. */
const WRITERS = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;

    /** Call another module's tool; any failure, including its absence, is simply no answer. */
    const ask = async (tool, input) => {
      const r = await ctx.call(tool, input);
      return r && "data" in r ? r.data : null;
    };

    /**
     * An agent's scope, as the hook passes it: "*" or a comma list of project slugs. Absent means
     * a person's own session, which sees whatever its folder's project is.
     * @param {string|undefined} projects @param {string|null} slug
     */
    const inScope = (projects, slug) => !projects || projects === "*" || (slug != null && projects.split(",").includes(slug));

    /**
     * The agent a hook speaks for. The caller "harness:agent:<name>" is checked by vyred against
     * the thread's key; input.agent is only a fallback for callers that name none (tests, modules).
     * @param {string|undefined} agent @param {string|undefined} caller
     */
    const agentOf = (agent, caller) => /^harness:agent:(.+)$/.exec(String(caller || ""))?.[1] || agent || undefined;

    /** The project a folder is in, if Projects is running and knows one. */
    const projectOf = async cwd => (cwd ? ask("projects.of", { cwd }) : null);

    /**
     * A session that is not our own headless child, whose id is a live headless thread here: a
     * terminal `claude --resume` of a conversation vyred is running (floor rule 4). Two processes
     * would append to one transcript. The warning is all this does; the session still starts,
     * because a hook that stops people working gets turned off. No switchboard, no warning.
     * @param {string} session
     */
    const secondWriter = async session => {
      const c = await ask("threads.claimed", { session });
      if (!c || !c.headless) return "";
      await ask("threads.contend", { session });
      return `Warning from Vyre: this conversation is also running headless under Vyre right now (holder: ${c.holder || "none"}). ` +
        `Two processes writing one transcript lose work. Stop the headless one with \`vyre threads stop ${session.slice(0, 8)}\` ` +
        `before going on here, or leave this session and keep working there. Tell the user this before anything else.`;
    };

    /**
     * Words the user queued for this session from another surface while it was busy in a terminal
     * (threads.queue in core/switchboard), handed over now and marked so. Empty when there are
     * none, or no switchboard.
     * @param {string|undefined} session @param {"stop"|"prompt"} via
     */
    const handOver = async (session, via) => {
      if (!session) return "";
      const got = await ask("threads.inbox", { session, via });
      const msgs = got && Array.isArray(got.messages) ? got.messages : [];
      // "the user": the config has no person's name (config.name is the computer's).
      return msgs.map(m => `Message from the user via ${surfaceName(m.surface)}: ${m.text}`).join("\n\n");
    };

    ctx.tool("harness.brief", {
      description: "SessionStart: what Claude should know about the project this thread is in. Empty outside a project.",
      input: { type: "object", properties: { cwd: { type: "string" }, session: { type: "string" }, source: { type: "string" }, project: { type: "string" }, projects: { type: "string" }, headless: { type: "boolean" } } },
      run: async ({ cwd, session, source, project, projects, headless }) => {
        if (session) ctx.events.emit("thread.started", { session, cwd: cwd || null, source: source || null });
        const warning = session && !headless ? await secondWriter(session) : "";
        const withWarning = (/** @type {string} */ t) => [warning, t].filter(Boolean).join("\n\n");
        // Projects decides which project this is: from the folder first, then from the session's
        // single pick. A session picked into several projects gets no brief rather than a guess.
        const brief = await ask("projects.context", project ? { project, session } : { cwd, session });
        const text = typeof brief === "string" ? brief : brief && typeof brief.text === "string" ? brief.text : "";
        const slug = brief && brief.project ? String(brief.project) : null;
        // The lessons the user taught apply in every thread, in a project or not.
        const lessons = await ask("learn.check", { stage: "brief", cwd, session });
        const lessonText = lessons && lessons.text ? lessons.text : "";
        // An agent outside its projects gets no brief, only the lessons.
        if (!inScope(projects, slug)) return { text: withWarning(lessonText), project: null };
        return { text: withWarning([text, lessonText].filter(Boolean).join("\n\n")), project: slug };
      },
    });

    ctx.tool("harness.enrich", {
      description: "UserPromptSubmit: memory relevant to this prompt, marked as memory with its source. Empty when nothing is relevant.",
      input: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, cwd: { type: "string" }, session: { type: "string" }, prompt_id: { type: "string" }, agent: { type: "string" }, projects: { type: "string" },
        interactive: { type: "boolean" } } },
      run: async ({ prompt, cwd, session, prompt_id, agent: named, projects, interactive }, { caller } = {}) => {
        const agent = agentOf(named, caller);
        // Every prompt starts a turn for Learning, slash commands included; it may also be a correction.
        // interactive: the hook saw a person's Claude Code (a terminal, no -p); only then may a
        // plain yes or no answer a lesson. An agent's thread never is.
        const learned = session ? await ask("learn.signal", { session, prompt_id, prompt, cwd, agent, interactive: interactive === true && !agent }) : null;
        const lessons = learned && typeof learned.text === "string" ? learned.text : "";
        // A lesson broken last turn opens this one, ahead of memory.
        const first = Boolean(learned && Array.isArray(learned.broke) && learned.broke.length);
        if (!prompt.trim() || prompt.trim().startsWith("/")) return { text: lessons };
        // Words queued for this session while it sat idle in a terminal go with the prompt.
        const handed = await handOver(session, "prompt");
        const inbox = handed ? `${handed}\n\nThis was sent while the session was idle. Handle it along with the prompt.` : "";
        const project = await projectOf(cwd);
        // An agent outside its projects gets no memory at all, not memory from elsewhere.
        if (!inScope(projects, project ? project.slug : null)) return { text: [inbox, lessons].filter(Boolean).join("\n\n") };
        const folders = project && (Array.isArray(project.folders) ? project.folders : project.home ? [project.home] : null);
        // A project's room by its slug, so a project nested in another's folder reads its own;
        // its folders go too, for a project Memory has not read yet. Outside every project a
        // session reads the unfiled room, never a folder prefix, so a session in the home folder
        // does not see every client (docs/adr/0007-intelligence.md).
        const where = project && project.slug ? { room: String(project.slug), ...(folders ? { project_cwds: folders } : {}) }
          : folders ? { project_cwds: folders } : { room: "unfiled" };
        const facts = await ask("memory.relevant", { text: prompt, ...where, limit: 5 });
        const memory = formatMemory(Array.isArray(facts) ? facts : facts && Array.isArray(facts.facts) ? facts.facts : []);
        return { text: [inbox, ...(first ? [lessons, memory] : [memory, lessons])].filter(Boolean).join("\n\n") };
      },
    });

    const SUBAGENT = /^(Agent|Task)$/;
    /** Take a subagent slot for a session's Agent call: null when it may run, else why not. */
    const subagentSlot = async (session, cwd, key) => {
      const t = await ask("threads.get", { thread: session, limit: 1 });
      if (t && t.thread && t.thread.driver === "sdk" && ["starting", "working", "waiting", "idle"].includes(t.thread.status)) return null;   // held in-process
      const of = cwd ? await ask("projects.of", { cwd }) : null;
      const r = await ask("sessions.slots", { action: "take", kind: "subagent", project: (of && of.slug) || "_none", owner: `session:${session}`, key: String(key || Date.now()), wait: false });
      if (!r || !r.queued) return null;
      return `Too many subagents are running right now (Vyre's limit for this project or this machine); this one is number ${r.position} in line. Do the work in this session, or try the subagent again in a little while.`;
    };
    const releaseSlots = (session, key = null) => ask("sessions.slots",
      key ? { action: "release", owner: `session:${session}`, key: String(key) } : { action: "release-owner", owner: `session:${session}`, kind: "subagent" }).catch(() => null);

    ctx.tool("harness.rules", {
      description: "PreToolUse: the security floor's verdict on a tool call, then the lessons'. null means no opinion; Claude Code's own permissions decide.",
      input: { type: "object", required: ["tool_name"], properties: { tool_name: { type: "string" }, tool_input: { type: "object" }, cwd: { type: "string" }, session: { type: "string" }, prompt_id: { type: "string" }, agent: { type: "string" }, tool_use_id: { type: "string" },
        plugin_root: { type: "string" } } },
      run: async ({ tool_name, tool_input, cwd, session, prompt_id, agent: named, tool_use_id, plugin_root }, { caller } = {}) => {
        const agent = agentOf(named, caller);
        /** @type {{ decision: "deny"|"ask"|null, reason?: string, rule?: number, lesson?: number }} */
        // Only an agent vyred vouched for (its key, harness:agent:<name>) gets its own folder as a
        // working place; a name in the input is a claim.
        const vouched = /^harness:agent:(.+)$/.exec(String(caller || ""))?.[1] || null;
        let verdict = rules({ tool: tool_name, input: tool_input || {}, cwd, home: ctx.paths ? ctx.paths.root : undefined, agent: vouched });
        // A send inside an agent's thread goes through the Gate instead, where the user can edit
        // it. Without the Gate running, the floor's "ask first" stands.
        if (verdict.rule === 1 && agent) {
          const g = await ask("gate.route", { tool: tool_name, input: tool_input || {}, agent, ...(session ? { session } : {}) });
          if (g && g.decision) verdict = { decision: g.decision, reason: g.reason, rule: 1 };
        }
        // The floor first; a lesson can only add a hold, never lift one.
        if (!verdict.decision) {
          // plugin_root: where Claude Code loaded the Harness from, whose hooks Learning guards.
          const l = await ask("learn.check", { stage: "tool", session, prompt_id, cwd, agent, tool_name, tool_input: tool_input || {}, ...(tool_use_id ? { tool_use_id } : {}),
            ...(plugin_root ? { plugin_root } : {}) });
          if (l && l.decision) verdict = { decision: l.decision, reason: l.reason, lesson: l.lesson };
        }
        // A subagent in a session the Agent SDK does not drive (a terminal, or the CLI runner) takes a
        // subagent slot here (ADR 0030 section 12). No waiting in a hook: when the project or the
        // box is full it is refused at once, with its place in line.
        if (!verdict.decision && SUBAGENT.test(String(tool_name)) && session) {
          const held = await subagentSlot(session, cwd, tool_use_id);
          if (held) verdict = { decision: "deny", reason: held };
        }
        if (verdict.decision) ctx.events.emit("tool.held", { session: session || null, tool: tool_name, decision: verdict.decision, rule: verdict.rule ?? null, lesson: verdict.lesson ?? null });
        return verdict;
      },
    });

    const touch = db.prepare("INSERT INTO harness_files (session, path, tool, at) VALUES (?,?,?,?) ON CONFLICT DO UPDATE SET at = excluded.at");
    ctx.tool("harness.learn", {
      description: "PostToolUse and PostToolUseFailure: record which files a tool changed, so every change is visible (security floor rule 5), and tell Learning what became of the call (ok false: it failed).",
      input: { type: "object", required: ["tool_name"], properties: { tool_name: { type: "string" }, tool_input: { type: "object" }, cwd: { type: "string" }, session: { type: "string" },
        tool_use_id: { type: "string" }, ok: { type: "boolean" }, error_head: { type: "string" }, interrupted: { type: "boolean" } } },
      run: async ({ tool_name, tool_input, cwd, session, tool_use_id, ok = true, error_head, interrupted }) => {
        if (SUBAGENT.test(String(tool_name)) && session && tool_use_id) await releaseSlots(session, tool_use_id);
        const key = WRITERS[/** @type {keyof typeof WRITERS} */ (tool_name)];
        const raw = key && tool_input ? tool_input[key] : null;
        const file = raw && typeof raw === "string" ? path.resolve(cwd || os.homedir(), raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw) : null;
        let recorded = 0;
        if (file && ok !== false) {
          touch.run(session || "", file, tool_name, Date.now());
          ctx.events.emit("file.touched", { session: session || null, path: file, tool: tool_name });
          recorded = 1;
        }
        // Learning hashes what Claude wrote and counts failed and fixed commands. Only the head of
        // an error is passed on, and Learning keeps none of it.
        if (session && (key || tool_name === "Bash")) {
          await ask("learn.observe", { session, tool_name, ok: ok !== false, ...(tool_use_id ? { tool_use_id } : {}), ...(file ? { path: file } : {}),
            ...(typeof error_head === "string" ? { error_head: error_head.slice(0, 200) } : {}), ...(interrupted ? { interrupted: true } : {}) });
        }
        return { recorded };
      },
    });

    ctx.tool("harness.touched", {
      description: "Files changed in a thread, newest first.",
      input: { type: "object", required: ["session"], properties: { session: { type: "string" }, limit: { type: "integer" } } },
      run: async ({ session, limit }) =>
        db.prepare("SELECT path, tool, at FROM harness_files WHERE session = ? ORDER BY at DESC LIMIT ?").all(session, limit || 100),
    });

    ctx.tool("harness.stop", {
      description: "Stop: the lessons' output checks, then words queued for this session from another surface, then the turn is complete for every surface watching this thread. decision block sends the turn back to Claude with the reason.",
      input: { type: "object", properties: { session: { type: "string" }, prompt_id: { type: "string" }, cwd: { type: "string" }, agent: { type: "string" }, text: { type: "string" }, stop_hook_active: { type: "boolean" },
        headless: { type: "boolean" } } },
      run: async ({ session, ...turn }, { caller } = {}) => {
        if (session) await releaseSlots(session);                       // a turn's end gives its subagent slots back
        const agent = agentOf(turn.agent, caller);
        const check = session ? await ask("learn.check", { stage: "stop", session, ...turn, ...(agent ? { agent } : {}) }) : null;
        if (check && check.decision === "block") return { decision: "block", reason: String(check.reason) };
        if (session) {
          // The turn that just ended answered words handed over earlier: its last message is their reply.
          await ask("threads.replied", { session, text: typeof turn.text === "string" ? turn.text : "" });
          // Words queued while this turn ran: Claude takes them next, in this same session.
          const handed = await handOver(session, "stop");
          if (handed) return { decision: "block", reason: handed };
        }
        if (session) ctx.events.emit("turn.completed", { session });
        return { ok: true };
      },
    });

    return { async stop() {} };
  },
};

/** How a queued message names where it came from. */
const SURFACES = { capsule: "the Capsule", deck: "the Deck", cli: "the vyre command", glass: "Glass", mobile: "the phone" };
/** A surface as a person says it; the box's through the link is "box:<surface>". */
const surfaceName = (/** @type {string} */ s) => {
  const box = /^box:(.*)$/.exec(String(s));
  return box ? `${SURFACES[box[1]] || box[1] || "the Deck"} on the box` : SURFACES[s] || s;
};

/** Flags that make a claude process headless: its prompt comes from stdin or an argument, not a person. */
const HEADLESS_FLAGS = new Set(["-p", "--print", "--output-format", "--input-format"]);

/**
 * Is this `ps -o tty=,args=` line an interactive Claude Code, one a person types into? It is a
 * `claude` (as threads.bind knows one: by the name it was started as), has a controlling
 * terminal, and has none of -p, --print, --output-format, --input-format (also as
 * --flag=value, or -p among joined short flags such as -cp). Anything unreadable is not.
 * ps prints arguments unquoted, so a prompt given as an argument may add words: those can only
 * make the answer no, never yes.
 * @param {string} line
 */
export function interactiveFrom(line) {
  const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(String(line || "").split("\n")[0]);
  if (!m) return false;
  const [, tty, args] = m;
  if (/^(\?+|-|none)$/i.test(tty)) return false;
  const argv = args.split(/\s+/);
  if (argv[0].split("/").pop() !== "claude") return false;
  for (const a of argv.slice(1)) {
    if (a === "--") break;
    const flag = a.split("=")[0];
    if (HEADLESS_FLAGS.has(flag)) return false;
    if (/^-[A-Za-z]{2,}$/.test(a) && a.includes("p")) return false;
  }
  return true;
}

/**
 * Memory for a prompt, as Claude will read it. Each line says it is memory, where it came from
 * and how old it is, so Claude can weigh it and the user can ask where it came from (floor 7).
 * @param {any[]} facts
 */
export function formatMemory(facts) {
  const lines = [];
  for (const f of facts.slice(0, 5)) {
    const text = String(f.text ?? f.fact ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!text) continue;
    // Memory gives source as { session, seq, name }; a plain string is accepted too.
    const src = f.source && typeof f.source === "object" ? f.source.name || f.source.session : f.source;
    const bits = [src && `from ${String(src).slice(0, 60)}`, f.age && String(f.age), typeof f.confidence === "number" && `confidence ${f.confidence.toFixed(2)}`].filter(Boolean);
    lines.push(`- ${text}${bits.length ? ` (${bits.join(", ")})` : ""}`);
  }
  if (!lines.length) return "";
  return `Vyre memory. These come from earlier sessions, not from this conversation; check before relying on them.\n${lines.join("\n")}`;
}
