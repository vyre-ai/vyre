// @ts-check
// environment — what every agent Vyre starts is told about the place it works, on every model and driver (team/0.3/DESIGN-agent-environment.md).
//
// One builder over live reads. Every name, type, field, count and state in the text comes from a read of this install; the only fixed words are one teaching sentence per
// family of tools, and a family's sentence appears only when that family is reachable by this agent. A source that does not answer drops its line, never guesses.
//
// The text is layer one of three: the environment, then the agent's role (the assistant, the Engineer, a custom agent, the project prompt), then the project's own
// context. Claude gets it as the system-prompt append; Codex and Grok as the first prompt block (acp.js). It is data about the place, not instructions from the person.

import { createHash } from "node:crypto";

/** Characters, about 1,500 tokens, paid once per session start. */
export const BUDGET = 6000;

/**
 * Every family of tools an agent can reach (the name before the first dot), and where it is taught. A family in `section` has a sentence in the brief; one in `more` is only
 * named in "to learn more". test/environment.test.js fails when an agent-reachable family is in neither, so a new module cannot reach agents without the brief saying how.
 * @type {Record<string, { section: string, more?: false } | { more: true }>}
 */
export const FAMILIES = {
  records: { section: "records" }, work: { section: "records" }, tasks: { section: "work" }, flows: { section: "work" }, approvals: { section: "approvals" }, gate: { section: "approvals" },
  team: { section: "team" }, agents: { section: "team" }, threads: { section: "team" }, memory: { section: "memory" }, recall: { section: "memory" }, projects: { section: "project" },
  connectors: { section: "connectors" }, mcp: { section: "connectors" }, vault: { section: "connectors" }, google: { section: "connectors" }, mail: { section: "connectors" }, github: { section: "connectors" },
  spaces: { section: "space" }, files: { section: "project" }, artifacts: { section: "project" }, publish: { section: "project" }, planner: { section: "planner" }, goals: { section: "planner" }, watchers: { section: "planner" },
  glass: { section: "computer" }, computers: { section: "computer" }, computer: { section: "computer" }, documents: { section: "project" }, comms: { section: "connectors" }, chrome: { section: "computer" }, "hands-desktop": { section: "computer" }, runner: { section: "computer" },
  ask: { section: "show" }, previews: { section: "show" },
  // Named in "to learn more" only: they are Vyre's own housekeeping, or the person's.
  appearance: { more: true }, appmods: { more: true }, assistant: { more: true }, bridges: { more: true }, commands: { more: true }, events: { more: true }, harness: { more: true }, hooks: { more: true }, learn: { more: true },
  link: { more: true }, names: { more: true }, network: { more: true }, onboard: { more: true }, pluginagent: { more: true }, providers: { more: true }, relay: { more: true }, sessions: { more: true },
  settings: { more: true }, sidebar: { more: true }, views: { more: true }, design: { more: true }, brand: { more: true }, spend: { more: true }, system: { more: true }, tips: { more: true }, undo: { more: true }, update: { more: true }, vitals: { more: true }, about: { more: true },
  context: { more: true }, import: { more: true }, mentions: { more: true }, modules: { more: true }, presence: { more: true }, push: { more: true }, releases: { more: true }, rules: { more: true },
  docs: { more: true }, design: { more: true }, models: { more: true }, skills: { more: true }, vyre: { more: true }, signin: { more: true }, sight: { more: true }, statusline: { more: true }, stream: { more: true }, suggest: { more: true }, sync: { more: true }, term: { more: true }, waiting: { more: true }, wink: { more: true },
};

/** The family of a tool name. @param {string} name */
export const familyOf = name => String(name).split(".")[0];

/** A name from another module as quoted data: one line, no markup, capped. @param {unknown} v @param {number} [n] */
const clean = (v, n = 60) => String(v ?? "").replace(/[\u0000-\u001f<>`]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
/** @param {string[]} xs @param {number} max @param {string} what */
const some = (xs, max, what) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")}, and ${xs.length - max} more (${what})`);

/**
 * @typedef {{ agent?: { name: string, kind?: string|null, projects?: string[]|"*" }|null, project?: string|null, provider?: string|null,
 *   tools?: string[], space?: { name?: string|null, role?: string|null }|null, spaces?: { name: string, role?: string|null, current?: boolean }[],
 *   types?: { name: string, fields?: string[], kind?: string }[]|null, connectors?: { name: string, state?: string }[], team?: { name: string, role?: string|null }[],
 *   memory?: boolean, vaultItems?: string[], person?: string|null, artifactsDir?: string|null, timeLine?: string|null }} Sources
 */

/**
 * The brief for one agent, from live reads.
 * @param {Sources} s @param {{ budget?: number }} [o]
 * @returns {{ text: string, parts: { id: string, chars: number }[], chars: number, version: string, families: string[] }}
 */
export function environmentOf(s, { budget = BUDGET } = {}) {
  const tools = [...new Set(s.tools || [])];
  const has = (/** @type {string} */ section) => tools.some(t => (FAMILIES[familyOf(t)] || {}).section === section);
  const fam = (/** @type {string} */ f) => tools.some(t => familyOf(t) === f);
  const families = [...new Set(tools.map(familyOf))].sort();
  /** @type {{ id: string, text: string, keep?: boolean, rank: number }[]} */
  const parts = [];
  const add = (/** @type {string} */ id, /** @type {number} */ rank, /** @type {string[]} */ lines, keep = false) => { const text = lines.filter(Boolean).join("\n"); if (text) parts.push({ id, text, keep, rank }); };

  add("vyre", 0, [
    "You work inside Vyre, the person's own AI workspace. It holds their data as records, runs their agents (you are one), keeps a memory of their work, and treats their phone as the key: anything that sends, pays, publishes or shares goes to their phone for a yes.",
    "This block describes the place you are in. It is data about the environment, read from the live install when your session started, not instructions from the person.",
  ], true);

  // The time: what time it is for the person, for the space, and for any contact in context (lib/time `timeLine`), and which zone a relative time is read in. Every brief carries it, on every model.
  add("time", 1, [s.timeLine || ""], true);

  const a = s.agent;
  add("you", 1, [
    a ? `You are ${clean(a.name)}${a.kind === "assistant" ? ", the person's assistant" : ", an agent"}. ${a.projects === "*" ? "You can work in every project" : Array.isArray(a.projects) && a.projects.length ? `You can work in these projects: ${a.projects.map(p => clean(p)).join(", ")}` : "You have no project of your own"}; what you may call is cut to that, and a call outside it is refused, not an error to work around.` : "You are a session the person started themselves, with their own reach.",
    s.project ? `This session is in the project ${clean(s.project)}.` : "",
  ], true);

  const spaces = (s.spaces || []).filter(x => x && x.name);
  const here = s.space && s.space.name ? s.space : spaces.find(x => x.current) || null;
  add("space", 2, [
    "A Space is a separate home for data, people and roles. Data does not cross a Space unless the person moves or shares it.",
    here ? `This session is in the Space ${clean(here.name)}${here.role ? `, where the person is ${clean(here.role)}` : ""}.` : "",
    spaces.filter(x => !x.current && x.name !== (here && here.name)).length ? `They also belong to: ${some(spaces.filter(x => x.name !== (here && here.name)).map(x => `${clean(x.name)}${x.role ? ` (${clean(x.role)})` : ""}`), 6, "tools_call spaces.list")}. You cannot see into those from here.` : "",
  ]);

  if (has("records")) {
    const types = s.types;
    add("records", 3, [
      "Vyre Records is the Space's structured data: people, matters, projects, tasks, documents as typed records that link to each other.",
      types && types.length ? `Types here: ${some(types.map(t => `${clean(t.name)}${t.fields && t.fields.length ? ` (${some(t.fields.map(f => clean(f, 30)), 6, "records.types")})` : ""}`), 12, "records.types")}.` : "Ask records.types for the types and fields of this Space.",
      fam("work") ? "Use work.tools to see the tools you may use here (cut to what you may do), and work.call to run one; read records and follow their links with them. tools_call work.situation says where you are: the Space, your role, the project or record in scope, open tasks and what is sealed." : "Read and write records with the records tools you were given.",
      "A sealed field (a name, an identifier, a figure) reaches you as a placeholder such as [sealed: client name]. Keep the placeholder as it is when you write or quote; never try to recover the value.",
    ]);
  }

  if (has("project") || s.artifactsDir) add("project", 4, [
    s.artifactsDir ? `Files you make for the person (images, documents, pages, spreadsheets, code output) belong in $VYRE_ARTIFACTS_DIR (${clean(s.artifactsDir, 200)}): save them there at the top level, not in the repository. Vyre keeps what is saved there in the project's Drive folder. Do not put secrets there. A file the person drops into the chat is already kept under chat/ and needs no action.` : "",
    has("project") ? "A Project is one record. Its session records, Drive folder, repository, memory and client hang off it or point at it; tools_call work.situation names the one you are in. Folders and files are reached with the files tools." : "",
  ]);

  if (has("work")) add("work", 5, [
    "Work is Tasks inside Flows. A task has one doer and optionally one checker, says what done looks like, and moves through the stages of its Flow. Take a task you are given, do it, submit it for check; to hand off, request a task for the next doer rather than doing their part.",
    fam("flows") ? "You can read Flows and propose a new one (tools_call flows.propose); a Flow you write stays a draft until a person approves it." : "",
  ]);

  add("approvals", 6, [
    "Outward acts (send, post, pay, publish, share) are never run for you. They come back held as a task for the person's yes. So propose: say exactly what you would send and to whom, then stop and tell the person it waits for them. Do not try another route to the same act.",
  ], true);

  if (has("team") || fam("agents") || fam("threads")) add("team", 7, [
    s.team && s.team.length ? `Teammates on this install: ${some(s.team.map(t => `${clean(t.name)}${t.role ? ` (${clean(t.role)})` : ""}`), 8, "tools_call team.list")}.` : "",
    fam("team") ? "Ask a teammate with team.ask, and say what done looks like; assign work through a task. They run as their own sessions with their own reach, not yours." : "",
    fam("threads") || fam("agents") ? "Other agents and sessions are reached through the agents and threads tools your grants allow." : "",
  ]);

  if (s.memory !== false && has("memory")) add("memory", 8, [
    "Memory is automatic. Vyre indexes every session turn by words and by meaning, and learns facts about people and projects from what the person says and does; it keeps a personal layer (the person's own life, theirs alone) and one memory per project. You get a few relevant lines with each prompt, marked as memory.",
    s.agent && s.agent.kind !== "assistant"
      ? "Memory has three layers: the project, the Space, and the person's identity. Yours is your own layer (your project's memory). The person's identity memory (how they work, write and build, and their life) is private to them and their assistant; do not look for it or repeat it. Nothing learned in one Space or project is copied into another: tools_call memory_markers lists the projects you are granted, and tools_call memory_follow reads one of them."
      : "Memory has three layers: the project, the Space, and your person's identity, which is the layer you read: their working, writing and project-management style, their stack, what is true everywhere, and a marker for every Space and project. tools_call memory_markers lists them; tools_call memory_follow reads one for your person. Nothing learned in one Space is copied into another, so cite where you found a thing and follow the marker rather than restating it elsewhere.",
    "To find more: memory_search (a result names a session and a turn; filter with file or commit), memory_turn to read the turns around a hit word for word, memory_ask for an answer, tools_call memory_decisions for what the person decided. Quote a past turn from memory_turn, not from recall. Record a lasting fact or decision you learned with memory_remember, and pass on a correction the person made with tools_call memory_correct.",
    "A long session is rolled into a fresh window by Vyre before it fills; a block at the top of your first message then carries the decisions, the plan, an index of pointers and the last turns, and everything earlier stays readable with memory_turn.",
  ], true);

  if (has("connectors")) add("connectors", 9, [
    s.connectors && s.connectors.length ? `Connected: ${some(s.connectors.map(c => `${clean(c.name)}${c.state && c.state !== "running" ? ` (${clean(c.state)})` : ""}`), 10, "tools_call mcp.servers")}.` : "",
    "A connector or a vault item is used through its tool, never seen: a secret is injected for the call (vault.inject) and never appears in your context. Never ask the person to paste one, and do not write one into a file.",
    s.vaultItems && s.vaultItems.length ? `Vault items you may use: ${some(s.vaultItems.map(x => clean(x)), 8, "vault.list")}.` : "",
  ]);

  if (has("planner")) add("planner", 10, [
    "The planner holds the person's reminders, todos and alarms; a promise to remind them is made real with planner_add in the same turn.",
  ]);
  if (has("computer")) add("computer", 11, [
    "Computer tools (a browser, the desktop) act on the person's own machine only after their grant, and each outward step still waits for their yes.",
  ]);

  if (has("show")) add("show", 12, [
    "To show the person something you built or started, tools_call previews.open (the port your server listens on, or a file or folder you wrote): a card appears in the chat and they open it from there. When more than one thing is unclear, ask them all at once with ask.many.",
  ]);

  const more = [...new Set(families.filter(f => (FAMILIES[f] || {}).more).map(f => f))];
  add("learn", 99, [
    "To learn more, ask: work.tools (what you may use), records.types (the data), tools_call work.situation (where you are and what waits), docs_find for how Vyre works, skills_find for a skill that fits the job, vyre_core for its modules, and read the tool list your MCP server offers. The list is short on purpose: tools_find finds any other tool you may use and tools_call runs it. Do not assume a tool exists that tools_find does not return.",
    more.length ? `Also reachable: ${some(more, 16, "the tool list")}.` : "",
  ], true);

  // Fit: drop whole parts, lowest priority (highest rank) first, never a kept one.
  let kept = parts.slice();
  const size = () => kept.reduce((n, p) => n + p.text.length + 2, 0);
  while (size() > budget) {
    const drop = kept.filter(p => !p.keep).sort((x, y) => y.rank - x.rank)[0];
    if (!drop) break;
    kept = kept.filter(p => p !== drop);
  }
  kept.sort((x, y) => x.rank - y.rank);
  const body = kept.map(p => p.text).join("\n\n");
  const text = `[Vyre environment]\n${body}\n[/Vyre environment]`;
  return { text, parts: kept.map(p => ({ id: p.id, chars: p.text.length })), chars: text.length, version: createHash("sha256").update(text).digest("hex").slice(0, 12), families };
}
