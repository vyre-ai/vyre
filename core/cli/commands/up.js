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
import readline from "node:readline/promises";
import { execFileSync, spawn } from "node:child_process";
import { request, call } from "../../daemon/client.js";
import { ensureUp, stop } from "../daemonctl.js";
import { REPO, VERSION } from "../../daemon/index.js";
import { out, dim, signal, beacon } from "../style.js";
import * as config from "../../config/index.js";
import * as system from "../../names/system.js";
import { backup, restore } from "../../names/backup.js";
import * as tailnet from "../tailnet.js";
import { printEnding } from "../ending.js";

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

/**
 * What `vyre up` needs from the world, so tests can stand in for each piece.
 * @typedef {{ ask(q: string): Promise<string>, tty: boolean }} IO
 * @typedef {{ io?: IO, bring?: typeof bring, call?: typeof call, tailnet?: { status: typeof tailnet.status, boxes: typeof tailnet.boxes, probe: typeof tailnet.probe },
 *   addBox?: (target: string, opts: any) => Promise<number>, openUrl?: (url: string) => void, platform?: string }} Deps
 */

/** Questions on the person's own terminal. One readline per question, so nothing holds stdin open. */
export const terminal = {
  tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  async ask(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(q)).trim(); } finally { rl.close(); }
  },
};

/** Open a link in the browser. VYRE_OPEN_BIN points tests at a fake `open`. */
export function openUrl(url) {
  try { spawn(process.env.VYRE_OPEN_BIN || "open", [url], { detached: true, stdio: "ignore" }).unref(); } catch {}
}

/** An address as network.box holds it: https, no trailing slash. */
export const normalize = a => String(a).trim().replace(/^(?!https:\/\/)/, "https://").replace(/\/$/, "");

/**
 * Find this person's box on the tailnet: every candidate peer that answers /v1/health.
 * @param {Deps["tailnet"]} tn
 */
export async function discover(tn = tailnet) {
  const t = await tn.status();
  if (!t.running) return { tailnet: t, found: [] };
  const found = [];
  for (const p of tn.boxes(t)) {
    const address = `https://${p.dnsName}`;
    const health = await tn.probe(address);
    if (health) found.push({ address, health });
  }
  return { tailnet: t, found };
}

/**
 * @param {string[]} args
 * @param {Deps} [deps]
 */
export async function up(args, deps = {}) {
  const { flags } = parse(args);
  if (flags.system) return upSystem(flags);
  const json = Boolean(flags.json);
  const io = deps.io || terminal, tn = deps.tailnet || tailnet, callTool = deps.call || call;
  const platform = deps.platform || process.platform;
  // In JSON mode the one object is the whole output: no prose, no colour, and no questions.
  const say = json ? () => {} : out;
  /** @param {Record<string, any>} o */
  const done = (o, code = 0) => { if (json) out(JSON.stringify({ role, version: VERSION, url: null, port: null, ssh: null, address: null, box: null, ready: false, ...o })); return code; };
  const fail = (code, message) => { if (json) out(JSON.stringify({ error: { code, message } })); else out(beacon("  " + message)); return 1; };

  const cfg = config.load();
  let role = cfg.role;
  if (flags.box) role = "box";
  if (flags.local || flags.connect) role = "local";
  if (flags["dry-run"]) {
    say(`  would start vyred ${VERSION} as ${os.userInfo().username}, role ${role}, home ${config.home()}`);
    say(`  would then print ${role === "box" ? "the onboarding link" : "the box this machine talks to"}`);
    return done({ box: role === "local" ? cfg.network.box || null : null });
  }
  if (role !== cfg.role) config.save({ role });
  if (flags.connect) config.save({ network: { box: normalize(flags.connect) } });

  const b = await (deps.bring || bring)(role);
  if (!b.ok) return fail("vyred_down", b.note || "vyred did not start");
  say(b.note ? `  vyred ${signal("running")} ${dim(`· ${VERSION} · ${role} · ${b.note}`)}` : `  vyred is already running ${dim(`· ${VERSION} · ${role}`)}`);

  if (systemdManaged()) {
    // An upgrade can change the units; only root can rewrite them.
    try {
      const me = os.userInfo().username, acct = account(me);
      const want = system.units({ user: me, group: acct.group, home: acct.home, node: process.execPath, pkg: REPO });
      if (fs.readFileSync(UNIT, "utf8") !== want["vyre.service"]) say(beacon("  the service unit is out of date: ") + "sudo vyre up --system --user " + me);
    } catch {}
  }

  if (role === "local") {
    let box = config.load().network.box || null;
    if (!box) {
      // No box known: look for one on the tailnet before asking anything (ADR 0008 section 3).
      const d = await discover(tn);
      if (d.found.length === 1) {
        box = d.found[0].address;
        config.save({ network: { box } });
        say(`  found your box on the tailnet: ${signal(box)}`);
      } else if (d.found.length > 1) {
        const list = d.found.map(f => f.address);
        if (json || !io.tty) {
          if (json) return fail("several_boxes", `more than one Vyre box answers on your tailnet: ${list.join(", ")}. Pick one: vyre up --connect <address>`);
          say("  More than one Vyre box answers on your tailnet:");
          list.forEach((a, i) => say(`    ${i + 1}  ${a}`));
          say(`  Pick one: ${dim("vyre up --connect <address>")}`);
          return 1;
        }
        say("  More than one Vyre box answers on your tailnet:");
        list.forEach((a, i) => say(`    ${i + 1}  ${a}`));
        const n = Number(await io.ask(`  Which one? (1-${list.length}) `));
        if (!Number.isInteger(n) || n < 1 || n > list.length) return fail("no_choice", "no box chosen; run vyre up again, or vyre up --connect <address>");
        box = list[n - 1];
        config.save({ network: { box } });
      } else {
        if (!d.tailnet.running) {
          // A box on a server is reached over the tailnet at the end, so this Mac needs it either way.
          say(beacon(`  ${d.tailnet.why || "Tailscale is not running"}`) + (d.tailnet.installed ? "" : dim(` · ${tailnet.DOWNLOAD}`)));
        }
        if (json || !io.tty) {
          say("  No Vyre box yet. Pick where it runs:");
          say(`    on a server you can SSH to   ${dim("vyre box add user@host")}`);
          say(`    on this Mac                  ${dim("vyre up --box")}`);
          say(`    you already set one up       ${dim("vyre up --connect <address>")}`);
          return done({});
        }
        return ask(io, deps);
      }
    }
    return reachBox(box, { json, say, done, fail, tn, callTool });
  }

  const link = await callTool("onboard.link");
  if (link.error) return fail("onboarding_unavailable", "onboarding is not available: " + link.error.message);
  const d = link.data;
  const ssh = d.url ? sshLine(d.port, d.user) : null;
  if (!d.url) {
    // After onboarding: the same ending the Mac prints, so "is it done?" has one answer.
    const ready = Boolean(d.address && await tn.probe(d.address));
    if (json) return done({ address: d.address || null, ready });
    if (d.address) printEnding({ address: d.address, assistant: config.load().onboard?.assistant || null });
    else say("  set up is done; there is no address yet (vyre name)");
    return 0;
  }
  if (json) return done({ url: d.url, port: d.port ?? null, ssh, address: d.address || null });
  say("");
  say(`  Open this link to set up Vyre ${dim("(it works once, for an hour)")}:`);
  say("");
  say(`    ${signal(d.url)}`);
  if (ssh) {
    say("");
    say(`  This box is headless. On your own computer, run this first, then open the link there:`);
    say(`    ${ssh}`);
  }
  if (d.address) say(dim(`\n  or, once your devices are on the tailnet: ${d.address}`));
  say("");
  // `vyre up --box` on a Mac: the browser is right here, so open the link too.
  if (platform === "darwin" && !ssh) (deps.openUrl || openUrl)(d.url);
  return 0;
}

/** "Where should Vyre run?", asked on a Mac that knows no box and found none. */
async function ask(io, deps) {
  out("");
  out("  Where should Vyre run?");
  out(`    1  on a server I can SSH to ${dim("(recommended)")}`);
  out("    2  on this Mac");
  out("    3  I already set up a box");
  const choice = (await io.ask("  1, 2 or 3? ")).trim();
  if (choice === "1") {
    const target = (await io.ask("  server (user@host): ")).trim();
    if (!target) { out(beacon("  no server given")); return 1; }
    // Lazily, so `vyre up` loads on a Mac whatever state box.js is in.
    const add = deps.addBox || (await import("./box.js")).add;
    return add(target, {});
  }
  if (choice === "2") return up(["--box"], deps);
  if (choice === "3") {
    const a = (await io.ask("  its address (https://vyre.<tailnet>.ts.net): ")).trim();
    if (!a) { out(beacon("  no address given")); return 1; }
    return up(["--connect", a], deps);
  }
  out(beacon("  nothing chosen") + dim(" · vyre box add user@host, vyre up --box, or vyre up --connect <address>"));
  return 1;
}

/** On a Mac with a known box: does it answer, is the Mac paired, then the ending. */
async function reachBox(box, { json, say, done, fail, tn, callTool }) {
  const h = await tn.probe(box);
  if (!h) {
    const t = await tn.status();
    const why = !t.running ? `this Mac is not on the tailnet (${t.why || "Tailscale is not running"})` : "the box is offline or unreachable";
    if (json) return fail("box_unreachable", `your box ${box} did not answer from here: ${why}`);
    say(beacon(`  your box ${box} did not answer from here`) + dim(` · ${why}`));
    if (!t.running && !t.installed) say(dim(`  ${tailnet.DOWNLOAD}`));
    return 1;
  }
  // Pairing belongs to the link workstream; until link.status exists, there is nothing to show.
  const s = await callTool("link.status", { box });
  if (!s.error) {
    if (s.data && s.data.paired) say(`  paired with your box ${dim("· " + box)}`);
    else {
      const p = await callTool("link.pair", { box });
      if (p.error) say(beacon("  not paired yet: ") + p.error.message);
      else say(p.data && p.data.code ? `  pairing: ${p.data.code}` : "  paired with your box");
    }
  } else if (s.error.code !== "no_such_tool") say(dim(`  link: ${s.error.message}`));
  if (json) return done({ box, ready: true });
  printEnding({ address: box, assistant: h.assistant || null });
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
    name: "up", order: 10, usage: "vyre up [--box|--connect <addr>] [--json]", summary: "start vyred and print the onboarding link, or this box's address",
    run: args => up(args),
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
