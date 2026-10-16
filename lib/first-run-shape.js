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

/** @typedef {"id.create"|"id.recovery"|"space.choice"|"join.link"|"join.review"|"create.kind"|"create.wait"|"invite.share"|"computer.add"|"phone.add"|"ready"} ScreenId */

/** The phase index of a screen. @param {string} screen */
export function phaseOf(screen) {
  if (screen === "id.create" || screen === "id.recovery") return 0;
  if (screen === "ready") return 2;
  return 1;
}

/**
 * The screen a path opens on, before identity exists. After identity, afterIdentity decides.
 * @param {string | undefined} path
 * @returns {ScreenId}
 */
export function entryScreen(path) {
  if (path === "computer") return "computer.add";
  if (path === "phone") return "phone.add";
  if (path === "invite") return "invite.share";
  if (path === "join") return "id.create";
  if (path === "create") return "id.create";
  return "id.create";
}

/**
 * Where identity leads. A held invite or path=join reviews the invite. path=create picks a place. Otherwise the person chooses.
 * @param {{ path?: string, heldInvite?: string }} o
 * @returns {ScreenId}
 */
export function afterIdentity(o) {
  if (o.heldInvite || o.path === "join") return o.heldInvite ? "join.review" : "join.link";
  if (o.path === "create") return "create.kind";
  if (o.path === "computer") return "computer.add";
  if (o.path === "phone") return "phone.add";
  if (o.path === "invite") return "invite.share";
  return "space.choice";
}
