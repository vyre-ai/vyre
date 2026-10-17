// @ts-check
// Wink, as the user sees it: the lines of the Devices screens (what a device says about itself, what removing does, when a lent computer is sharing). Pure, so Node tests it.

/** The one plain line a device row shows when its key is kept in software. */
export const SOFTWARE_KEY = "This device keeps its key in software";

/** The line under a device's name: what it is and when it was used, then the software-key line only when that is true. */
export const deviceSub = (/** @type {string} */ what, /** @type {string} */ last, /** @type {boolean | undefined} */ software) => [`${what}, last used ${last}`, ...(software ? [SOFTWARE_KEY] : [])];

/** Both sides must say yes before a computer runs a space's work (DESIGN-wink.md section 7). */
export function lendState(/** @type {{ spaceAllows: boolean, meAllows: boolean }} */ l) {
  if (l.spaceAllows && l.meAllows) return "sharing";
  return "waiting";
}

/** "Mine, Juniper Studio and Northwind Bakery". */
export function list(/** @type {string[]} */ a) {
  return a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}

/** The line under a device that says which spaces it reaches. */
export const spacesLine = (/** @type {string[]} */ names) => (names.length ? `In ${list(names)}` : "Not in any space");

/** On a phone's page: what a reinstall does, and how to stop this phone. */
export const REINSTALL_LINE = "Reinstalling Vyre on this phone resumes as you, because the phone keeps your key. To stop this phone reaching your spaces, remove it below, or remove it from another of your devices.";

/** What removing something does, said before it happens. */
export function removeText(/** @type {"Device"|"Person"|"Agent"|"Kit"|"Flow"} */ kind, /** @type {string} */ name, space = "Juniper Studio") {
  const first = name.split(" ")[0];
  return {
    Device: `Removing ${name} stops it opening anything of yours from now on, and what is stored on it is deleted when it next connects or its access runs out. It cannot take back what it has already opened or copied.`,
    Person: `Remove ${name} from ${space}? ${first} loses its projects and servers at once. ${first} keeps their own notes and files.`,
    Agent: `Remove ${name}? Its jobs stop at once. What it wrote stays in the records it was written on.`,
    Kit: `Remove the Kit "${name}"? Its Flows stop and its views are hidden. Your records stay.`,
    Flow: `Turn off and remove "${name}"? Runs in progress finish on the version they started with. New ones stop.`,
  }[kind];
}
