// @ts-check
// The pure half of the Computer tab: an agent computer's status as one of three states, the words under its screen, and what can be done from each state. No tool is called here.

/** @typedef {{ state: "asleep" | "waking" | "live", lastActive: number, thumbnail: string }} ComputerView */

const STATES = ["asleep", "waking", "live"];
const IMAGE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,/;

/** The agent computer's status (computers.agent.status) as the tab shows it. A state the box does not name, and "none" (not on the computer yet), read as asleep; a thumbnail is kept only when it is an image data URL. @param {any} d @returns {ComputerView} */
export function computerOf(d) {
  const state = STATES.includes(d?.state) ? d.state : "asleep";
  const t = typeof d?.thumbnail === "string" && IMAGE.test(d.thumbnail) ? d.thumbnail : "";
  return { state, lastActive: Number(d?.lastActive) || 0, thumbnail: t };
}

/** The line under the screen. @param {ComputerView} v @param {string} name */
export function computerWords(v, name) {
  if (v.state === "waking") return `Waking ${name}'s computer. Its browser and screen come back where they were.`;
  if (v.state === "live") return `${name}'s computer is live. You are watching.`;
  return `${name}'s computer is asleep. Its browser opens where it was left when it wakes.`;
}

/** What the person can do from this state. "wake" starts it (the asleep screen itself is the control); "open" goes full screen; "sleep" closes the screen and the browser (terminal jobs keep running). @param {ComputerView} v @returns {("wake" | "open" | "sleep")[]} */
export const computerActions = (v) => (v.state === "asleep" ? ["wake"] : v.state === "live" ? ["open", "sleep"] : []);

/** The dock under the full-screen view. */
export const DOCK = [{ id: "chrome", label: "Browser", icon: "globe" }, { id: "files", label: "Files", icon: "folder" }, { id: "terminal", label: "Terminal", icon: "terminal" }];
