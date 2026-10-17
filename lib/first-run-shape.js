// @ts-check
// The first-run shapes the app and the onboard tools share: a username, an invite link, the one install command, and the words on the join path.
// No I/O. The tools in core/onboard/first-run.js are the one definition the app and the MCP server call.

/** A public username: the person page is vyre.run/u/<name>. @param {unknown} raw */
export function usernameOf(raw) {
  const name = String(raw ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9-]{2,19}$/.test(name) ? name : "";
}

/** The public person route, and the old host kept as a redirect. @param {string} name */
export function personRoutes(name) {
  return { route: `https://vyre.run/u/${name}`, legacy: `https://${name}.vyre.run` };
}

const COMMON = ["password", "12345678", "qwertyui", "letmein", "iloveyou", "vyre"];

/**
 * A master password the tool will accept. The screen asks for Good or better (passwordStrength); this is the floor so a short or common one never creates a vault.
 * @param {unknown} raw
 */
export function passwordOk(raw) {
  const s = String(raw ?? "");
  if (s.length < 12 || s.length > 200) return false;
  if (COMMON.some((c) => s.toLowerCase().includes(c)) && s.length < 16) return false;
  return true;
}

/** @param {unknown} raw @returns {{ token: string, link: string, legacy: boolean, spaceHost: string | null } | null} */
export function parseInvite(raw) {
  const text = String(raw ?? "").trim();
  if (!text || text.length > 2000) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const pub = host === "vyre.run" ? /^\/i\/([^/]+)$/.exec(url.pathname) : null;
  if (pub && pub[1]) {
    const token = safeToken(pub[1]);
    return token ? { token, link: `https://vyre.run/i/${token}`, legacy: false, spaceHost: null } : null;
  }
  const leg = host.endsWith(".vyre.run") && host !== "vyre.run" ? /^\/join\/([^/]+)$/.exec(url.pathname) : null;
  if (leg && leg[1]) {
    const token = safeToken(leg[1]);
    return token ? { token, link: `${url.origin}/join/${token}`, legacy: true, spaceHost: host } : null;
  }
  return null;
}

/** @param {string} raw */
function safeToken(raw) {
  let token = raw;
  try { token = decodeURIComponent(raw); } catch { return ""; }
  return /^[A-Za-z0-9._-]{8,400}$/.test(token) ? token : "";
}

/** @param {unknown} raw @param {unknown} name */
export function spaceKey(raw, name) {
  const s = String(raw || "").trim();
  if (/^spc_[a-z0-9_]{4,64}$/.test(s)) return s;
  const n = String(name || "").toLowerCase().replace(/\.vyre\.run$/, "").replace(/[^a-z0-9-]/g, "").slice(0, 24);
  return n ? `spc_${n}` : "";
}

/** The one install line the app may show: a curl of the installer, and never a vyre subcommand. @param {unknown} command */
export function commandOk(command) {
  const s = String(command ?? "").trim();
  if (!s || s.length > 500) return false;
  if (!/^curl -fsSL \S+ \| sh$/.test(s) && !/^curl -fsSL \S+ \| [A-Za-z0-9_]+=\S+(?: [A-Za-z0-9_]+=\S+)* sh$/.test(s)) return false;
  if (/\bvyre (vault|hooks|phone|box|status|link|up|down|name|words|call)\b/.test(s)) return false;
  return true;
}

/** Days an invite may last. @param {unknown} raw */
export function inviteDays(raw) {
  const n = Number(raw);
  return n === 1 || n === 7 || n === 30 ? n : 0;
}

/** A role picked on an invite. There is no solo role. @param {unknown} raw */
export function inviteRole(raw) {
  const r = String(raw ?? "");
  return r === "admin" || r === "member" || r === "guest" ? r : "";
}

/** Where a new space runs. @param {unknown} raw */
export function placeKind(raw) {
  return raw === "mac" ? "mac" : raw === "linux" ? "linux" : "";
}

/** Words on the join path. They never name a server: the link carries the route. */
export const JOIN_COPY = Object.freeze({
  title: "Join a space",
  lead: "Paste the invite link you were sent.",
  reviewTitle: "You are invited",
  reviewLead: "Joining puts you in this space with the role on the invite.",
  accept: "Join",
  bad: "That link does not open a space. Ask for a new invite.",
});

/** @param {string} text */
export const mentionsServer = (text) => /\bservers?\b/i.test(text);

/** The three phases. Not ten steps. */
export const PHASES = Object.freeze(["Identity", "Space", "Ready"]);

/** Roles shown when making an invite link. There is no solo role. */
export const INVITE_ROLES = Object.freeze([
  { id: "admin", name: "Admin", line: "Invites people and looks after the space." },
  { id: "member", name: "Member", line: "Works in the space with everyone else." },
  { id: "guest", name: "Guest", line: "Here for a while. Access ends when the invite does." },
]);

/** Copy for the optional AI sign-in step after identity. */
export const AI_SIGNIN_COPY = Object.freeze({
  title: "Sign in to an AI",
  lead: "Optional. Link Claude, Codex or Grok so sessions can run on your account. Skip if you will add this later in Settings.",
  skip: "Skip for now",
});

/** @typedef {"id.choice"|"id.signin"|"id.signin.spaces"|"id.create"|"id.recovery"|"id.ai"|"space.choice"|"join.link"|"join.review"|"create.kind"|"create.wait"|"invite.share"|"ready"} ScreenId */

/** The phase index of a screen. @param {string} screen */
export function phaseOf(screen) {
  if (screen === "id.choice" || screen === "id.signin" || screen === "id.signin.spaces" || screen === "id.create" || screen === "id.recovery" || screen === "id.ai") return 0;
  if (screen === "ready") return 2;
  return 1;
}

/**
 * The screen a path opens on, before identity exists. After identity, afterIdentity decides.
 * @param {string | undefined} path
 * @returns {ScreenId}
 */
export function entryScreen(path) {
  if (path === "invite") return "invite.share";
  if (path === "join") return "id.create";
  if (path === "create") return "id.create";
  if (path === "signin") return "id.signin";
  return "id.choice";
}

/**
 * Where identity leads. A held invite or path=join reviews the invite. path=create picks a place. Otherwise the person chooses.
 * @param {{ path?: string, heldInvite?: string }} o
 * @returns {ScreenId}
 */
/** After recovery (or when there is no key), the optional AI sign-in. @param {{ skipAi?: boolean, path?: string }} [o] */
export function afterRecovery(o = {}) {
  return o.skipAi ? afterAi() : "id.ai";
}

/** After AI sign-in or skip, same routing as the old after-identity tail. @param {{ path?: string, heldInvite?: string }} [o] */
export function afterAi(o = {}) {
  if (o.heldInvite || o.path === "join") return o.heldInvite ? "join.review" : "join.link";
  if (o.path === "create") return "create.kind";
  if (o.path === "invite") return "invite.share";
  return "space.choice";
}

/**
 * Where identity leads once recovery is done or was skipped. Prefer afterRecovery right after the recovery screen.
 * @param {{ path?: string, heldInvite?: string }} o
 * @returns {ScreenId}
 */
export function afterIdentity(o) {
  return afterAi(o);
}

/** The words on the sign-in screens. A person signs in from any device with a space's address, their username and their master password, or with GitHub. */
export const SIGNIN_COPY = Object.freeze({
  choiceTitle: "Get started",
  choiceLead: "Make a new identity, or sign in to the one you have, from any device.",
  title: "Sign in",
  lead: "The address of a space you belong to, your username and your master password. Nothing else is needed on this device.",
  spacesTitle: "Your spaces",
  spacesLead: "GitHub found these. Type your master password once to unlock your vault on this device.",
  none: "GitHub did not find a Vyre identity. Sign in with your space address, or create an identity.",
});

/**
 * A space's address as a person types it: `juniper.vyre.run`, `https://juniper.vyre.run` or `juniper.vyre.run/`. The space name and the https address, or null.
 * @param {unknown} raw
 * @returns {{ space: string, address: string } | null}
 */
export function spaceAddressOf(raw) {
  const text = String(raw ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  const m = /^([a-z][a-z0-9-]{1,38})\.vyre\.run$/.exec(text);
  return m ? { space: m[1], address: `https://${m[1]}.vyre.run` } : null;
}
