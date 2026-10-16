// @ts-check
// The invite page's one decision: where an invite link at vyre.run/i/<token> goes. The token goes to web.vyre.run and nowhere else, and in the URL fragment, which a browser never sends to a server: it
// stays out of every request line and log after the hop from this page. (The first request to this page carries the path the owner shared, as any link does.) No query string ever carries it.
export const WEB_APP = "https://web.vyre.run";

/** The token in an invite path, or null for anything else. @param {string} pathname */
export function tokenOf(pathname) {
  const m = /^\/i\/([A-Za-z0-9._-]{8,400})\/?$/.exec(String(pathname || ""));
  return m ? m[1] : null;
}

/** Where to send an invite: the app's join route, with the invite link in the fragment. Null when the path holds no token. @param {string} pathname */
export function inviteTarget(pathname) {
  const t = tokenOf(pathname);
  return t ? `${WEB_APP}/join#link=${encodeURIComponent(`https://vyre.run/i/${t}`)}` : null;
}

export const WORDS = Object.freeze({
  incomplete: "That invite link is not complete. Ask whoever invited you to send it again.",
  heading: "Opening your invite",
  retry: "Not opening? Try again",
});
