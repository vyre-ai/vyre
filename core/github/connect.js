// @ts-check
// connect: "Sign in with GitHub", through GitHub's own CLI (`gh`), ADR 0041 decision 2 (revised
// 1 Oct, lead ruling: Vyre never runs GitHub's device flow under the CLI's client id itself; that
// would be Vyre pretending to be GitHub CLI).
//
// A person opens a page and types a short code Vyre shows them. The real `gh auth login --web`
// runs the device flow, as itself, and prints the code and address; Vyre shows them, waits for
// `gh` to finish, then reads `gh auth token` once and files the token in the vault. Nothing here
// talks to GitHub's OAuth endpoints.
//
// Rules, and why:
// - `gh` runs in a private throwaway config folder (GH_CONFIG_DIR and HOME both point into it,
//   token stored in a file there, never the OS keychain) that is deleted the moment the sign-in
//   ends, so it never touches the person's own gh login, keychain or config, and leaves no token
//   behind on disk.
// - One `gh` process per open sign-in, killed the moment it ends (used, expired or cancelled),
//   and at most one sign-in per account name at a time. Nothing runs once the sign-in is over.
// - The token goes straight into a new vault item the module makes for itself, github-<name>, and
//   is never held anywhere else in this process once that write returns.
// - Every error is scrubbed of every value a sign-in touched. Log lines and events carry ids and
//   names only.
// Everything this file needs from vyred comes in as a function, so it can be tested alone.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scrub } from "./scrub.js";

export const API = "https://api.github.com";
/** Requested once, at sign-in: full read/write on every repo the account can reach. GitHub's
 * device flow has no narrower option; a fine-grained personal access token, pasted by hand
 * instead of signing in, is the narrower alternative offered alongside this (0.2 charter minimum
 * 9, lead ruling 30 Sep). */
export const SCOPE = "repo";
const TIMEOUT_MS = 15_000;
/** `gh` gives no expiry; GitHub's device codes last 15 minutes. */
const EXPIRES_S = 900;
const CODE_WAIT_MS = 20_000;
const MAX_ENDED = 200;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const CODE_RE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const URL_RE = /(https:\/\/github\.com\/login\/device\S*)/;

/**
 * @typedef {{ id: string, name: string, dir: string, child: any, expires: number,
 *   values: string[], timer: any, cancelled?: boolean, output: string, gh: string, pasted?: boolean }} Flow
 * @typedef {{
 *   taken: (name: string) => boolean | Promise<boolean>,
 *   blocked?: (item: string) => Promise<string | null>,
 *   save: (item: string, fields: Record<string, string>) => Promise<void>,
 *   add: (account: { name: string, login: string, avatar_url: string | null, item: string, user_id?: number | null, display_name?: string | null, email?: string | null }) => Promise<void>,
 *   emit: (type: string, payload: Record<string, unknown>) => void,
 *   log?: (message: string, fields?: Record<string, unknown>) => void,
 *   fetch?: typeof fetch, gh?: string, tmpRoot?: string, expiresMs?: number, codeWaitMs?: number,
 * }} ConnectDeps
 */

const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });

/** Where a system-installed gh lives; a hit here is trusted even if the person owns the folder (Homebrew). */
const GH_DIRS = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/bin", "/usr/local/sbin"];

/**
 * gh as an absolute path: the configured one if it is absolute, else the first executable `gh` in
 * a short list of system folders, else one in a PATH folder the person's own user cannot write to.
 * A `gh` planted in a user-writable PATH folder is never run (it would run as the person).
 * @param {string | undefined} configured @returns {string | null}
 */
export function resolveGh(configured) {
  if (configured && path.isAbsolute(configured)) return configured;
  const name = configured || "gh";
  if (name.includes("/")) return null;
  const exec = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
  const locked = dir => { try { fs.accessSync(dir, fs.constants.W_OK); return false; } catch { return true; } };
  for (const dir of GH_DIRS) if (exec(path.join(dir, name))) return path.join(dir, name);
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (dir && path.isAbsolute(dir) && locked(dir) && exec(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/** @param {ConnectDeps} deps */
export function connector(deps) {
  const log = deps.log || (() => {});
  const f = deps.fetch || globalThis.fetch;
  const expiresMs = deps.expiresMs || EXPIRES_S * 1000;
  /** @type {Map<string, Flow>} */ const flows = new Map();
  /** How each recent sign-in ended, by id, so a stale id gets a plain answer instead of "no such sign-in". */
  /** @type {Map<string, string>} */ const ended = new Map();

  const endedText = why => ({
    used: "That sign-in was already used. Start a new one in Vyre.",
    expired: "That code expired. Start a new one in Vyre.",
    cancelled: "That sign-in was cancelled. Start a new one in Vyre.",
    declined: "That sign-in was declined, so nothing was connected. Start a new one in Vyre.",
  })[why] || "That sign-in has ended. Start a new one in Vyre.";

  /** The private environment `gh` runs in: nothing of the person's own, nothing of ours. */
  const envFor = dir => ({
    PATH: process.env.PATH || "", HOME: dir, GH_CONFIG_DIR: path.join(dir, "cfg"),
    GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1", NO_COLOR: "1", BROWSER: "true",
  });

  /** Run `gh` to completion and return its output (used for `auth token`). */
  function runGh(dir, args, gh) {
    return new Promise((resolve, reject) => {
      let out = "", err = "";
      const c = spawn(gh, args, { env: envFor(dir), stdio: ["ignore", "pipe", "pipe"] });
      const to = setTimeout(() => c.kill("SIGKILL"), TIMEOUT_MS);
      c.stdout.on("data", d => { out += d; });
      c.stderr.on("data", d => { err += d; });
      c.on("error", e => { clearTimeout(to); reject(e); });
      c.on("close", code => { clearTimeout(to); code === 0 ? resolve(out) : reject(fail(`gh ${args[0]} ${args[1]} failed: ${err.trim().slice(0, 200)}`, "refused")); });
    });
  }

  function end(flow, why) {
    clearTimeout(flow.timer);
    flows.delete(flow.id);
    ended.set(flow.id, why);
    while (ended.size > MAX_ENDED) ended.delete(ended.keys().next().value);
    try { flow.child && flow.child.kill("SIGTERM"); } catch {}
    try { if (flow.dir) fs.rmSync(flow.dir, { recursive: true, force: true }); } catch {}
  }

  function failed(flow, error) {
    const clean = scrub(error, flow.values);
    deps.emit("github.connect-failed", { id: flow.id, error: clean });
    log("github sign-in failed", { id: flow.id, name: flow.name });
    return { ok: false, error: clean };
  }

  /** Run and scrub: every error leaves with no value any open sign-in holds. */
  const guarded = fn => async (...args) => {
    try { return await fn(...args); } catch (e) {
      const err = /** @type {any} */ (e);
      const values = [...flows.values()].flatMap(x => x.values);
      throw Object.assign(new Error(scrub(String(err?.message || err), values)), { code: typeof err?.code === "string" ? err.code : "failed" });
    }
  };

  /** `gh` finished: a clean exit means the person approved, so read the token it holds. */
  async function finished(flow, code) {
    if (flows.get(flow.id) !== flow || flow.cancelled) return;
    if (code !== 0) {
      const tail = flow.output.trim().split("\n").pop() || "";
      const expired = /expired|timed out/i.test(flow.output);
      const declined = /denied|declined|cancel/i.test(flow.output);
      end(flow, expired ? "expired" : declined ? "declined" : "failed");
      failed(flow, expired ? "The code expired. Start a new one in Vyre."
        : declined ? "The sign-in was declined, so nothing was connected."
        : `GitHub CLI did not finish the sign-in: ${tail.slice(0, 120)}`);
      return;
    }
    let token;
    try { token = (await runGh(flow.dir, ["auth", "token", "--hostname", "github.com"], flow.gh)).trim(); }
    catch (e) { end(flow, "failed"); failed(flow, String(/** @type {any} */ (e)?.message || e)); return; }
    if (!token) { end(flow, "failed"); failed(flow, "GitHub CLI sent no token. Start a new one in Vyre."); return; }
    flow.values.push(token);
    try { await complete(flow, token); }
    catch (e) { end(flow, "failed"); failed(flow, String(/** @type {any} */ (e)?.message || e)); }
  }

  /** A token came back: who is it, save it, add the account. */
  async function complete(flow, token) {
    let res, json;
    try {
      res = await f(`${API}/user`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      json = await res.json().catch(() => null);
    } catch (e) {
      throw fail(`Could not read the GitHub account that signed in: ${/** @type {any} */ (e)?.message || e}`, "network");
    }
    if (res.status === 401) throw fail(flow.pasted ? "GitHub did not accept that token. Check it was copied whole, has not expired, and was made for this account." : "GitHub did not accept the sign-in.", "refused");
    if (!res.ok || !json || !LOGIN.test(String(json.login || ""))) throw fail("GitHub did not say which account signed in.", "refused");
    const login = String(json.login);
    const avatar_url = typeof json.avatar_url === "string" ? json.avatar_url : null;
    if (await deps.taken(flow.name)) throw fail(`An account named ${flow.name} was added while you signed in; start again with another name.`, "exists");
    const item = `github-${flow.name}`;
    const why = deps.blocked ? await deps.blocked(item) : null;
    if (why) throw fail(why, "exists");
    await deps.save(item, { token });
    const user_id = Number.isInteger(json.id) && json.id > 0 ? json.id : null;
    const display_name = typeof json.name === "string" && json.name.trim() ? json.name.trim().slice(0, 100) : null;
    const email = typeof json.email === "string" && /^[^\s@<>]+@[^\s@<>]+$/.test(json.email) ? json.email : null;
    await deps.add({ name: flow.name, login, avatar_url, item, user_id, display_name, email });
    /** @type {any} */ (flow).login = login;
    end(flow, "used");
    deps.emit("github.connected", { id: flow.id, name: flow.name, login });
    log("github sign-in connected", { id: flow.id, name: flow.name, login });
  }

  return {
    /**
     * Start a sign-in: returns the code and address for the person to open.
     * @param {{ name: string }} input
     */
    start: guarded(async ({ name }) => {
      if (!NAME.test(String(name || ""))) throw fail("name must be lowercase letters, digits and dashes, starting with a letter, at most 32");
      if (await deps.taken(name)) throw fail(`an account named ${name} is already connected; remove it first or choose another name`, "exists");
      if ([...flows.values()].some(x => x.name === name)) throw fail(`a sign-in for ${name} is already open; finish or cancel it first`, "exists");
      const gh = resolveGh(deps.gh);
      if (!gh) throw fail("Sign-in needs the GitHub CLI (gh), which is not installed here. Install it, or add a fine-grained token instead.", "gh_missing");
      const dir = fs.mkdtempSync(path.join(deps.tmpRoot || os.tmpdir(), "vyre-gh-"));
      const id = `gh_${crypto.randomBytes(9).toString("base64url")}`;
      const drop = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
      let child;
      try {
        child = spawn(gh, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web",
          "--scopes", SCOPE, "--skip-ssh-key", "--insecure-storage"], { env: envFor(dir), stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) { drop(); throw fail(`GitHub CLI could not be started: ${/** @type {any} */ (e)?.message || e}`, "gh_missing"); }
      const flow = /** @type {Flow} */ ({ id, name, dir, child, expires: Date.now() + expiresMs, values: [], timer: null, output: "", gh });
      // Wait for the code (or the CLI giving up) before answering.
      const shown = await new Promise((resolve, reject) => {
        const wait = setTimeout(() => reject(fail("GitHub CLI did not show a sign-in code in time.", "refused")), deps.codeWaitMs || CODE_WAIT_MS);
        const onData = d => {
          flow.output += String(d);
          const code = CODE_RE.exec(flow.output), url = URL_RE.exec(flow.output);
          if (code && url) { clearTimeout(wait); resolve({ user_code: code[1].toUpperCase(), verification_uri: url[1] }); }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", e => { clearTimeout(wait); reject(/** @type {any} */ (e)?.code === "ENOENT"
          ? fail("Sign-in needs the GitHub CLI (gh), which is not installed here. Install it, or add a fine-grained token instead.", "gh_missing")
          : fail(`GitHub CLI could not be started: ${/** @type {any} */ (e)?.message || e}`, "gh_missing")); });
        child.on("close", code => { clearTimeout(wait); reject(fail(`GitHub CLI stopped before showing a code (exit ${code}).`, "refused")); });
      }).catch(e => { try { child.kill("SIGTERM"); } catch {} drop(); throw e; });
      child.removeAllListeners("close");
      child.on("close", code => { finished(flow, code).catch(() => {}); });
      child.on("error", () => { if (flows.get(flow.id) === flow) { end(flow, "failed"); failed(flow, "GitHub CLI stopped unexpectedly."); } });
      flows.set(flow.id, flow);
      flow.timer = setTimeout(() => {
        if (flows.get(flow.id) !== flow) return;
        end(flow, "expired"); failed(flow, "The code expired. Start a new one in Vyre.");
      }, expiresMs);
      flow.timer.unref?.();
      log("github sign-in started", { id: flow.id, name });
      return { id: flow.id, user_code: shown.user_code, verification_uri: shown.verification_uri,
        expires_in: Math.round(expiresMs / 1000), interval: 5 };
    }),

    /**
     * Connect with a pasted personal access token (a fine-grained one can be narrower than the
     * sign-in's repo scope). One GET /user validates it before anything is saved, so a bad paste
     * fails now, not as a later 401. No `gh` involved.
     * @param {{ name: string, token: string }} input
     */
    paste: guarded(async ({ name, token }) => {
      if (!NAME.test(String(name || ""))) throw fail("name must be lowercase letters, digits and dashes, starting with a letter, at most 32");
      if (typeof token !== "string" || !/^[A-Za-z0-9_\-]{20,255}$/.test(token.trim())) throw fail("that does not look like a GitHub token (letters, digits, - and _ only, no spaces)");
      const clean = token.trim();
      if (await deps.taken(name)) throw fail(`an account named ${name} is already connected; remove it first or choose another name`, "exists");
      const flow = /** @type {Flow} */ ({ id: `gh_${crypto.randomBytes(9).toString("base64url")}`, name, dir: "", child: null, expires: 0, values: [clean], timer: null, output: "", gh: "", pasted: true });
      try { await complete(flow, clean); }
      catch (e) { const clean2 = scrub(String(/** @type {any} */ (e)?.message || e), [clean]); throw Object.assign(new Error(clean2), { code: typeof /** @type {any} */ (e)?.code === "string" ? /** @type {any} */ (e).code : "failed" }); }
      // What the token can really reach is GitHub's to say: one cheap call (a page of one repo and
      // the Link header's last page) gives the count, shown beside the login. Best effort.
      let repos = null;
      try {
        const r = await f(`${API}/user/repos?per_page=1&affiliation=owner,collaborator,organization_member`, { headers: { authorization: `Bearer ${clean}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (r.ok) {
          const link = r.headers && typeof r.headers.get === "function" ? String(r.headers.get("link") || "") : "";
          const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
          const page = await r.json().catch(() => []);
          repos = last ? Number(last[1]) : Array.isArray(page) ? page.length : null;
        }
      } catch { /* the count is a courtesy */ }
      return { connected: true, id: flow.id, name, login: /** @type {any} */ (flow).login, repos };
    }),

    /** @param {{ id: string }} input */
    cancel: guarded(async ({ id }) => {
      const flow = flows.get(String(id || ""));
      if (!flow) throw fail(ended.has(String(id)) ? endedText(ended.get(String(id))) : `no sign-in ${String(id).slice(0, 40)} is open`, "not_found");
      flow.cancelled = true;
      end(flow, "cancelled");
      failed(flow, "The sign-in was cancelled.");
      return { cancelled: true };
    }),

    /** Whether a sign-in is open, for tests and for a status poll from the Deck. @param {string} id */
    status: id => (flows.has(id) ? "pending" : ended.has(id) ? ended.get(id) : "unknown"),

    /** Module stop: drop every open sign-in, its process and its folder. */
    stop() {
      for (const flow of [...flows.values()]) {
        clearTimeout(flow.timer); flows.delete(flow.id);
        try { flow.child.kill("SIGTERM"); } catch {}
        try { fs.rmSync(flow.dir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

// There is no revoke() here on purpose (0.2, lead ruling 30 Sep). The token belongs to GitHub
// CLI's own app grant, shared with every `gh` install the person has; revoking it would sign their
// own real `gh` out on every other machine and CI runner too. `github.remove` only ever deletes
// Vyre's own local vault item and account row; the token itself, and whether it still works
// elsewhere, is the person's own business, at github.com/settings/applications if they ever want
// it gone entirely.
