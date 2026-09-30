// @ts-check
// lib/deeplink: the one rule for `vyre://open/...` links (PLAN.md C22, reviewer-2 H4 on the
// native-core plan). Any web page can launch a vyre:// link, so a desktop app accepts only an
// in-app route from it, never a pairing, a URL or a path trick. `vyre://pair/...` is a separate
// verb with its own parser (windows and launch); this one refuses it. Pure JavaScript with no
// imports: the reference the Windows app (Rust) and the Mac app port against
// spec/deeplink/open.json's vectors, byte for byte.
//
// The rule, exactly:
//   1. The link starts with "vyre://open/" (lower case scheme and verb). Anything else: null.
//   2. The rest is the in-app path, starting "/", with an optional "?query". No "#fragment".
//   3. Refused: over 512 characters; any encoded "/" or "\" (%2f, %5c) or encoded "%" (%25); after
//      decoding once, any "//", "\", "..", ":", control character or space.
//   4. The path is one of ROUTES, or starts with one of them followed by "/" or "?".
//   5. The answer is the decoded path (with its query), for the app to open at its own address.

export const ROUTES = Object.freeze(["/chat", "/projects", "/agents", "/settings", "/quick", "/now", "/needs", "/threads", "/a"]);
export const MAX = 512;

/**
 * The in-app path a `vyre://open/...` link names, or null when the link is anything else.
 * @param {unknown} link
 * @returns {string|null}
 */
export function parseOpen(link) {
  if (typeof link !== "string" || link.length > MAX || !link.startsWith("vyre://open/")) return null;
  const raw = link.slice("vyre://open".length);
  if (raw.includes("#") || /%(2f|5c|25)/i.test(raw)) return null;
  let path;
  try { path = decodeURIComponent(raw); } catch { return null; }
  if (path.includes("//") || path.includes("\\") || path.includes("..") || path.includes(":") || /[\u0000- \u007f]/.test(path)) return null;
  const route = ROUTES.find(r => path === r || path.startsWith(r + "/") || path.startsWith(r + "?"));
  return route ? path : null;
}
