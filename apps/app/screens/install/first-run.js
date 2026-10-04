// @ts-check
// First run, per platform (team/0.3/DESIGN-first-run-per-platform.md, the prototype's "Not built" rows). Pure, so Node tests it.
// Each device offers only what it can do: a phone holds the key and connects, a Mac can host Vyre, a browser holds nothing.

/** @typedef {"ios"|"android"|"mac"|"web"} DeviceKind */

/** The kind of device from the platform and whether the Mac app's window hosts the page. @param {string} os @param {boolean} macShell @returns {DeviceKind} */
export function deviceKind(os, macShell) {
  if (os === "ios") return "ios";
  if (os === "android") return "android";
  return macShell ? "mac" : "web";
}
export const isPhone = (/** @type {DeviceKind} */ k) => k === "ios" || k === "android";

/** The first step of a first run: a browser starts at "Open Vyre on your phone", a phone or a Mac at the welcome. @param {DeviceKind} kind @param {boolean} canClaim */
export function firstStep(kind, canClaim) {
  return kind === "web" && !canClaim ? "browser" : "welcome";
}

export const WELCOME = {
  title: "Vyre",
  line: "Your assistants, your people and your work, in one place you control.",
  start: "Get started",
  have: "I already have Vyre",
};

/** Step 4 on a Mac: where Vyre runs. The server path shows one line to run there. */
export const MAC_WHERE = {
  title: "Where should Vyre run?",
  line: "Vyre runs on a computer or a server. Phones and browsers connect to it.",
  hereTitle: "On this Mac",
  hereLine: "Only while the Mac stays on.",
  serverTitle: "On a server",
  serverLine: "Shows one line to run there, then you pair with a code.",
};

/** The Mac's "Add your phone": the phone becomes the one that approves. */
export const ADD_PHONE = {
  title: "Add your phone",
  line: "Scan this with Vyre on your phone. Your phone becomes the one that approves.",
  orPaste: "Or paste the long code on your phone",
  words: "Check that the phone shows the same three words.",
  skip: "Skip",
  waiting: "Waiting for your phone.",
  expires: "Good for 5 minutes.",
};

/** A browser holds no key: it connects from a phone, or says Vyre is not set up. */
export const BROWSER = {
  title: "Open Vyre on your phone",
  line: "Your phone holds your key. In Vyre on your phone choose Add a device, then A computer, and scan the code it shows or paste it here.",
  notSet: "Vyre is not set up yet?",
  notSetTitle: "Set up Vyre on a computer or server first",
  notSetLine: "A browser connects to a Vyre that is already running. Install it on a computer or a server, then come back.",
  openSite: "Open vyre.run",
  site: "https://vyre.run",
  back: "Back",
};

/** The phone's "I don't have Vyre running yet" (native-core builds it; the words live here so the share sheet and the empty states say the same). */
export const NO_VYRE = {
  title: "Vyre runs on a computer or a server",
  line: "Your phone connects to it. Send yourself the setup link and open it on a computer.",
  send: "Send me the setup link",
  notNow: "Not now",
  share: "Set up Vyre on a computer or a server: https://vyre.run",
};

/** Who a space is for (step 5). The ids are what the box is told. */
export const WHO = {
  label: "Who it is for",
  options: /** @type {[string, string][]} */ ([["team", "A team"], ["client", "A client"], ["personal", "Just me"]]),
  lines: {
    team: "The people you work with. Setup asks who to invite.",
    client: "One client of yours. Setup asks whom to invite.",
    personal: "Your own work and life. Setup skips inviting people.",
  },
};
export const whoLine = (/** @type {string} */ id) => /** @type {Record<string,string>} */ (WHO.lines)[id] ?? "";

/** @param {string} id */
export const isWho = (id) => WHO.options.some(([k]) => k === id);

/**
 * The one line and one action under an empty landing screen (the prototype's rows 8 and 8b). `gap` is what is missing on this device, or null when everything is connected.
 * @typedef {{ title: string, line: string, action: string, route: string }} EmptyCopy
 */
export const EMPTY = {
  now: { title: "Nothing needs you", line: "When an assistant asks or finishes something, it shows here.", action: "Start a chat", route: "/chats" },
  chats: { title: "No chats yet", line: "Ask an assistant to start something.", action: "Open Agents", route: "/agents" },
  agents: { title: "No assistants yet", line: "An assistant works on your own AI account.", action: "Connect your AI account", route: "/settings" },
  places: { title: "Nothing else here yet", line: "Vault, Devices and Settings are above.", action: "Open Settings", route: "/settings" },
};

/** What is missing on this device, as the empty state's words (row 8b). One line, one fixing action. @type {Record<"phone"|"mac"|"web", EmptyCopy>} */
export const GAP = {
  phone: { title: "Not connected to a Vyre", line: "Your phone needs a running Vyre to show anything.", action: "Scan the code", route: "/u/install/connect" },
  mac: { title: "Nothing can approve yet", line: "No phone is paired, so sends and new devices wait.", action: "Add your phone", route: "/u/install/phone" },
  web: { title: "Not connected", line: "This browser has no Vyre to talk to.", action: "Scan from your phone", route: "/u/install/connect" },
};

/**
 * What is missing, or null. A phone or browser with no pairing and no box address is not connected. A Mac whose Vyre answers but lists no phone has nothing to approve with.
 * @param {{ kind: DeviceKind, paired: boolean, hasBox: boolean, devices: { device?: string, kind?: string }[] | null }} s
 * @returns {EmptyCopy | null}
 */
export function gapOf({ kind, paired, hasBox, devices }) {
  if (!paired && !hasBox) return isPhone(kind) ? GAP.phone : kind === "mac" ? null : GAP.web;
  if (kind === "mac" && Array.isArray(devices) && !devices.some((d) => /phone/i.test(String(d.device ?? d.kind ?? "")))) return GAP.mac;
  return null;
}

/**
 * The words a pairing error says on a device that is not choosing a server. A phone or browser never reads "install line" or "server" for a pairing that
 * has nothing to do with one. Mac keeps the server wording because it is the one that runs the line.
 * @param {string} text @param {DeviceKind} kind
 */
export function pairSayFor(text, kind) {
  if (kind === "mac") return text;
  const t = String(text);
  if (/words were not the same|did not match/i.test(t)) return PHONE_SAY.rejected;
  if (/cannot reach|unreachable/i.test(t)) return PHONE_SAY.unreachable;
  if (/ran out of time|expired/i.test(t)) return PHONE_SAY.expired;
  if (/already used/i.test(t)) return PHONE_SAY.used;
  if (/install line|server/i.test(t)) return PHONE_SAY.ended;
  return t;
}

/** The prototype's "Proposed wording" rows, said by a phone or a browser. None names a server or an install line. */
export const PHONE_SAY = {
  rejected: "Nothing was paired. The words did not match. Start again from your Vyre.",
  unreachable: "Your phone cannot reach your Vyre right now. Nothing was paired.",
  expired: "The pairing ran out of time, so nothing was paired. Start again from your Vyre.",
  used: "That code was already used. Start again from your Vyre to get a new one.",
  ended: "The pairing did not finish, so nothing was paired. Start again from your Vyre.",
  spaceOffline: "Your phone cannot reach your Vyre right now, so it cannot make the space. Nothing was changed.",
};
