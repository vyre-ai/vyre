// @ts-check
import { PHONE_SAY, WEB_SAY } from "./first-run.js";
// The install flow's rules, pure so Node tests them: names, the step graph, the server's scan-or-paste code and the three-word confirm.
// Steps (prototype p3Inst): name > recovery > spaces; or name > scan > scanwords > spaces. spaces > create > where > (cmd | vps | here) > ... > done.
// spaces > join > invite > joined.

export const NAMES_TAKEN = ["alex", "chris", "juniper", "vyre", "admin"];
export const MIN_NAME = 3;
export const RECOVERY_CODE = "R7K4-Q2MX-9HDP-W3NB";
/** What the server prints: a long code (also drawn as a QR). The app reads it by scan or paste; there is no short code to type. */
export const SERVER_LONG_CODE = "vyre://wink/2?t=SGVsbG9TYW1wbGVTZWNyZQ&r=wss%3A%2F%2Frelay.example";

/** "Juniper Studio" > "juniper-studio". The slug is what goes before .vyre.run. */
export function slug(/** @type {string} */ s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Can this name be claimed? People and spaces share one namespace, so a space cannot take its owner's name either.
 * @param {string} raw @param {string[]} [also] names already used by this person (their own name, spaces they made)
 * @returns {{ slug: string, state: "empty"|"short"|"taken"|"ok", address: string }}
 */
export function nameStatus(raw, also = []) {
  const s = slug(raw);
  const address = s ? `${s}.vyre.run` : "";
  if (!s) return { slug: s, state: "empty", address };
  if (NAMES_TAKEN.includes(s) || also.map(slug).includes(s)) return { slug: s, state: "taken", address };
  if (s.length < MIN_NAME) return { slug: s, state: "short", address };
  return { slug: s, state: "ok", address };
}

/** The words under the name field. */
export function nameNote(/** @type {ReturnType<typeof nameStatus>} */ st, /** @type {boolean} */ space) {
  if (st.state === "taken") return `${st.address} is taken.${space ? " People and spaces share names." : ""}`;
  if (st.state === "short") return "Use at least three letters.";
  if (st.state === "ok") return `${st.address} is yours to take.`;
  return "";
}

/** @type {Record<string, string|null>} */
export const BACK = {
  welcome: null, mycloud: null, adding: "scan", macserver: null, browser: null, nosetup: "browser", novyre: "scan", macwhere: null, addphone: null,
  name: null, have: "name", recover: "have", scan: "name", scanwords: "scan", recovery: null, spaces: null, create: "spaces", where: "create", cmd: "where", here: "where", look: null, members: "look", connectors: "members", kit: "connectors", done: null, join: "spaces", invite: "join", joined: null,
};

/** Where Back goes from a step. */
export function backOf(/** @type {string} */ step, /** @type {{ have?: boolean, welcome?: boolean, browser?: boolean, macFlow?: boolean }} */ ctx = {}) {
  // First run: the welcome offers a new name or an existing one, so both go back to it. A browser's pairing goes back to its own screen.
  if (ctx.welcome && step === "name") return "welcome";
  if (ctx.welcome && step === "have") return "welcome";
  if (ctx.browser && (step === "scanwords" || step === "scan")) return "browser";
  // A Mac's first run chooses where Vyre runs before the space is named, and goes on to the line or "here" without asking again.
  if (ctx.macFlow) {
    if (step === "create") return "macwhere";
    if (step === "cmd" || step === "here") return "create";
  }
  // The scan step reached through "I already have a name" goes back to that choice, not to the name field.
  if (step === "scan" && ctx.have) return "have";
  return BACK[step] ?? null;
}

// After the space has its home (the server is paired, or "On this computer" was chosen) setup carries on by itself on the device it started on:
// look, members, connectors, the first Kit, then done (DESIGN-spaces-first.md, "The order, and where setup happens"). Nothing here asks the server anything.
export const SETUP_STEPS = ["look", "members", "ai", "connectors", "kit"];
/** The step the flow moves to the moment the space has its home. */
export const AFTER_HOME = "look";
/** The step after this one, inside setup. */
/** A space made for one person has nobody to invite, so its setup leaves out the members step. */
export const nextSetup = (/** @type {string} */ step, /** @type {string} */ who = "team") => {
  const l = who === "personal" ? SETUP_STEPS.filter((s) => s !== "members") : SETUP_STEPS;
  return l[l.indexOf(step) + 1] ?? "done";
};

/** Steps worth coming back to: a closed app reopens on one of these. Everything before "where" is quick and starts again. */
const RESUMABLE = ["where", "cmd", "here", ...SETUP_STEPS];
export const isResumable = (/** @type {string} */ step) => RESUMABLE.includes(step);

/** What is kept so a closed app resumes: the step and what the person entered. No secret, no code, no key. */
export function packProgress(/** @type {{ step: string, name: string, spaceName: string, addr: string | null, look: string, where: string, pairTo: string, device: string, who?: string, picks?: { members?: string[], connectors?: string[], kit?: string | null } }} */ s) {
  return JSON.stringify({ v: 1, step: s.step, name: s.name, spaceName: s.spaceName, addr: s.addr, look: s.look, where: s.where, pairTo: s.pairTo, device: s.device, who: s.who ?? "team", picks: s.picks ?? {} });
}
/** Reads it back; anything unreadable or from another version is nothing. */
export function unpackProgress(/** @type {string | null | undefined} */ raw) {
  try {
    const j = JSON.parse(String(raw ?? ""));
    if (j && j.v === 1 && isResumable(j.step) && typeof j.spaceName === "string") return j;
  } catch {}
  return null;
}

/** What another of the person's devices says while setup is unfinished elsewhere. */
export const setupElsewhere = (/** @type {string} */ device) => (/^this (computer|device)$/i.test(device.trim()) ? `Setup in progress on ${device.trim().toLowerCase()}` : `Setup in progress on your ${device}`);
export const CONTINUE_HERE = "Continue here";
/** The line a server prints once it is paired: it asks nothing more. */
export const connectedLine = (/** @type {string} */ space, /** @type {string} */ device) => `Connected to ${space}. Finish setting up on your ${device}.`;

/** The first step for a route: /u/install, /u/install/create, /u/install/join. */
export function startStep(/** @type {string|undefined} */ start) {
  // "phone" is the Mac's Add your phone, and "connect" is a phone or browser scanning a code from its Vyre: the actions of the empty states (first-run.js GAP).
  return start === "server" ? "mycloud" : start === "create" ? "create" : start === "join" ? "join" : start === "phone" ? "addphone" : start === "connect" ? "scan" : "name";
}

/** Where "Where will it live?" sends each choice. */
export const WHERE_STEP = { server: "cmd", here: "here" };

/** The line shown under a made space. */
export function homeLine(/** @type {"server"|"here"} */ where) {
  if (where === "here") return "Lives on this computer. Unreachable while it sleeps.";
  return "Lives on your server.";
}

/** What the person reads when the server step does not finish. Both sides say the same thing; nothing is created and nothing is listed. */
export const SERVER_FAILED = {
  rejected: "Nothing was paired. The three words were not the same. Run the install line on your server again to get a new code.",
  ended: "The pairing ended before it was confirmed, so nothing was paired. Run the install line on your server again to get a new code.",
  used: "That code was already used. Run the install line on your server again to get a new one.",
  expired: "The pairing ran out of time, so nothing was paired. Run the install line on your server again to get a new code.",
  unreachable: "Your phone cannot reach the server right now. Check that it is on and online, then try again. Nothing was paired.",
  unchecked: "Vyre could not check who this is right now. Nothing was paired. Try again in a minute.",
  notThem: "That device is not the one you expected, so nothing was paired. If you did not start this, nobody was given access.",
  directory: "Vyre cannot reach the names directory right now, so it cannot check this device. Nothing was paired. Try again in a minute.",
  badCode: "That is not a code this server gave. Run the install line on your server again and use the new code.",
  badOwner: "This server belongs to another Vyre name, so it cannot be paired to you. Nothing was paired.",
  busy: "The server is in the middle of another pairing. Wait a minute, then try again.",
  cancelled: "The pairing was cancelled. Nothing was paired.",
  denied: "The server refused this pairing. Nothing was paired.",
  noProof: "This phone did not prove which Vyre name it is, so the server refused. Nothing was paired. Try again.",
  wrongProof: "The server could not match this phone's key to your Vyre name, so it refused. Nothing was paired.",
  cannotCheck: "The server could not check which Vyre name this is right now. Nothing was paired. Try again in a moment.",
  notHardware: "This server takes its owner only from a phone's own key. Pair this server from Vyre on your phone. Nothing was paired.",
  noSession: "Paired, but this phone has no sign-in with the server yet. Try again.",
  abandoned: "The last pairing was not finished, so nothing was paired. Scan or paste the server's code again.",
  /** The server's own terminal says this on its side when the pairing fails. */
  serverLine: "Pairing failed. Nothing was set up. Run the install line again.",
};

// A sentence a phone already says (first-run.js PHONE_SAY) passes through again unchanged.
/** The Vyre name in "This server belongs to <name>..." (a plain name or name.vyre.run), as name.vyre.run, or null. @param {string} text */
export function ownedBy(text) {
  const m = /^This server belongs to ([a-z0-9][a-z0-9-]{0,40})(?:\.vyre\.run\b|(?=\.(?:\s|$)))/i.exec(String(text ?? "").trim());
  return m ? `${m[1].toLowerCase()}.vyre.run` : null;
}

const KNOWN = new Set([...Object.values(SERVER_FAILED), ...Object.values(PHONE_SAY), ...Object.values(WEB_SAY)]);
/** An error from the pairing, in words for the person: a used code, a pairing that ran out of time, a server out of reach, or what the box said. @param {any} e */
export function serverSay(e) {
  // wink-2's codes (relay/client/serverpair.js) decide. The words of a server the person does not own yet are never shown: only our own sentences.
  const c = String(e?.code ?? "");
  // A plain string is a sentence that already went through here (the screens pass the mapped words back): it counts as the message.
  const m0 = String(e?.message ?? (typeof e === "string" ? e : "")).trim();
  // A server that already has an owner says whose it is. That one sentence is shown (with the name cut out of it and checked, never the server's own text): the person needs it to know what to do.
  const owner = ownedBy(m0);
  if (owner) return `This server belongs to ${owner}. Ask them to add you to a space, or reset the server to start over.`;
  // The code says it even when the words carry no name: a server that is someone else's is never reported as a pairing that merely "did not finish".
  if (c === "owned_by_other") return "This server belongs to someone else. Ask them to add you to a space, or reset the server to start over.";
  if (c === "bad_code") return SERVER_FAILED.badCode;
  if (c === "bad_owner") return SERVER_FAILED.badOwner;
  if (c === "taken") return SERVER_FAILED.used;
  if (c === "busy") return SERVER_FAILED.busy;
  if (c === "denied_no_proof") return SERVER_FAILED.noProof;
  if (c === "denied_wrong_proof") return SERVER_FAILED.wrongProof;
  if (c === "denied") return SERVER_FAILED.denied;
  if (c === "expired") return SERVER_FAILED.expired;
  if (c === "unreachable") return SERVER_FAILED.unreachable;
  if (c === "cancelled") return SERVER_FAILED.cancelled;
  if (c === "cannot_check") return SERVER_FAILED.cannotCheck;
  if (c === "no_session") return SERVER_FAILED.noSession;
  if (c === "not_hardware") return SERVER_FAILED.notHardware;
  // A server the person does not own yet is untrusted: its words are never shown. A code this app does not know is a refusal, in our own sentence.
  if (c) return SERVER_FAILED.denied;
  if (KNOWN.has(m0)) return m0;
  // No code: only a short reason from the person's own box is matched, and only to our sentences; a long text from anywhere else is not read at all.
  if (m0.length > 80) return SERVER_FAILED.ended;
  const t = `${e?.code ?? ""} ${e?.message ?? e ?? ""}`.toLowerCase();
  if (/not them|not the same person|not who|identity.*(mismatch|differ)/.test(t)) return SERVER_FAILED.notThem;
  if (/directory/.test(t)) return SERVER_FAILED.directory;
  if (/could not be checked|cannot be checked|could not check|identity.*(check|verif)/.test(t)) return SERVER_FAILED.unchecked;
  if (/used|consumed|spent|already/.test(t)) return SERVER_FAILED.used;
  if (/expired|ran out|timeout|timed out/.test(t)) return SERVER_FAILED.expired;
  if (/offline|unreach|network|econn|no path|failed to fetch/.test(t)) return SERVER_FAILED.unreachable;
  if (/rejected/.test(t)) return SERVER_FAILED.rejected;
  return SERVER_FAILED.ended;
}
