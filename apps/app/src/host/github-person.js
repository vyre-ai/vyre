// @ts-check
// The name and photo Continue with GitHub already brought back (relay/worker/github.js keeps name and avatarUrl). The page host stores them beside the username. No I/O.

/** The relay keeps a GitHub avatar only from this host. The same rule as relay/worker/github.js. */
const AVATAR_RE = /^https:\/\/avatars\.githubusercontent\.com\/[A-Za-z0-9/_.?=&%-]{1,200}$/;

/** One line, a letter, up to 60 characters. The host's own display rule, copied so this file does not import the host. @param {unknown} v */
export const displayOk = (v) => { const t = typeof v === "string" ? v.trim() : ""; return t && t.length <= 60 && /\p{L}/u.test(t) && !/[\u0000-\u001f]/.test(t) ? t : ""; };

/** An https address a person may keep as a photo: no userinfo, a hostname with a dot, at most 300 characters. @param {unknown} v */
export function photoOk(v) {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t || t.length > 300) return "";
  let url;
  try { url = new URL(t); } catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  if (!url.hostname.includes(".")) return "";
  return t;
}

/** Name and photo from a GitHub user the relay already checked. A photo is kept only when it is a GitHub avatar address. @param {any} user @returns {{ display?: string, photo?: string }} */
export function personFromGithub(user) {
  const display = displayOk(user && (user.displayName || user.name));
  const raw = user && typeof (user.avatarUrl || user.avatar_url) === "string" ? String(user.avatarUrl || user.avatar_url) : "";
  const photo = raw && AVATAR_RE.test(raw) && photoOk(raw) ? raw : "";
  return { ...(display ? { display } : {}), ...(photo ? { photo } : {}) };
}
