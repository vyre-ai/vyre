// @ts-check
// A person narrowing their own assistant (G23: "only the person can narrow it"). The assistant acts as its person, so by default it can do what they can; the person may turn off one tool, a family of tools
// (`records.*`) or a whole area (the screens: Vault, Mail, Records ...) for it. This is the pure half: the areas, what a name may be, which saved rows stop which tool, and the words for the refusal. The tools are
// core/assistant (assistants.access.*), the check is the registry's (core/modules/index.js, assistantAccess), and the screen is Settings, Assistant access.

/** The areas a person can switch off, each with the tool families it covers. The id is what `screens` takes. */
export const AREAS = /** @type {const} */ ([
  { id: "vault", label: "Vault", tools: ["vault.*"] },
  { id: "mail", label: "Mail and messages", tools: ["mail.*", "comms.*"] },
  { id: "records", label: "Records and contacts", tools: ["records.*"] },
  { id: "files", label: "Files and Drive", tools: ["files.*"] },
  { id: "flows", label: "Flows", tools: ["flows.*"] },
  { id: "projects", label: "Projects and tasks", tools: ["work.*", "projects.*", "tasks.*"] },
  { id: "documents", label: "Documents and signing", tools: ["documents.*"] },
  { id: "publish", label: "Publishing", tools: ["publish.*"] },
  { id: "connections", label: "Connections", tools: ["connectors.*"] },
  { id: "memory", label: "Memory", tools: ["memory.*"] },
  { id: "calendar", label: "Calendar and planner", tools: ["planner.*", "calendar.*"] },
]);
export const AREA_IDS = new Set(AREAS.map((a) => a.id));
/** Never switched off: the assistant must always be able to ask the person, and read what it may not do. */
export const NEVER = new Set(["assistants.access.get", "assistants.access.narrow", "assistants.access.restore", "assistants.access.check"]);

const TOOL = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+(\.\*)?$/;
const FAMILY = /^[a-z][a-z0-9_]*\.\*$/;

/** A tool name, or a family `area.*`, that may be switched off; anything else is not a name. @param {unknown} s */
export const validTool = (s) => typeof s === "string" && s.length <= 80 && (TOOL.test(s) || FAMILY.test(s)) && !NEVER.has(s) && !s.startsWith("assistants.access.");

/**
 * What a call's input asks for: a clean list of tools and a clean list of areas, or a plain refusal.
 * @param {any} input @returns {{ tools: string[], screens: string[] } | { problem: string }}
 */
export function askOf(input) {
  const tools = input && input.tools !== undefined ? input.tools : [], screens = input && input.screens !== undefined ? input.screens : [];
  if (!Array.isArray(tools) || !Array.isArray(screens)) return { problem: "tools and screens are lists" };
  if (tools.length + screens.length === 0) return { problem: "name at least one tool or one screen" };
  if (tools.length > 50 || screens.length > AREAS.length) return { problem: "that is too many at once" };
  const bad = tools.find((t) => !validTool(t));
  if (bad !== undefined) return { problem: `${String(bad).slice(0, 40)} is not a tool name (a tool like records.list, or a family like records.*)` };
  const badScreen = screens.find((s) => typeof s !== "string" || !AREA_IDS.has(s));
  if (badScreen !== undefined) return { problem: `${String(badScreen).slice(0, 40)} is not a screen (${AREAS.map((a) => a.id).join(", ")})` };
  return { tools: [...new Set(/** @type {string[]} */ (tools))].sort(), screens: [...new Set(/** @type {string[]} */ (screens))].sort() };
}

/** Whether a stored name stops a tool: the same name, or its family. @param {string} name @param {string} tool */
export const covers = (name, tool) => name === tool || (name.endsWith(".*") && tool.startsWith(name.slice(0, -1)));

/**
 * The saved rows that stop a tool, as the first one that does: { kind: "tool" | "screen", name, label } or null. A screen stops every tool of its area.
 * @param {{ kind: string, name: string }[]} rows @param {string} tool
 */
export function stoppedBy(rows, tool) {
  if (NEVER.has(tool)) return null;
  for (const r of rows) {
    if (r.kind === "tool" && covers(r.name, tool)) return { kind: "tool", name: r.name, label: r.name };
    if (r.kind === "screen") { const a = AREAS.find((x) => x.id === r.name); if (a && a.tools.some((t) => covers(t, tool))) return { kind: "screen", name: r.name, label: a.label }; }
  }
  return null;
}

/** The refusal in plain words: what the person turned off, and where they changed it. @param {{ kind: string, name: string, label: string }} hit @param {string} tool */
export const refusalWords = (hit, tool) => (hit.kind === "screen"
  ? `You turned off ${hit.label} for your assistant, so it cannot use ${tool}. You can change this in Settings, Assistant access.`
  : `You turned off ${hit.name} for your assistant, so it cannot use ${tool}. You can change this in Settings, Assistant access.`);

/** The state in the shape the screen reads. @param {{ kind: string, name: string, at?: number }[]} rows */
export function stateOf(rows) {
  return {
    assistant: "assistant",
    tools: rows.filter((r) => r.kind === "tool").map((r) => ({ name: r.name, at: r.at ?? 0 })),
    screens: AREAS.map((a) => ({ id: a.id, label: a.label, off: rows.some((r) => r.kind === "screen" && r.name === a.id) })),
  };
}
