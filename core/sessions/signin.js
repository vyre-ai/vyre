// @ts-check
// Signing an account in, with each provider's own official login and nothing else (charter 9: no
// Vyre-run OAuth app, no token extraction). Vyre runs the provider's login command as the
// account's own uid, in that account's own HOME, reads the address and one-time code it prints,
// and hands them to the surface (setup, Settings) to show. The person approves on any browser;
// the command finishes on its own and writes its token where only that account can read it.
// Vyre never sees the token.
//
//   start  -> { flow, step: "code", url, code }        (or step "url" for a login that wants a pasted code back)
//   status -> { flow, step: "code"|"waiting"|"done"|"failed", ... }
//   submit -> a pasted code goes to the command's stdin (Claude's login asks for one)
//
// The commands are the providers' documented ones. UNVERIFIED until a real account runs them on a
// hosted runner: codex --device-auth (documented, headless), grok's device-code login, claude
// auth login. Each entry's regexes read the printed address and code; a change in wording shows up
// as a flow that ends "failed" with what the command said, never as a wrong code.

import crypto from "node:crypto";
import fs from "node:fs";

/** How each provider signs in. `bin`/`args` run as the account; `wantsPaste` logins read a code back on stdin. */
export const LOGINS = /** @type {Record<string, { bin: string, args: string[], wantsPaste?: boolean }>} */ ({
  codex: { bin: "codex", args: ["login", "--device-auth"] },
  grok: { bin: "grok", args: ["login", "--device-code"] },
  claude: { bin: "claude", args: ["auth", "login"], wantsPaste: true },
});

/** Where a provider's sign-in page lives (lib/providers/signin-hosts.json, shared with the setup page's own check). A printed address on any other host is never shown to the person. */
export const LOGIN_HOSTS = /** @type {Record<string, string[]>} */ (JSON.parse(fs.readFileSync(new URL("../../lib/providers/signin-hosts.json", import.meta.url), "utf8")));
const onHost = (url, hosts) => { try { if (/[\\\s\u0000-\u001f]/.test(url)) return false; /* a backslash reads differently in different clients */ const auth = /^https:\/\/([^/?#]*)/i.exec(url); if (!auth || auth[1].includes("@")) return false; /* @ before the path is a userinfo trick; in a query it is an email */ const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password && hosts.some(h => u.hostname === h || u.hostname.endsWith("." + h)); } catch { return false; } };

/** Is this address one a provider's sign-in may show? (exported for its table test) */
export const signinAddressOk = (provider, url) => onHost(url, LOGIN_HOSTS[provider] || []);

const URL_RE = /https:\/\/[^\s"'<>)]+/;
// A one-time device code: XXXX-XXXX (letters and digits), the shape RFC 8628 examples and the CLIs print.
const CODE_RE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;
const TTL_MS = 15 * 60_000;

export class Signins {
  /**
   * @param {{ spawn: (bin: string, args: string[], o: { account: any }) => any, now?: () => number, hosts?: Record<string, string[]> }} deps
   *   hosts: the provider's sign-in hosts (LOGIN_HOSTS); a test passes its own
   *   spawn: start a command as the account (core/sessions/spawn.js spawnSession, with the account's uid and HOME)
   */
  constructor(deps) { this.deps = deps; /** @type {Map<string, any>} */ this.flows = new Map(); }

  /**
   * Begin a login for an account. Resolves once the command has printed its address (and code), or ended.
   * @param {{ provider: string, account: any, onDone?: (ok: boolean) => void }} i
   */
  start({ provider, account, onDone }) {
    const how = LOGINS[provider];
    if (!how) throw Object.assign(new Error(`${provider} has no sign-in Vyre knows how to run`), { code: "bad_input" });
    for (const [id, f] of this.flows) if (f.account === account.id && !f.ended) { f.proc.kill("SIGKILL"); this.flows.delete(id); }
    const flow = crypto.randomBytes(9).toString("hex");
    const proc = this.deps.spawn(how.bin, how.args, { account });
    /** @type {any} */
    const f = { id: flow, provider, account: account.id, proc, text: "", url: null, code: null, ended: false, ok: false, exit: null, wantsPaste: Boolean(how.wantsPaste), at: (this.deps.now || Date.now)(), waiters: [] };
    this.flows.set(flow, f);
    const read = d => {
      f.text = (f.text + String(d)).slice(-8000);
      const clean = f.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      if (!f.code) {
        // Every address on the provider's own host; the one whose path says device, login, auth or
        // oauth is the sign-in page (a docs link may be printed first), else the last one.
        const ok = [...clean.matchAll(new RegExp(URL_RE, "g"))].map(m => m[0].replace(/[.,;]+$/, "")).filter(u => onHost(u, (this.deps.hosts || LOGIN_HOSTS)[provider] || []));
        const pick = ok.find(u => /device|login|auth/i.test(new URL(u).pathname)) || ok[ok.length - 1];
        if (pick) f.url = pick;   // re-picked as more is printed, until the code shows and settles it
      }
      if (!f.code) { const c = CODE_RE.exec(clean); if (c) f.code = c[1]; }
      if (f.url && (f.code || f.wantsPaste)) this.ping(f);
    };
    proc.stdout.setEncoding("utf8"); proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", read); proc.stderr.on("data", read);
    const end = (code, signal) => { if (f.ended) return; f.ended = true; f.exit = { code, signal }; f.ok = code === 0; try { onDone && onDone(f.ok); } catch {} this.ping(f); };
    proc.on("exit", end); proc.on("error", e => { f.text += `\n${e.message}`; end(127, null); });
    return new Promise(resolve => { f.waiters.push(() => resolve(this.status(flow))); setTimeout(() => this.ping(f), 20_000).unref?.(); });
  }

  ping(f) { const w = f.waiters.splice(0); for (const fn of w) fn(); }

  /** @param {string} flow */
  status(flow) {
    const f = this.flows.get(String(flow));
    if (!f) throw Object.assign(new Error("no such sign-in; start again"), { code: "not_found" });
    if (!f.ended && (this.deps.now || Date.now)() - f.at > TTL_MS) { f.proc.kill("SIGKILL"); f.ended = true; f.ok = false; f.exit = { code: null, signal: "SIGKILL" }; }
    if (f.ended) return f.ok ? { flow, step: "done", provider: f.provider, account: f.account } : { flow, step: "failed", provider: f.provider, account: f.account, message: this.said(f) };
    if (f.url && (f.code || f.wantsPaste)) return { flow, step: f.wantsPaste && !f.code ? "url" : "code", provider: f.provider, account: f.account, url: f.url, ...(f.code ? { code: f.code } : {}), ...(f.wantsPaste ? { paste: true } : {}) };
    return { flow, step: "waiting", provider: f.provider, account: f.account };
  }

  /** What the command last said, for a failure: its own words, trimmed, no ANSI. @param {any} f */
  said(f) { return f.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim().split("\n").slice(-4).join(" ").slice(0, 300) || "the sign-in command ended without finishing"; }

  /** A code the person pasted back, for a login that asks for one. @param {string} flow @param {string} code */
  submit(flow, code) {
    const f = this.flows.get(String(flow));
    if (!f) throw Object.assign(new Error("no such sign-in; start again"), { code: "not_found" });
    if (!f.wantsPaste || f.ended) throw Object.assign(new Error("this sign-in is not waiting for a pasted code"), { code: "bad_input" });
    const c = String(code || "").trim();
    if (!/^[\w.~-]{6,256}$/.test(c)) throw Object.assign(new Error("that does not look like the code the page showed"), { code: "bad_input" });
    f.proc.stdin.write(c + "\n");
    return { flow, step: "waiting" };
  }

  /** Stop every open flow (the module stopping). */
  stop() { for (const f of this.flows.values()) if (!f.ended) { try { f.proc.kill("SIGKILL"); } catch {} } this.flows.clear(); }
}
