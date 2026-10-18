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
  if (v.state === "waking") return `Waking ${name}'s computer. Chrome and the screen come back where they were.`;
  if (v.state === "live") return `${name}'s computer is live. You are watching.`;
  return `${name} is asleep. Waking it reopens Chrome where it was left.`;
}

/** What the person can do from this state. "wake" starts it; "open" goes full screen; "sleep" closes the screen and Chrome (terminal jobs keep running). @param {ComputerView} v @returns {("wake" | "open" | "sleep")[]} */
export const computerActions = (v) => (v.state === "asleep" ? ["wake"] : v.state === "live" ? ["open", "sleep"] : []);

/** The dock under the full-screen view. */
export const DOCK = [{ id: "chrome", label: "Chrome", icon: "globe" }, { id: "files", label: "Files", icon: "folder" }, { id: "terminal", label: "Terminal", icon: "terminal" }];

/**
 * Where the session runs, in the viewer's words (the spec's two: "My Computer" and "Space's Cloud"). It is relative to who looks: "My Computer" when the Space's server runs on a device of the viewer's own (the owner's
 * own Mac, Vyre Home: role "local", and the viewer is the Space's owner), "Space's Cloud" for everyone else and for any server that is not the viewer's own device. The tool gives facts (`runs_on: { role, owner }`), not words.
 * @param {{ role?: string | null, owner?: string | null } | null | undefined} runsOn @param {string | null | undefined} viewer the viewer's person id
 * @returns {"My Computer" | "Space's Cloud"}
 */
export function whereWords(runsOn, viewer) {
  return runsOn && runsOn.role === "local" && runsOn.owner && viewer && String(runsOn.owner) === String(viewer) ? "My Computer" : "Space's Cloud";
}

/**
 * Everything the Computer tab needs for one agent, from computers.agent.frame's answer: the state and picture (a data URL, or none), where it runs in the viewer's words, who holds the screen, and which buttons apply.
 * Watch needs a live screen; Take over needs a live screen and the right to edit the agent, and is not offered while someone already has it.
 * @param {any} d the tool's answer @param {{ viewer?: string | null, canEdit?: boolean }} [who]
 */
export function agentComputerView(d, who = {}) {
  const v = computerOf(d);
  const heldBy = d?.held_by === "taken-over" || d?.held_by === "watching" ? d.held_by : null;
  const live = v.state === "live";
  return {
    ...v,
    frame: v.thumbnail || "",
    withheld: d?.withheld === "typing" || d?.withheld === "shielded" ? d.withheld : null,
    heldBy,
    where: whereWords(d?.runs_on, who.viewer),
    canWatch: live,
    canTakeOver: live && who.canEdit === true && heldBy !== "taken-over",
  };
}
