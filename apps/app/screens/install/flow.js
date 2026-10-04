// @ts-check
// The install flow's rules, pure so Node tests them: names, the step graph, the server's scan-or-paste code and the three-word confirm.
// Steps (prototype p3Inst): name > recovery > spaces; or name > scan > scanwords > spaces. spaces > create > where > (cmd | vps | here) > ... > done.
// spaces > join > invite > joined.

export const NAMES_TAKEN = ["alex", "chris", "harlow", "vyre", "admin"];
export const MIN_NAME = 3;
export const RECOVERY_CODE = "R7K4-Q2MX-9HDP-W3NB";
/** What the server prints: a long code (also drawn as a QR). The app reads it by scan or paste; there is no short code to type. */
export const SERVER_LONG_CODE = "vyre://wink/2?t=SGVsbG9TYW1wbGVTZWNyZQ&r=wss%3A%2F%2Frelay.example";

/** "Harlow Legal" > "harlow-legal". The slug is what goes before .vyre.run. */
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
  name: null, scan: "name", scanwords: "scan", recovery: null, spaces: null, create: "spaces", where: "create", cmd: "where", vps: "where", vpsbusy: null,
  srv1: "cmd", srv2: "cmd", here: "where", look: null, members: "look", connectors: "members", kit: "connectors", done: null, join: "spaces", invite: "join", joined: null,
};

/** Where Back goes from a step. The code step goes back to the server's own first screen (the line or the new server); the words go back to the code. */
export function backOf(/** @type {string} */ step, /** @type {{ vps?: boolean }} */ ctx = {}) {
  if (step === "srv2") return "srv1";
  if (step === "srv1") return ctx.vps ? "vps" : "cmd";
  return BACK[step] ?? null;
}

// After the space has its home (the server is paired, or "On this computer" was chosen) setup carries on by itself on the device it started on:
// look, members, connectors, the first Kit, then done (DESIGN-spaces-first.md, "The order, and where setup happens"). Nothing here asks the server anything.
export const SETUP_STEPS = ["look", "members", "ai", "connectors", "kit"];
/** The step the flow moves to the moment the space has its home. */
export const AFTER_HOME = "look";
/** The step after this one, inside setup. */
export const nextSetup = (/** @type {string} */ step) => SETUP_STEPS[SETUP_STEPS.indexOf(step) + 1] ?? "done";

/** Steps worth coming back to: a closed app reopens on one of these. Everything before "where" is quick and starts again. */
const RESUMABLE = ["where", "cmd", "srv1", "here", ...SETUP_STEPS];
export const isResumable = (/** @type {string} */ step) => RESUMABLE.includes(step);
/** srv2 shows the words of a pairing that does not survive a restart, so it resumes at the code. */
export const resumeStep = (/** @type {string} */ step) => (step === "srv2" ? "srv1" : step);

/** What is kept so a closed app resumes: the step and what the person entered. No secret, no code, no key. */
export function packProgress(/** @type {{ step: string, name: string, spaceName: string, addr: string | null, look: string, where: string, pairTo: string, device: string, picks?: { members?: string[], connectors?: string[], kit?: string | null } }} */ s) {
  return JSON.stringify({ v: 1, step: resumeStep(s.step), name: s.name, spaceName: s.spaceName, addr: s.addr, look: s.look, where: s.where, pairTo: s.pairTo, device: s.device, picks: s.picks ?? {} });
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
  return start === "create" ? "create" : start === "join" ? "join" : "name";
}

/** Where "Where will it live?" sends each choice. */
export const WHERE_STEP = { server: "cmd", vps: "vps", here: "here" };

/** The "Pair to:" choices: the person's own name, or the space being made (DESIGN-wink.md section 4). */
export function pairToOptions(/** @type {string} */ person, /** @type {string} */ spaceAddress) {
  return /** @type {[string, string][]} */ ([["me", `${person || "alex"}.vyre.run`], ["space", spaceAddress]]);
}

/** The line shown under a made space. */
export function homeLine(/** @type {"server"|"vps"|"here"} */ where) {
  if (where === "here") return "Lives on this computer. Unreachable while it sleeps.";
  if (where === "vps") return "Lives on northwind, a new server.";
  return "Lives on your server.";
}

/**
 * The lines a server prints. The code screen adds the QR note and the long code; the words screen adds who is asking, the three words and the wait for yes.
 * @param {boolean} vps @param {string} spaceName @param {"code"|"words"} stage @param {{ code?: string, to?: string, who?: string, words?: string }} [o]
 */
export function serverLines(vps, spaceName, stage, o = {}) {
  const base = [vps ? "Created northwind on DigitalOcean" : "$ curl -fsSL vyre.run/i | sh", "Installing Vyre ... done", `Setting up ${spaceName} ... done`];
  const code = [...base, "", "Scan the QR above with your phone, or paste this long code into Vyre:", o.code ?? SERVER_LONG_CODE];
  if (stage === "code") return code;
  return [...code, "", `${o.who ?? "A phone"} is asking to pair this server to ${o.to ?? "you"}.`, `The words are: ${o.words ?? ""}`, "Waiting for yes."];
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
  noSession: "Paired, but this phone has no sign-in with the server yet. Try again.",
  abandoned: "The last pairing was not finished, so nothing was paired. Scan or paste the server's code again.",
  /** The server's own terminal says this on its side when the pairing fails. */
  serverLine: "Pairing failed. Nothing was set up. Run the install line again.",
};

const KNOWN = new Set(Object.values(SERVER_FAILED));
/** An error from the pairing, in words for the person: a used code, a pairing that ran out of time, a server out of reach, or what the box said. @param {any} e */
export function serverSay(e) {
  // wink-2's codes (relay/client/serverpair.js) decide. The words of a server the person does not own yet are never shown: only our own sentences.
  const c = String(e?.code ?? "");
  const m0 = String(e?.message ?? "").trim();
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
