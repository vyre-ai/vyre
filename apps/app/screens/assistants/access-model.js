// @ts-check
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
