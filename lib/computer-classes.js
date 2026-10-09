// @ts-check
// What a Vyre Computer action touches, by class (R031-90). One list for both ends of the link: the box's `computer` tool names the class of what it asks, and the Mac checks that the person allowed that
// class for the box (link.computer.allow) before anything runs. A reading class never moves anything; `act` drives a page or an app (the engine's own Gate still holds a send); `files` finds and
// brings files from the folders the person chose for Vyre.

/** Action -> class. */
export const CLASS = Object.freeze({ look: "look", shot: "look", tabs: "look", open: "act", click: "act", type: "act", fill: "act", act: "act", press: "act", signin: "act", find: "files", get: "files" });

/** The classes a person can allow for the box, in the order they are shown. */
export const CLASSES = Object.freeze(["look", "act", "files"]);

/** The class of an action, or null when it is not one a computer does. @param {unknown} action */
export const classOf = action => (typeof action === "string" && Object.prototype.hasOwnProperty.call(CLASS, action) ? /** @type {Record<string, string>} */ (CLASS)[action] : null);

/**
 * The engine tool for an action on a kind of computer. `args` pass through as the engine's own input (its own names for a control: a selector for the cloud's Chrome, a ref for the Mac's).
 * @param {"cloud" | "here" | "mac"} kind @param {string} action @param {{ app?: string, screen?: boolean }} q
 * @returns {string | null}
 */
export function engineFor(kind, action, q = {}) {
  const app = Boolean(q.app);
  if (kind === "cloud") {
    if (app) return /** @type {Record<string, string>} */ ({ look: "hands-desktop.tree", shot: "hands-desktop.screenshot", act: "hands-desktop.act", click: "hands-desktop.act", type: "hands-desktop.act", press: "hands-desktop.act" })[action] || null;
    return /** @type {Record<string, string>} */ ({ look: q.screen ? "chrome.screenshot" : "chrome.snapshot", shot: "chrome.screenshot", open: "chrome.open", click: "chrome.click", type: "chrome.type" })[action] || null;
  }
  if (app) return /** @type {Record<string, string>} */ ({ look: "hands.observe", find: "hands.find", act: "hands.act", click: "hands.act", type: "hands.act", press: "hands.act", shot: "screen.shot" })[action] || null;
  return /** @type {Record<string, string>} */ ({ look: q.screen ? "chrome.screenshot" : "chrome.snapshot", shot: "chrome.screenshot", tabs: "chrome.tabs", open: "chrome.open", click: "chrome.click", type: "chrome.type", fill: "chrome.fill", act: "chrome.act" })[action] || null;
}
