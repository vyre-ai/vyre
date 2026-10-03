// @ts-check
// Wink, as the user sees it (DESIGN-wink.md section 4): one way anything joins. Reverse scan is the default: the new device shows a ring and the phone scans it.
// Scan the code or paste the long one, then confirm three words on both screens. No typed codes. Pure, so Node tests it.

/** @typedef {"phone"|"computer"|"server"} DeviceKind */

/** The default name of the thing being added. */
export const DEFAULT_NAMES = { phone: "Alex's iPhone", computer: "Alex's MacBook", server: "nova" };

/** Words the pairing screens use (DESIGN-wink.md section 4; core/wink/cards.js has the matching lines for the module). */
export const COPY = {
  pick: "The other screen shows three words. Pick the set that matches, or type all three.",
  /** The line above the words: who is asking. */
  askLine: (/** @type {string} */ who) => `${who} is asking to pair. Both screens show these three words.`,
  rejected: "Nothing was paired. The words were not the same. Start again from the new device.",
  ended: "The pairing ended before it was confirmed, so nothing was paired. Start again from the new device.",
  noCodeInPicture: "No Vyre code in that picture. Scan the code on the screen, or paste the long code it shows.",
  noClipboard: "Vyre could not read what you copied. Paste the long code into the field.",
};

/** A server prints its code and waits; a phone or computer shows a ring for the other device to scan. */
export const showsRing = (/** @type {DeviceKind} */ kind) => kind !== "server";

/** Steps: a phone or computer shows a ring, is scanned, shows the words, is done (4). A server prints a code, shows the words, is done (3). */
export const stepCount = (/** @type {DeviceKind} */ kind) => (showsRing(kind) ? 4 : 3);

/** The last step index. */
export const lastStep = (/** @type {DeviceKind} */ kind) => stepCount(kind) - 1;

/** The step where the three words show. */
export const wordsStep = (/** @type {DeviceKind} */ kind) => (showsRing(kind) ? 2 : 1);

/** "Step 2 of 4 · scan, then confirm three words" */
export function stepLine(/** @type {number} */ step, /** @type {DeviceKind} */ kind) {
  return `Step ${step + 1} of ${stepCount(kind)} · ${showsRing(kind) ? "scan, then confirm three words" : "scan or paste, then confirm three words"}`;
}

/** What the new device and the phone each say at a step. */
export function stepWords(/** @type {DeviceKind} */ kind, /** @type {number} */ step) {
  const noun = kind === "server" ? "server" : kind === "phone" ? "phone" : "computer";
  if (!showsRing(kind)) {
    return [
      "The server printed a QR code and a long code. Scan the QR, or paste the long code. A short typed code is not accepted.",
      "The server shows who is asking and the same three words. Confirm only if they match.",
      "Both screens say done. Nothing was configured.",
    ][step];
  }
  return [
    `The new ${noun} shows its code. The phone is already trusted.`,
    "The camera opens already pointed at the code. You can paste the long code instead.",
    "Both screens show the same three words, made from both sides' keys. Confirm only if they match.",
    "Both screens say done. Nothing was configured.",
  ][step];
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
