// @ts-check
// Wink, as the user sees it (DESIGN-wink.md section 4): one way anything joins. Reverse scan is the default: the new device shows a ring and the phone scans it.
// A computer can fall back to a typed code, two-sided. Pure, so Node tests it.

/** @typedef {"phone"|"computer"|"server"} DeviceKind */

/** The default name of the thing being added. */
export const DEFAULT_NAMES = { phone: "Alex's iPhone", computer: "Alex's MacBook", server: "nova" };

/** Only a computer has the typed-code fallback: a phone has a camera, a server prints its code. */
export const canFallback = (/** @type {DeviceKind} */ kind) => kind === "computer";

/** How many steps the add has: four by reverse scan (ring, scan, approve, done), three by code (code, number, done). */
export const stepCount = (/** @type {boolean} */ fallback) => (fallback ? 3 : 4);

/** The last step index. */
export const lastStep = (/** @type {boolean} */ fallback) => stepCount(fallback) - 1;

/** "Step 2 of 4 · reverse scan" */
export function stepLine(/** @type {number} */ step, /** @type {boolean} */ fallback) {
  return `Step ${step + 1} of ${stepCount(fallback)} · ${fallback ? "using a code" : "reverse scan"}`;
}

/** What the new device and the phone each say at a step. */
export function stepWords(/** @type {DeviceKind} */ kind, /** @type {number} */ step, /** @type {boolean} */ fallback) {
  const noun = kind === "server" ? "server" : kind === "phone" ? "phone" : "computer";
  if (fallback) {
    return [
      "The fallback, for a phone that cannot see the screen. The code is a one-time password.",
      "One try per code. A wrong tap closes the code and a new one shows.",
      "Both screens say done.",
    ][step];
  }
  return [
    `The new ${noun} shows its ring and its name. The phone is already trusted.`,
    "The camera opens already pointed at the ring. It reads in about a second.",
    "The phone says what it is adding, and the fingerprint matches the other screen. Face ID is the approval.",
    "Both screens say done. Nothing was typed and nothing was configured.",
  ][step];
}

/** A wrong number closes the code: back to the first step with a new code. */
export function pick(/** @type {string} */ n, /** @type {string} */ right = "47") {
  return n === right ? { ok: true } : { ok: false };
}

/** Both sides must say yes before a computer runs a space's work (DESIGN-wink.md section 7). */
export function lendState(/** @type {{ spaceAllows: boolean, meAllows: boolean }} */ l) {
  if (l.spaceAllows && l.meAllows) return "sharing";
  return "waiting";
}

/** "Mine, Harlow Legal and Northwind Bakery". */
export function list(/** @type {string[]} */ a) {
  return a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}

/** The line under a device: where it is. */
export function deviceLine(/** @type {string} */ name, /** @type {string[]} */ spaceNames) {
  return spaceNames.length ? `${name} is in ${list(spaceNames)}` : `${name} is not in any space`;
}

/** What removing something does, said before it happens. */
export function removeText(/** @type {"Device"|"Person"|"Assistant"|"Kit"|"Flow"} */ kind, /** @type {string} */ name, space = "Harlow Legal") {
  const first = name.split(" ")[0];
  return {
    Device: `Removing ${name} stops it opening anything of yours from now on, and what is stored on it is deleted when it next connects or its access runs out. It cannot take back what it has already opened or copied.`,
    Person: `Remove ${name} from ${space}? ${first} loses its projects and servers at once. ${first} keeps their own notes and files.`,
    Assistant: `Remove ${name}? Its jobs stop at once. What it wrote stays in the records it was written on.`,
    Kit: `Remove the Kit "${name}"? Its Flows stop and its views are hidden. Your records stay.`,
    Flow: `Turn off and remove "${name}"? Runs in progress finish on the version they started with. New ones stop.`,
  }[kind];
}
