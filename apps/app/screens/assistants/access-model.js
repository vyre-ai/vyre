// @ts-check
import { displayName, roleLine } from "../agents/home-model.js";
// "What my assistant may do" (G23): the person turns tools and whole areas off for their own assistant. The words and rules for the page, without a screen. The box keeps the rows (assistant.access.*) and refuses
// the assistant's call; this only reads what it says and builds the calls. A switch that is on means the assistant may use that area; turning it off narrows, turning it on again is the person's own yes (restore).

/** @typedef {{ assistant: string, tools: { name: string, at: number }[], screens: { id: string, label: string, off: boolean }[] }} AccessState */

/** The answer of assistant.access.get/narrow/restore, or null when the box does not know it. @param {any} d @returns {AccessState | null} */
export function stateFrom(d) {
  if (!d || !Array.isArray(d.screens)) return null;
  return {
    assistant: String(d.assistant || "assistant"),
    tools: (Array.isArray(d.tools) ? d.tools : []).filter((/** @type {any} */ t) => t && typeof t.name === "string").map((/** @type {any} */ t) => ({ name: t.name, at: Number(t.at) || 0 })),
    screens: d.screens.filter((/** @type {any} */ s) => s && typeof s.id === "string").map((/** @type {any} */ s) => ({ id: s.id, label: String(s.label || s.id), off: s.off === true })),
  };
}

/** The line under an area's switch. @param {boolean} off */
export const areaLine = (off) => (off ? "Your agent cannot use this." : "Your agent may use this.");

/** The call a switch makes: off narrows, on restores. @param {string} id @param {boolean} on */
export const switchCall = (id, on) => ({ tool: on ? "assistant.access.restore" : "assistant.access.narrow", input: { screens: [id] } });

/** The call "turn off a tool" makes, or the reason it is not one. @param {string} typed */
export function toolCall(typed) {
  const name = String(typed || "").trim().toLowerCase();
  if (!name) return { problem: "Type a tool name, like records.list, or a family, like records.*." };
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+(\.\*)?$/.test(name) && !/^[a-z][a-z0-9_]*\.\*$/.test(name)) return { problem: "That is not a tool name. Use a name like records.list, or a family like records.*." };
  return { tool: "assistant.access.narrow", input: { tools: [name] } };
}

/** What the page says when a call is refused. @param {string | undefined} code @param {string} message */
export const refusal = (code, message) => (code === "denied" ? "Only you can change what your agent may do." : code === "presence_required" || code === "presence_denied" ? "Turning something back on needs your approval. Approve on this device, then try again." : message || "That did not go through.");

/** How many things are off, for the line under the page title. @param {AccessState | null} s */
export function summary(s) {
  if (!s) return "";
  const n = s.tools.length + s.screens.filter((x) => x.off).length;
  return n ? `${n} ${n === 1 ? "thing is" : "things are"} turned off for your agent.` : "Your agent can do what you can do. Turn off anything you do not want it to touch.";
}

/** What each agent card shows: its name as a person says it, one line of what it is for (never its instructions), and the page it opens. The assistant first, then the others by name. @param {any} d */
export function agentCards(d) {
  const list = Array.isArray(d) ? d : /** @type {any} */ (d)?.agents;
  return (Array.isArray(list) ? list : []).filter((a) => a && typeof a.name === "string").sort((a, b) => (a.kind === "assistant" ? 0 : 1) - (b.kind === "assistant" ? 0 : 1) || String(a.name).localeCompare(String(b.name)))
    .map((a) => ({ name: a.name, title: displayName(a), sub: roleLine(a, a.kind === "assistant" ? "Your assistant" : a.builtin ? "Builds your Space by conversation" : "Agent"), href: agentHref(a.name) }));
}

/** The page of one agent (the Agents home opens the same one). @param {string} name */
export const agentHref = (name) => `/u/assistants/${encodeURIComponent(name)}`;

/** The area a tool family belongs to, in the words the Areas list uses; any other family is its module's name with a capital. */
const FAMILY_WORDS = /** @type {Record<string, string>} */ ({ vault: "Vault", mail: "Mail and messages", comms: "Mail and messages", records: "Records and contacts", files: "Files and Drive", flows: "Flows", work: "Projects and tasks", projects: "Projects and tasks", tasks: "Projects and tasks", documents: "Documents and signing", publish: "Publishing", connectors: "Connections", memory: "Memory", planner: "Calendar and planner", calendar: "Calendar and planner" });
export const FAMILY_PREFIXES = Object.keys(FAMILY_WORDS);
const capital = (/** @type {string} */ w) => w.charAt(0).toUpperCase() + w.slice(1);
const NEVER_OFFERED = (/** @type {string} */ n) => n.startsWith("assistant.access.");

/**
 * What the picker offers when the person looks for a tool to turn off: the tools the modules offer as commands, grouped by family, in plain words (the command's own summary), minus what is already off,
 * and narrowed by what they typed (a word of the plain name, the family, or the id). Each group leads with "everything in it". @param {any} commands commands.list's answer
 * @param {string[]} off names already turned off (a tool or a family) @param {string} query
 * @returns {{ family: string, title: string, all: { name: string, label: string }, tools: { name: string, label: string, id: string }[] }[]}
 */
export function pickerGroups(commands, off, query) {
  const list = Array.isArray(commands) ? commands : /** @type {any} */ (commands)?.commands;
  const q = String(query || "").trim().toLowerCase();
  const stopped = new Set(off);
  const by = /** @type {Map<string, { name: string, label: string, id: string }[]>} */ (new Map());
  for (const c of Array.isArray(list) ? list : []) {
    const id = c && typeof c.tool === "string" ? c.tool : "";
    if (!id || NEVER_OFFERED(id) || stopped.has(id)) continue;
    const family = id.split(".")[0];
    if (stopped.has(`${family}.*`)) continue;
    const said = String(c.summary || "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
    const label = (said || capital(String(c.verb || id.split(".").slice(1).join(" ")).replace(/[-_.]+/g, " "))).slice(0, 90);
    const row = by.get(family) || []; if (!row.some((r) => r.id === id)) row.push({ name: id, label: capital(label), id }); by.set(family, row);
  }
  const out = [];
  for (const [family, tools] of [...by].sort((a, b) => (FAMILY_WORDS[a[0]] || capital(a[0])).localeCompare(FAMILY_WORDS[b[0]] || capital(b[0])))) {
    const title = FAMILY_WORDS[family] || capital(family);
    const groupHit = !q || title.toLowerCase().includes(q) || family.includes(q);
    const hits = groupHit ? tools : tools.filter((t) => t.label.toLowerCase().includes(q) || t.id.includes(q));
    if (!hits.length) continue;
    out.push({ family, title, all: { name: `${family}.*`, label: `Everything in ${title}` }, tools: hits.sort((a, b) => a.label.localeCompare(b.label)) });
  }
  return out;
}

/** A turned-off name in plain words: a family is "Everything in Mail and messages", a tool is what it does when the picker knows it, else the id itself. @param {string} name @param {any} commands commands.list's answer */
export function offTitle(name, commands) {
  const fam = /^([a-z][a-z0-9_]*)\.\*$/.exec(name);
  if (fam) return `Everything in ${FAMILY_WORDS[fam[1]] || capital(fam[1])}`;
  const list = Array.isArray(commands) ? commands : /** @type {any} */ (commands)?.commands;
  const c = (Array.isArray(list) ? list : []).find((/** @type {any} */ x) => x && x.tool === name);
  const said = c ? String(c.summary || "").replace(/\s+/g, " ").trim().replace(/\.$/, "") : "";
  return said ? capital(said).slice(0, 90) : name;
}
