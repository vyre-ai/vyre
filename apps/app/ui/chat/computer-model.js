// @ts-check
// The pure half of the Computer tab: an agent computer's status as one of three states, the words under its screen, and what can be done from each state. No tool is called here.

/** first: the server has not made the agents' computer yet, so waking makes it (the first start takes a while). @typedef {{ state: "asleep" | "waking" | "live", lastActive: number, thumbnail: string, first?: boolean }} ComputerView */

const STATES = ["asleep", "waking", "live"];
const IMAGE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,/;

/** The agent computer's status (computers.agent.status) as the tab shows it. A state the box does not name, and "none" (not on the computer yet), read as asleep; a thumbnail is kept only when it is an image data URL. @param {any} d @returns {ComputerView} */
export function computerOf(d) {
  const state = STATES.includes(d?.state) ? d.state : "asleep";
  const t = typeof d?.thumbnail === "string" && IMAGE.test(d.thumbnail) ? d.thumbnail : "";
  return { state, lastActive: Number(d?.lastActive) || 0, thumbnail: t, ...(d?.firstStart === true ? { first: true } : {}) };
}

const NOT_ON = "Agent computers aren't set up on this server yet. Update the server to turn them on.";
/** A server older than plain words answers with its driver's own message; these are the ones it has, said the way a newer server says them. @type {Array<[RegExp, string]>} */
const OLD_WORDS = [
  [/no computer driver is configured|computers\.docker is not set|the agent computer is not set up on this machine/i, NOT_ON],
  [/no such image/i, "The agent computer's image isn't on this server yet. Update the server to download it."],
  [/vyre docker proxy:/i, "This server's computer service refused to start the agent computer because its settings don't match. Update the server to fix it."],
];

/** Why the computer cannot run, as the tab says it: the server's own words (computers.agent.status `problem`, or a refusal), never a driver's raw message. @param {unknown} message */
export function computerProblem(message) {
  const m = String(message || "");
  for (const [re, words] of OLD_WORDS) if (re.test(m)) return words;
  return m;
}

/** The line under the screen. @param {ComputerView} v @param {string} name */
export function computerWords(v, name) {
  if (v.state === "waking" && v.first) return "Starting this agent's computer for the first time…";
  if (v.state === "waking") return `Waking ${name}'s computer. Its browser and screen come back where they were.`;
  if (v.state === "live") return `${name}'s computer is live. You are watching.`;
  return `${name}'s computer is asleep. Its browser opens where it was left when it wakes.`;
}

/** What the person can do from this state. "wake" starts it (the asleep screen itself is the control); "open" goes full screen; "sleep" closes the screen and the browser (terminal jobs keep running). @param {ComputerView} v @returns {("wake" | "open" | "sleep")[]} */
export const computerActions = (v) => (v.state === "asleep" ? ["wake"] : v.state === "live" ? ["open", "sleep"] : []);

/** The dock under the full-screen view. */
export const DOCK = [{ id: "chrome", label: "Chrome", icon: "globe" }, { id: "files", label: "Files", icon: "folder" }, { id: "terminal", label: "Terminal", icon: "terminal" }];
