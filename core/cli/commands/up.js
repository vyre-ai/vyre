// @ts-check
// `vyre up` and the box's system commands.
//
// `vyre up` is the one command a person types. It starts vyred (or restarts it after an upgrade),
// then prints one thing: the onboarding link, the box's address, or on a Mac the box it talks to.
// `vyre up --system` (as root) installs the systemd units; `vyre uninstall --system` removes them.
// Both print every change and make none with --dry-run. See docs/INSTALL.md and ADR 0002.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { request, call } from "../../daemon/client.js";
import { ensureUp, stop } from "../daemonctl.js";
import { REPO, VERSION } from "../../daemon/index.js";
import { out, dim, signal, beacon } from "../style.js";
import * as config from "../../config/index.js";
import * as system from "../../names/system.js";
import { backup, restore } from "../../names/backup.js";

/** Pull --flags out of argv: { flags: { user: "alex", "dry-run": true }, rest: [...] }. */
export function parse(args, valued = ["user", "connect"]) {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const [k, v] = a.slice(2).split("=", 2);
    flags[k] = v !== undefined ? v : valued.includes(k) ? args[++i] : true;
  }
  return { flags, rest };
}

/**
 * The line that reaches a headless box's loopback page from the person's own computer, or null
 * when this terminal is not over SSH. In the box's container, the host's `vyre` passes its own
 * SSH_CONNECTION through and names the host account in VYRE_HOST_USER, since the container's
 * account is not the one the person signs in with.
 */
export function sshLine(port, user, env = process.env) {
  const conn = String(env.SSH_CONNECTION || "").split(" ");
  if (conn.length < 4) return null;
  const host = conn[2].includes(":") ? `[${conn[2]}]` : conn[2];
  return `ssh -N -L ${port}:127.0.0.1:${port} ${env.VYRE_HOST_USER || user}@${host}`;
}

const UNIT = path.join(system.ETC, "vyre.service");
const systemdManaged = () => process.platform === "linux" && fs.existsSync(UNIT);

async function health() { const h = await request("GET", "/v1/health"); return h.error ? null : h.data; }

/** Wait for vyred to answer with the wanted version (after systemd restarts it). */
async function waitFor(version, ms = 15_000) {
  for (let t = 0; t < ms; t += 250) {
    const h = await health();
    if (h && h.version === version) return h;
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

/** Start vyred, or restart it when it runs an older version or the wrong role. */
async function bring(role) {
  const h = await health();
  if (h && h.version === VERSION && h.role === role) return { ok: true, note: null };
  if (h && h.supervisor === "systemd") {
    // systemd restarts it (Restart=always) with the code npm just installed.
    try { process.kill(h.pid, "SIGTERM"); } catch {}
    const back = await waitFor(VERSION);
    return back ? { ok: true, note: `restarted ${h.version} → ${VERSION}` } : { ok: false, note: "vyred did not come back; see journalctl -u vyre" };
  }
  if (process.env.VYRE_SUPERVISOR === "docker") {
    // In the box's container vyred is the container's main process: the image is the version, and
    // Docker restarts it. A new version arrives with `docker compose pull && docker compose up -d`.
    return h ? { ok: true, note: h.version === VERSION ? null : `running ${h.version}; this image is ${VERSION}` }
      : { ok: false, note: "vyred is not answering in its container: docker compose -p vyre logs vyre" };
  }
  if (!h && systemdManaged()) return { ok: false, note: "vyred is installed as a service and is stopped: sudo systemctl start vyre" };
  if (h) await stop();
  const r = await ensureUp();
  if (!r.ok) return { ok: false, note: `vyred did not start; its output is in ${r.log}` };
  return { ok: true, note: h ? `restarted ${h.version} → ${VERSION}` : `started · pid ${r.pid}` };
}

async function up(args) {
  const { flags } = parse(args);
  if (flags.system) return upSystem(flags);
  const cfg = config.load();
  let role = cfg.role;
  if (flags.box) role = "box";
  if (flags.local || flags.connect) role = "local";
  if (flags["dry-run"]) {
    out(`  would start vyred ${VERSION} as ${os.userInfo().username}, role ${role}, home ${config.home()}`);
    out(`  would then print ${role === "box" ? "the onboarding link" : "the box this machine talks to"}`);
    return 0;
  }
  if (role !== cfg.role) config.save({ role });
  if (flags.connect) config.save({ network: { box: String(flags.connect).replace(/^(?!https:\/\/)/, "https://").replace(/\/$/, "") } });

  const b = await bring(role);
  if (!b.ok) { out(beacon("  " + b.note)); return 1; }
  out(b.note ? `  vyred ${signal("running")} ${dim(`· ${VERSION} · ${role} · ${b.note}`)}` : `  vyred is already running ${dim(`· ${VERSION} · ${role}`)}`);

  if (systemdManaged()) {
    // An upgrade can change the units; only root can rewrite them.
    try {
      const me = os.userInfo().username, acct = account(me);
      const want = system.units({ user: me, group: acct.group, home: acct.home, node: process.execPath, pkg: REPO });
      if (fs.readFileSync(UNIT, "utf8") !== want["vyre.service"]) out(beacon("  the service unit is out of date: ") + "sudo vyre up --system --user " + me);
    } catch {}
  }

  if (role === "local") return mac(config.load().network.box, { capsule: !flags["no-capsule"] });

  const link = await call("onboard.link");
  if (link.error) { out(beacon("  onboarding is not available: ") + link.error.message); return 1; }
  const d = link.data;
  if (!d.url) {
    out(d.address ? `  your address: ${signal(d.address)}` : "  set up is done; there is no address yet (vyre name)");
    return 0;
  }
  out("");
  out(`  Open this link to set up Vyre ${dim("(it works once, for an hour)")}:`);
  out("");
  out(`    ${signal(d.url)}`);
  const ssh = sshLine(d.port, d.user);
  if (ssh) {
    out("");
    out(`  This box is headless. On your own computer, run this first, then open the link there:`);
    out(`    ${ssh}`);
  }
  if (d.address) out(dim(`\n  or, once your devices are on the tailnet: ${d.address}`));
  out("");
  return 0;
}

const CAPSULE_ZIP = "https://vyre.run/box/Vyre-mac.zip";

/**
 * The end of `vyre up` on a Mac: the box answers, this Mac is paired with it (or the code to
 * approve on the box is on screen), and the Capsule is open. Every step says what to do next
 * when it cannot finish. `deps` is for tests.
 */
export async function mac(box, { capsule = true } = {}, deps = {}) {
  const {
    health = b => fetch(b + "/v1/health", { signal: AbortSignal.timeout(5000) }).then(r => r.ok).catch(() => false),
    tool = call,
    platform = process.platform,
    openCapsule = async () => {
      const c = await import("./capsule.js");
      if (!c.installed() && !c.packaged().bin && !c.electron()) return false;
      return (await c.default.run([])) === 0;
    },
  } = deps;
  if (!box) { out(`  this machine is local. Point it at your box: ${dim("vyre up --connect <you>.vyre.run")}`); return 0; }
  const ok = await health(box);
  out(ok ? `  your box: ${signal(box)}` : beacon(`  your box ${box} did not answer from here`) + dim(" · is this machine on your tailnet?"));
  if (!ok) return 1;

  const s = await tool("link.status");
  if (s.error) out(beacon("  cannot read the link: ") + s.error.message);
  else if (s.data.linked) out(`  ${signal("linked")} ${dim("· this Mac and your box work as one")}`);
  else {
    let code = s.data.pending && s.data.pending.code;
    if (!code) {
      const p = await tool("link.pair", { box });
      if (p.error) out(beacon("  pairing did not start: ") + p.error.message + dim(" · vyre link pair " + box));
      code = p.data && p.data.code;
    }
    if (code) {
      out(`  pair this Mac: on the box, run ${signal("vyre link approve " + code)}`);
      out(dim("  or approve it in the Deck on another of your devices. vyre link shows when it is done."));
    }
  }

  if (!capsule || platform !== "darwin") return 0;
  if (!(await openCapsule())) out(`  the Capsule is not installed: ${signal(CAPSULE_ZIP)} ${dim("· unzip it into Applications, then vyre capsule")}`);
  return 0;
}

/** Look up a local account: its home and primary group. */
function account(user) {
  if (process.platform === "linux") {
    const line = execFileSync("getent", ["passwd", user], { encoding: "utf8" }).trim();
    const [, , , gid, , home] = line.split(":");
    const group = execFileSync("getent", ["group", gid], { encoding: "utf8" }).split(":")[0];
    return { home, group };
  }
  const me = os.userInfo();
  if (me.username !== user) throw new Error(`cannot look up ${user} on ${process.platform}`);
  return { home: me.homedir, group: String(me.gid) };
}

async function upSystem(flags) {
  const dryRun = Boolean(flags["dry-run"]);
  const user = String(flags.user || process.env.SUDO_USER || "");
  if (!user || user === "root") { out(beacon("  vyre up --system needs --user <the account vyred runs as>, and it is never root")); return 1; }
  if (!dryRun && (typeof process.getuid !== "function" || process.getuid() !== 0)) { out(beacon("  vyre up --system changes the system: run it with sudo, or add --dry-run")); return 1; }
  let acct;
  try { acct = account(user); } catch (e) { out(beacon(`  no such account: ${user}`)); return 1; }
  const seen = system.detect();
  const steps = system.installPlan({ user, group: acct.group, home: acct.home, node: process.execPath, pkg: REPO,
    hasUnit: seen.units, tailscale: seen.tailscale, systemd: seen.systemd });
  if (dryRun) out(dim("  dry run: nothing will change"));
  try { await system.apply(steps, { dryRun, out: l => out("  " + l) }); }
  catch (e) { out(beacon("  stopped: ") + /** @type {Error} */ (e).message); return 1; }
  return 0;
}

export default [
  {
    name: "up", order: 10, usage: "vyre up [--box|--connect <addr>] [--no-capsule]", summary: "start vyred and print the onboarding link, or this box's address",
    run: up,
  },
  {
    name: "uninstall", order: 95, hidden: true, usage: "vyre uninstall --system [--purge] [--dry-run]", summary: "remove the systemd units (the data stays unless --purge)",
    async run(args) {
      const { flags } = parse(args);
      if (!flags.system) { out("  vyre uninstall --system [--purge] [--dry-run]"); return 1; }
      const dryRun = Boolean(flags["dry-run"]);
      if (!dryRun && (typeof process.getuid !== "function" || process.getuid() !== 0)) { out(beacon("  run it with sudo, or add --dry-run")); return 1; }
      const user = String(flags.user || process.env.SUDO_USER || os.userInfo().username);
      let home = os.homedir();
      try { home = account(user).home; } catch {}
      await system.apply(system.uninstallPlan({ purge: Boolean(flags.purge), home }), { dryRun, out: l => out("  " + l) });
      return 0;
    },
  },
  {
    name: "daemon", order: 96, hidden: true, summary: "run vyred in the foreground (what systemd runs)",
    async run() { await import("../../daemon/main.js"); return new Promise(() => {}); },
  },
  {
    name: "backup", order: 80, usage: "vyre backup [file]", summary: "copy config, store, vault, watchers and certificates into one file",
    async run([file]) {
      const target = path.resolve(file || `vyre-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`);
      const r = await backup({ root: config.home(), file: target });
      out(`  ${signal(r.file)} ${dim(`· ${Math.round(r.bytes / 1024)} KB · ${r.included.join(", ")}`)}`);
      out(dim("  it holds the sealed vault: keep it somewhere only you can read"));
      return 0;
    },
  },
  {
    name: "restore", order: 81, hidden: true, usage: "vyre restore <file> [--force]", summary: "put a backup back (vyred must be stopped)",
    async run(args) {
      const { flags, rest } = parse(args);
      if (!rest[0]) { out("  vyre restore <file> [--force]"); return 1; }
      try { await restore({ root: config.home(), file: path.resolve(rest[0]), force: Boolean(flags.force) }); }
      catch (e) { out(beacon("  " + /** @type {Error} */ (e).message)); return 1; }
      out("  restored · vyre up to start");
      return 0;
    },
  },
  {
    name: "name", order: 30, usage: "vyre name [check <n>|claim <n>|ts.net|release]", summary: "this box's address: <you>.vyre.run",
    async run([action, name]) {
      const tool = { check: "names.check", claim: "names.claim", "ts.net": "names.fallback", release: "names.release" }[action || ""] || "names.status";
      const r = await call(tool, name ? { name } : {});
      if (r.error) { out(beacon(`  ${r.error.code}: `) + r.error.message); return 1; }
      const d = r.data;
      if (tool === "names.check") out(d.valid && d.available ? `  ${signal(d.address)} is free` : beacon(`  ${d.name}: ${d.why}`));
      else out(`  ${d.address ? signal(d.address) : dim("no address")} ${dim(`· ${d.phase}${d.owner ? " · owner " + d.owner : ""}${d.why ? " · " + d.why : ""}`)}`);
      return 0;
    },
  },
  {
    name: "owner", order: 31, hidden: true, usage: "vyre owner <tailscale login>", summary: "the one Tailscale login this box serves",
    async run([login]) {
      if (!login) { const s = await call("names.status"); out(`  ${s.data ? s.data.owner || "no owner yet" : s.error.message}`); return 0; }
      const r = await call("names.owner", { login });
      if (r.error) { out(beacon("  " + r.error.message)); return 1; }
      out(`  owner: ${signal(login)}`);
      return 0;
    },
  },
];
