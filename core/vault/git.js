// @ts-check
// git: the git credential helper protocol (git-credential(1)) and which login answers it.
//
// git sends `key=value` lines and a blank line; the helper answers the same way. Matching is by
// exact origin (scheme, host and port), and by path too when git sends one (credential.useHttpPath),
// because a looser match would hand one site's password to a look-alike host. When more than one
// login fits and the username does not settle it, the helper answers nothing: git then asks the
// person, which is better than guessing which password to send.

const MULTI = new Set(["capability[]", "wwwauth[]", "state[]"]);

/**
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseRequest(text) {
  /** @type {Record<string, any>} */
  const req = {};
  for (const line of String(text).split("\n")) {
    const l = line.replace(/\r$/, "");
    if (!l) break;
    const eq = l.indexOf("=");
    if (eq < 1) continue;
    const k = l.slice(0, eq), v = l.slice(eq + 1);
    if (MULTI.has(k)) (req[k] = req[k] || []).push(v);
    else req[k] = v;
  }
  // `url=` stands for the parts it contains (git-credential(1), "url").
  if (req.url) {
    try {
      const u = new URL(req.url);
      req.protocol = req.protocol || u.protocol.replace(/:$/, "");
      req.host = req.host || u.host;
      if (!req.path && u.pathname && u.pathname !== "/") req.path = u.pathname.replace(/^\//, "");
      if (!req.username && u.username) req.username = decodeURIComponent(u.username);
    } catch { /* an unparseable url matches nothing */ }
  }
  return req;
}

/** The request's origin (`https://host[:port]`), or null for anything but http(s). */
export function requestOrigin(req) {
  if (!req || !["http", "https"].includes(req.protocol) || !req.host) return null;
  try { return new URL(`${req.protocol}://${req.host}`).origin; } catch { return null; }
}

const trimPath = p => String(p || "").replace(/^\/+|\/+$/g, "");

/**
 * Logins whose origin is exactly the request's, and whose path is the request's when git sent one.
 * @param {{ name: string, url?: string|null, hosts?: string[] }[]} logins
 * @param {Record<string, any>} req
 */
export function candidates(logins, req) {
  const o = requestOrigin(req);
  if (!o) return [];
  const want = trimPath(req.path);
  return logins.filter(l => {
    let u = null;
    try { u = l.url ? new URL(l.url) : null; } catch { u = null; }
    if (want) return Boolean(u && u.origin === o && trimPath(u.pathname) === want);
    return (l.hosts || []).includes(o) || Boolean(u && u.origin === o);
  });
}

/** `key=value` lines, refusing a value that would break the protocol. */
export function formatResponse(obj) {
  let s = "";
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (/[\n\0]/.test(String(v))) throw new Error(`${k} holds a newline, which git's credential protocol cannot carry`);
    s += `${k}=${v}\n`;
  }
  return s;
}
