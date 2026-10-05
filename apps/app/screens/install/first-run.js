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

/** Setup's one question (the user, 5 Oct): joining a team needs only a name and a typed code; "my own server" sets up My Cloud. Never "Pro" or "Basic" in copy. */
export const QUESTION = {
  title: "Do you have your own server, or are you joining a team?",
  join: { title: "I am joining a team", line: "Make your name, connect this device with a code, and you are in." },
  own: { title: "I have my own server", line: "Set up My Cloud on it." },
};

/** The route that sets up My Cloud on the person's own server: where "Add your own server" on a home that joined a team links to, and where the question's second answer goes. */
export const SERVER_SETUP_ROUTE = "/u/setup/server";

/** "Set up My Cloud": the person's own server. A phone is sent the setup link (it never shows an install line); a computer shows the one line to run there, then connects by the code the server shows. */
export const MY_CLOUD = {
  title: "Set up My Cloud",
  line: "My Cloud runs on a computer or a server that stays on. Your phones and browsers connect to it.",
  lineComputer: "Open its terminal and paste the line. It shows a code when it is ready.",
  linePhone: "Send yourself the setup link and open it on that computer. It shows a code when it is ready.",
  send: "Send me the setup link",
  ready: "My server shows a code",
  share: "Set up My Cloud on a computer or a server: https://vyre.run",
  codeTitle: "Type the code your server shows",
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

/** Mac, On a server, in the boxless window (rows 4e and 4f of the prototype): type the code the server shows, then type this Mac's ack on the server. */
export const MAC_SERVER = {
  title: "Type the code your server shows",
  line: "Your server shows an avatar and a code that starts with WINK.",
  help: "The code works once. Your server shows how long it has left.",
  connect: "Connect",
  back: "Back",
  ackTitle: "Type this on your server",
  ackLine: "Your server is waiting. Type this code there to finish connecting.",
  cancel: "Cancel",
  doneTitle: "Connected to your server",
  doneLine: "Vyre is running there. Setup carries on here.",
  doneRow: "Your server",
  doneContinue: "Continue",
  wrongTitle: "That code is not right",
  tries: 3,
};

/** What the Mac says when typing the server's code did not work. `left` is how many tries remain; none left ends the code. @param {string} reason @param {number} left */
export function macServerSay(reason, left) {
  if (reason === "expired") return { title: "That code ran out of time", line: "Run the line on your server again to get a new one.", over: true };
  if (reason === "offline") return { title: "Your Mac cannot reach the server", line: "Check that it is on and online. Nothing was connected.", over: false };
  if (reason === "busy") return { title: "Too many tries", line: "Wait a minute, then try again.", over: false };
  if (left <= 0) return { title: "That code is not right", line: "It has ended. Run the line on your server again to get a new one.", over: true };
  return { title: "That code is not right", line: `Check the code on your server and type it again. ${left} ${left === 1 ? "try" : "tries"} left.`, over: false };
}

/**
 * The line to run on a server. A release candidate's own install script only when the bridge gives a version with a hyphen ("0.3.0-rc.1"); a plain release ("0.3.0"), an unknown version and anything that is not a version get the stable line.
 * @param {string | null | undefined} version
 */
export function installLine(version) {
  const v = String(version ?? "").trim();
  if (!/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(v)) return "curl -fsSL vyre.run/i | sh";
  const base = `https://github.com/vyre-ai/vyre/releases/download/v${v}/`;
  return `curl -fsSL ${base}install-box.sh | VYRE_BOX_URL=${base} sh`;
}

/** Is the page the Mac app's window with no vyred of its own (the bridge says boxless)? @param {{ boxless?: boolean } | null | undefined} shell */
export const isBoxlessMac = (shell) => Boolean(shell && shell.boxless === true);

/** The Mac's "Add your phone": the phone becomes the one that approves. */
export const ADD_PHONE = {
  title: "Add your phone",
  line: "Scan this with Vyre on your phone. Your phone becomes the one that approves.",
  orPaste: "Or paste the long code on your phone",
  words: "Check that the phone shows the same three words.",
  skip: "Skip",
  waiting: "Waiting for your phone.",
};

/** A browser holds no key: it connects from a phone, or says Vyre is not set up. */
export const BROWSER = {
  title: "Open Vyre on your phone",
  line: "On your phone, open Vyre, then Devices, then Add a device, and scan or paste its code here.",
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
  have: "I don't have Vyre running yet",
  send: "Send me the setup link",
  notNow: "Not now",
  share: "Set up Vyre on a computer or a server: https://vyre.run",
};

/** RC1: the drawn Wink avatar cannot be read by the camera yet (RC2), so a pairing screen offers no camera view; a code is typed or pasted. */
export const CAMERA_SCAN = false;

/** The drawn Wink code is read by the camera (src/native/WinkScan, the Deck's decoder in a WebView) wherever a person can type a code: TypeCode's "Scan the code" action. A phone only; a browser has no reader here. */
export const DRAWN_CODE_SCAN = true;

/** "I don't have Vyre running yet" is offered on a phone's connect screen only (never in a mock walk, a Mac or a browser). @param {DeviceKind} kind @param {boolean} mock */
export const offersNoVyre = (kind, mock) => isPhone(kind) && !mock;

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
  now: { title: "Nothing needs you", line: "Anything that waits on you shows here.", action: "Open Chats", route: "/u/chats" },
  chats: { title: "No chats yet", line: "Start one with your assistant or an agent.", action: "New chat", route: "/u/chats/new" },
  agents: { title: "No assistants yet", line: "An assistant works on your own AI account.", action: "Connect your AI account", route: "/u/settings/ai" },
};

/** The box has not answered and nothing is cached: one line, one action, never a blank screen. */
export const WAITING = { title: "Your Vyre has not answered yet", line: "Check that it is on and online. Nothing was lost.", action: "Try again", route: "refresh" };

/** What is missing on this device, as the empty state's words (row 8b). One line, one fixing action. @type {Record<"phone"|"mac"|"web", EmptyCopy>} */
export const GAP = {
  phone: { title: "Not connected to a Vyre", line: "Your phone needs a running Vyre to show anything.", action: "Scan the code", route: "/u/install/connect" },
  mac: { title: "Nothing can approve yet", line: "No phone is paired, so sends and new devices wait.", action: "Add your phone", route: "/u/install/phone" },
  web: { title: "Not connected", line: "This browser has no Vyre to talk to.", action: "Scan from your phone", route: "/u/install/connect" },
};

/**
 * What is missing, or null. A phone or browser with no pairing and no box address is not connected. A Mac whose Vyre answers but lists no phone has nothing to approve with.
 * @param {{ kind: DeviceKind, paired: boolean, hasBox: boolean, devices: { device?: string, kind?: string }[] | null }} s  (a phone is a relay device of kind "app", or one named a phone)
 * @returns {EmptyCopy | null}
 */
export function gapOf({ kind, paired, hasBox, devices }) {
  if (!paired && !hasBox) return isPhone(kind) ? GAP.phone : kind === "mac" ? null : GAP.web;
  if (kind === "mac" && Array.isArray(devices) && !devices.some((d) => d.kind === "app" || /phone/i.test(String(d.device ?? "")))) return GAP.mac;
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
  // A server that is someone else's says whose: a phone is told it about "this Vyre", never "server".
  const owned = /^This server belongs to (\S+?)\.(?: |$)/.exec(t);
  if (owned) return kind === "web" ? t : `This Vyre belongs to ${owned[1]}. Ask them to add you to a space, or reset it to start over.`;
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

/** Has a paired person left the box's setup unfinished (onboard.status finished is false)? Anything else, an unreadable answer included, is "no": the banner never nags on a guess. @param {any} st */
export const setupUnfinished = (st) => Boolean(st) && typeof st === "object" && st.finished === false;
/** The one banner for it: where it leads is the onboarding the box runs (/u/install/setup). */
export const SETUP_BANNER = { title: "Finish setting up Vyre", line: "A few steps are left: your assistant, your Claude and your devices.", action: "Finish setup", route: "/u/install/setup" };
