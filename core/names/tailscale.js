// @ts-check
// tailscale — the one place Vyre runs the tailscale CLI.
//
// Reads (status, whois) are safe anywhere. `up` and `cert` change the machine's Tailscale state,
// so only the names module calls them, and only when the user pressed Connect or claimed a name.
// VYRE_TAILSCALE_BIN points tests at a fake binary; nothing in the tests ever runs the real one.

import { execFile, spawn } from "node:child_process";
import os from "node:os";

const bin = () => process.env.VYRE_TAILSCALE_BIN || "tailscale";

/** Run the CLI and resolve to { code, out, err }; a missing binary is code 127, not a throw. */
export function run(args, { timeout = 15_000 } = {}) {
  return new Promise(resolve => {
    execFile(bin(), args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => {
      const code = !e ? 0 : /** @type {any} */ (e).code === "ENOENT" ? 127 : Number(/** @type {any} */ (e).code) || 1;
      resolve({ code, out: String(out), err: String(err) });
    });
  });
}

/** The one command to show when Tailscale is missing on this OS. */
export function installCommand(platform = process.platform) {
  if (platform === "linux") return "curl -fsSL https://tailscale.com/install.sh | sh";
  if (platform === "darwin") return "open https://tailscale.com/download/mac";
  return "open https://tailscale.com/download";
}

/**
 * What Tailscale says about this machine.
 * @returns {Promise<{ installed: boolean, running: boolean, backend: string|null, loginUrl: string|null, tun: boolean,
 *   node: { name: string, dnsName: string, ips: string[], stableId: string, tagged: boolean } | null,
 *   owner: string|null, certDomains: string[], why: string|null }>}
 */
export async function status() {
  const r = await run(["status", "--json"]);
  const empty = { installed: r.code !== 127, running: false, backend: null, loginUrl: null, tun: true, node: null, owner: null, certDomains: [], why: null };
  if (r.code === 127) return { ...empty, why: "Tailscale is not installed" };
  let s;
  try { s = JSON.parse(r.out); } catch { return { ...empty, why: (r.err || r.out).trim().split("\n")[0] || "tailscale status failed" }; }
  return parseStatus(s);
}

/** Pure, for tests: the fields Vyre uses from `tailscale status --json`. */
export function parseStatus(s) {
  const self = s.Self || null;
  const tags = (self && self.Tags) || [];
  const users = s.User || {};
  const owner = self && !tags.length && users[String(self.UserID)] ? users[String(self.UserID)].LoginName || null : null;
  const backend = s.BackendState || null;
  return {
    installed: true,
    running: backend === "Running",
    backend,
    loginUrl: s.AuthURL || null,
    tun: s.TUN !== false,
    node: self && backend === "Running" ? {
      name: String(self.HostName || ""),
      dnsName: String(self.DNSName || "").replace(/\.$/, ""),
      ips: (self.TailscaleIPs || []).map(String),
      stableId: String(self.ID || ""),
      tagged: tags.length > 0,
    } : null,
    owner,
    certDomains: (s.CertDomains || []).map(String),
    why: backend === "Running" ? null : backend === "NeedsLogin" ? "this machine is not signed in to Tailscale" : backend ? `Tailscale is ${backend}` : null,
  };
}

/**
 * Who is at this tailnet address.
 * @returns {Promise<{ login: string|null, tagged: boolean, node: string, stableId: string } | null>}
 */
export async function whois(ip) {
  const r = await run(["whois", "--json", ip], { timeout: 5000 });
  if (r.code !== 0) return null;
  try { return parseWhois(JSON.parse(r.out)); } catch { return null; }
}

/** Pure, for tests. A tagged node has no person behind it, whatever profile it reports. */
export function parseWhois(w) {
  if (!w || !w.Node) return null;
  const tagged = Array.isArray(w.Node.Tags) && w.Node.Tags.length > 0;
  return {
    login: tagged ? null : (w.UserProfile && w.UserProfile.LoginName) || null,
    tagged,
    node: String(w.Node.Name || w.Node.ComputedName || "").replace(/\.$/, ""),
    stableId: String(w.Node.StableID || w.Node.ID || ""),
  };
}

/**
 * Start `tailscale up`. It blocks until the person signs in, so it runs detached; this resolves as
 * soon as a login URL appears in its output, or when it exits (already signed in), or after
 * `wait` ms. The process keeps running until sign-in completes.
 * @returns {Promise<{ loginUrl: string|null, exited: boolean, code: number|null, output: string }>}
 */
export function up({ wait = 10_000 } = {}) {
  const args = upArgs();
  return new Promise(resolve => {
    let output = "", done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try { child = spawn(bin(), args, { stdio: ["ignore", "pipe", "pipe"], detached: true }); }
    catch (e) { return resolve({ loginUrl: null, exited: true, code: 127, output: /** @type {Error} */ (e).message }); }
    const look = c => {
      output += c;
      const m = output.match(/https:\/\/login\.tailscale\.com\/\S+/);
      if (m) finish({ loginUrl: m[0], exited: false, code: null, output });
    };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.on("error", e => finish({ loginUrl: null, exited: true, code: 127, output: e.message }));
    child.on("exit", code => finish({ loginUrl: null, exited: true, code, output }));
    child.unref();
    const timer = setTimeout(() => finish({ loginUrl: null, exited: false, code: null, output }), wait);
  });
}

/**
 * `tailscale up` on a machine that is not signed in replaces every preference with the flags it
 * is given, so a bare `up` would drop the operator it runs as. On Linux it names this user again,
 * and VYRE_TAILSCALE_UP_FLAGS adds the rest (the box's compose sets --accept-dns=false).
 */
export function upArgs(env = process.env, platform = process.platform, user = os.userInfo().username) {
  const extra = String(env.VYRE_TAILSCALE_UP_FLAGS || "").split(/\s+/).filter(f => /^--[a-z-]+(=\S*)?$/.test(f));
  return ["up", ...(platform === "linux" ? [`--operator=${user}`] : []), ...extra];
}

/** `tailscale cert` for the node's ts.net name, into the given files. */
export async function cert(domain, certFile, keyFile) {
  const r = await run(["cert", "--cert-file", certFile, "--key-file", keyFile, domain], { timeout: 120_000 });
  if (r.code !== 0) throw new Error((r.err || r.out).trim().split("\n").slice(-1)[0] || "tailscale cert failed");
}

/**
 * May this process change Tailscale? On Linux `tailscale up` and `tailscale cert` need root or
 * the operator setting (`tailscale set --operator=<user>`), which the installer sets.
 */
export async function operator(user, platform = process.platform) {
  if (platform !== "linux" || (typeof process.getuid === "function" && process.getuid() === 0)) return { ok: true, fix: null };
  const r = await run(["debug", "prefs"]);
  let op = null;
  try { op = JSON.parse(r.out).OperatorUser || null; } catch {}
  return op === user ? { ok: true, fix: null } : { ok: false, fix: `sudo tailscale set --operator=${user}` };
}
