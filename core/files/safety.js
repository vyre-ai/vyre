// @ts-check
// safety: the one gate every path in and out of the files module passes through.
//
// The files tools let Claude, a phone or the other machine look at files, so the question they
// must never get wrong is "may this path be seen at all". Every answer comes from resolveSafe:
// a path the user asks for, a path Spotlight or ripgrep hands back, and a path the folder walk
// finds. Nothing is returned or served that this file has not passed.
//
// The rules, in order:
//   1. The path is absolute, has no NUL byte and no ".." segment. Relative paths are refused
//      outright rather than guessed against a root, so there is never a question of which root.
//   2. Written as given, it sits inside one of the roots. This is checked before following
//      symlinks, so a link outside the roots that points in cannot be used to probe for files.
//   3. Followed through every symlink (realpath), it still sits inside that root's real path.
//      So a symlink inside a root that points somewhere else is refused.
//   4. At both steps: nothing inside a denied place (Vyre's own home and vault, ~/.ssh and the
//      other credential folders), no dot-named segment below the root except a short list of
//      harmless ones, never anything named .env, and no name that looks like a key or a secret.
// A refusal says only "not available", whatever the reason, so the error never tells a caller
// whether something exists outside the roots.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRIVATE_KEY_HEAD } from "../../lib/credential-shapes.js";

export const NOT_AVAILABLE = "not available";

/** Dot-names that are ordinary project files, safe to show. Config allowDot adds to these. */
const DOT_OK = new Set([".github", ".gitignore", ".gitattributes", ".editorconfig", ".vscode", ".prettierrc",
  ".nvmrc", ".node-version", ".dockerignore", ".well-known"]);

/** Names that hold keys, passwords or tokens. Matched against every segment, case-insensitively. */
const SECRET = [/^id_rsa/i, /^id_ed25519/i, /^id_ecdsa/i, /\.p12$/i, /\.pfx$/i, /\.kdbx$/i,
  /\.keychain/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.git-credentials$/i, /^credentials\.json$/i, /^service-account.*\.json$/i,
  // A browser's saved sessions and passwords (Chrome and its kin), and any folder called secrets.
  // Kept in step with glass's guard, so the two never disagree about what is a secret.
  /^Cookies(-journal)?$/, /^Login Data(-journal| For Account)?$/, /^Web Data(-journal)?$/, /^secrets$/i];

/**
 * Names refused only for a regular file. A Keynote document is a folder named *.key, and must stay
 * reachable; a file named *.key or *.pem is a key more often than not.
 */
const SECRET_FILE = [/\.pem$/i, /\.key$/i];

/** A private key, whatever the file is called: PEM, OpenSSH and PuTTY all say so in their first line. */
const KEY_HEAD = PRIVATE_KEY_HEAD;

/** Does this regular file look like a key, by its name or by its first bytes? */
export function looksLikeKey(file, names = [path.basename(file)]) {
  let fd;
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (names.some(n => SECRET_FILE.some(r => r.test(n)))) return true;
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    return KEY_HEAD.test(buf.subarray(0, n).toString("latin1"));
  } catch { return true; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Why a path is refused. Its message is always the same, on purpose. */
export class Refused extends Error {
  constructor() { super(NOT_AVAILABLE); this.code = "not_available"; }
}

/** Resolve a leading ~ against the home directory. */
export const untilde = (p, home = os.homedir()) => String(p).replace(/^~(?=$|\/)/, home);

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

function real(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

/** Does one path segment name a secret: a .env file, a key, a password store, a secrets folder? */
export const secretName = seg => /^\.env/i.test(seg) || SECRET.some(r => r.test(seg));

/** The credential places under a home folder, relative to it. The guard denies them in the real home. */
export const HOME_DENIED = [".vyre", ".claude", ".ssh", ".gnupg", ".aws", path.join(".config", "gcloud"), ".docker",
  ".kube", ".netrc", path.join("Library", "Keychains")];

/** Is one path segment acceptable below a root? */
export function nameAllowed(seg, allowDot = new Set()) {
  // .env files hold keys more often than not, so no config can allow them.
  if (secretName(seg)) return false;
  if (seg.startsWith(".")) return DOT_OK.has(seg) || /^\.eslintrc/.test(seg) || allowDot.has(seg);
  return true;
}

/**
 * Build the guard for one machine.
 * @param {{ roots: string[], allowDot?: string[], vyreHome: string, vault?: string, home?: string }} opts
 */
export function guard(opts) {
  const home = opts.home || os.homedir();
  const allowDot = new Set((opts.allowDot || []).map(String));
  const deniedGiven = [opts.vyreHome, opts.vault, ...HOME_DENIED.map(d => path.join(home, d)), "/Library/Keychains",
    "/System/Library/Keychains"].filter(Boolean).map(p => path.resolve(String(p)));
  // Both spellings of each denied place: as written and with symlinks followed. On macOS the
  // temp folder and some homes sit behind a symlink, and either spelling can arrive here.
  const denied = [...new Set([...deniedGiven, ...deniedGiven.map(real).filter(Boolean)])];
  const isDenied = p => denied.some(d => inside(p, d)) || /\/Library\/Keychains(\/|$)/i.test(p);

  const configured = opts.roots.map(r => path.resolve(untilde(r, home)));

  /** The roots that exist right now, and those that do not. Checked per call: folders come and go. */
  function roots() {
    const live = [], missing = [];
    for (const given of configured) {
      const r = real(given);
      if (r && fs.statSync(r).isDirectory()) live.push({ given, real: r }); else missing.push(given);
    }
    return { live, missing };
  }

  /** Every segment of p below dir passes the name rules. */
  const namesOk = (p, dir) => path.relative(dir, p).split(path.sep).filter(Boolean).every(s => nameAllowed(s, allowDot));

  /**
   * Check a path and return its real location. Throws Refused for anything not allowed and for
   * anything that does not exist, so the two cannot be told apart.
   * @param {unknown} p
   * @param {{ live: { given: string, real: string }[] }} [rs] the roots, when checking many paths at once
   */
  function resolveSafe(p, rs = roots()) {
    if (typeof p !== "string" || !p) throw new Error("path is required");
    if (p.includes("\0")) throw new Refused();
    if (!path.isAbsolute(p)) throw new Error("path must be absolute");
    if (p.split(/[\\/]+/).includes("..")) throw new Refused();
    const lexical = path.resolve(p);
    if (isDenied(lexical)) throw new Refused();
    // Step 2, before any symlink is followed: which root holds the path as written.
    const root = rs.live.find(r => inside(lexical, r.given) || inside(lexical, r.real));
    if (!root) throw new Refused();
    if (!namesOk(lexical, inside(lexical, root.given) ? root.given : root.real)) throw new Refused();
    // Step 3: the real location must still be inside that same root, and pass the same rules.
    const r = real(lexical);
    if (!r || !inside(r, root.real) || isDenied(r) || !namesOk(r, root.real)) throw new Refused();
    // Step 4: a regular file that is a key, by name or by content, is never served.
    if (looksLikeKey(r, [path.basename(lexical), path.basename(r)])) throw new Refused();
    return { path: lexical, real: r, root };
  }

  /** The same check as a yes or no, for filtering search results. */
  function allowed(p, rs = roots()) {
    try { resolveSafe(p, rs); return true; } catch { return false; }
  }

  /** Should a folder walk go into this directory? Denied places and dot folders are skipped. */
  const walkable = (dir, name) => name !== "node_modules" && name !== ".git" && nameAllowed(name, allowDot) && !isDenied(dir);

  return { roots, resolveSafe, allowed, walkable, isDenied, nameAllowed: seg => nameAllowed(seg, allowDot) };
}
