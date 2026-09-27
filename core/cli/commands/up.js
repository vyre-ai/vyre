// @ts-check
// `vyre up` and the box's system commands.
//
// `vyre up` is the one command a person types. It starts vyred (or restarts it after an upgrade),
// then prints one thing: the onboarding link, the box's address, or on a Mac the box it talks to.
// `vyre up --system` (as root) installs the systemd units; `vyre uninstall --system` removes them.
// Both print every change and make none with --dry-run. See docs/INSTALL.md and ADR 0002.
//
// --json shapes: up {role, version, url, port, ssh, address, box, ready, ...} or {error} ·
// backup {file, bytes, included} · restore {restored} · name {address, phase, owner?, why?} and
// name check {name, valid, available, address?, why?} · owner {owner}. Only `vyre name` has verbs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync, spawn } from "node:child_process";
import { request, call } from "../../daemon/client.js";
import { ensureUp, stop } from "../daemonctl.js";
import { REPO, VERSION } from "../../daemon/index.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, fail, failTool, usage, viewing } from "../kit.js";
import * as config from "../../config/index.js";
import { dialogsAllowed, isRealHome } from "../../config/dialogs.js";
import * as system from "../../names/system.js";
import { backup, restore } from "../../names/backup.js";
import * as tailnet from "../tailnet.js";
import { printEnding } from "../ending.js";
import { hello } from "../brand.js";
import { findAssistant } from "./assistant.js";
import { build, label } from "../../daemon/build.js";

/** Pull --flags out of argv: { flags: { user: "alex", "dry-run": true }, rest: [...] }. */
export function parse(args, valued = ["user", "connect"]) {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const [k, v] = a.slice(2).split("=", 2);
    // A valued flag never swallows the next flag: `--connect --json` is a missing address, not "--json".
    flags[k] = v !== undefined ? v : valued.includes(k) && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[++i] : true;
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

/** Wait for vyred to answer with the wanted version and build (after systemd restarts it). */
async function waitFor(version, ms = 15_000, commit = null) {
  for (let t = 0; t < ms; t += 250) {
    const h = await health();
    if (h && h.version === version && (!commit || h.commit === commit)) return h;
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

/** Start vyred, or restart it when it runs an older version or the wrong role. */
async function bring(role, mineOf = build) {
  const h = await health();
  // A release is stamped with its commit (build.json). An upgrade that keeps the version number
  // still changes the commit, and the vyred started before it runs the old code: that one is
  // restarted, as is one whose build is dirty or unknown. A checkout (no stamp) compares versions.
  const mine = mineOf();
  const sameBuild = !mine.stamped || (h && h.commit === mine.commit && h.dirty === false && mine.dirty === false);
  if (h && h.version === VERSION && h.role === role && sameBuild) return { ok: true, note: null };
  const was = h ? label({ version: h.version, commit: h.commit ?? null, dirty: h.dirty ?? null }) : "";
  const now = label(mine);
  const restarted = h && h.version === VERSION && !sameBuild ? `updated · restarted vyred (${was} → ${now})` : `restarted ${was} → ${now}`;
  if (h && h.supervisor === "systemd") {
    // systemd restarts it (Restart=always) with the code npm just installed.
    try { process.kill(h.pid, "SIGTERM"); } catch {}
    const back = await waitFor(VERSION, 15_000, mine.stamped ? mine.commit : null);
    return back ? { ok: true, note: restarted } : { ok: false, note: "vyred did not come back; see journalctl -u vyre" };
  }
  if (process.env.VYRE_SUPERVISOR === "docker") {
    // In the box's container vyred is the container's main process: the image is the version, and
    // Docker restarts it. A new version arrives with `docker compose pull && docker compose up -d`.
    return h ? { ok: true, note: h.version === VERSION ? null : `running ${h.version}; this image is ${VERSION}` }
      : { ok: false, note: "vyred is not answering in its container: docker compose -p vyre logs vyre" };
  }
  if (!h && systemdManaged()) return { ok: false, note: "vyred is installed as a service and is stopped: sudo systemctl start vyre" };
  if (h) {
    const s = await stop({ pid: h.pid });
    if (!s.ok) return { ok: false, note: s.why || "the running vyred did not stop; vyre down, then vyre up" };
  }
  const r = await ensureUp();
  if (!r.ok) return { ok: false, note: `vyred did not start; its output is in ${r.log}` };
  return { ok: true, note: h ? restarted : `started · pid ${r.pid}` };
}

/**
 * What `vyre up` needs from the world, so tests can stand in for each piece.
 * @typedef {{ ask(q: string): Promise<string>, tty: boolean }} IO
 * @typedef {{ io?: IO, bring?: typeof bring, call?: typeof call, health?: (box: string) => Promise<any>,
 *   save?: typeof config.save, openCapsule?: () => Promise<boolean>, addBox?: (target: string, opts: any) => Promise<number>,
 *   openUrl?: (url: string) => void, platform?: string }} Deps
 */

/** Questions on the person's own terminal. One readline per question, so nothing holds stdin open. */
export const terminal = {
  tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  async ask(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(q)).trim(); } finally { rl.close(); }
  },
};

/** Open a link in the browser. VYRE_OPEN_BIN points tests at a fake `open`; without one, tests open nothing. */
export function openUrl(url) {
  if (!process.env.VYRE_OPEN_BIN && !dialogsAllowed()) return;
  try { spawn(process.env.VYRE_OPEN_BIN || "open", [url], { detached: true, stdio: "ignore" }).unref(); } catch {}
}

/** An address as network.box holds it: https, no trailing slash. */
export const normalize = a => String(a).trim().replace(/^(?!https:\/\/)/, "https://").replace(/\/$/, "");

/**
 * @param {string[]} args
 * @param {Deps} [deps]
 */
export async function up(args, deps = {}) {
  if (!parse(args).flags.json) return run(args, deps);
  // A caller parsing --json gets one object whatever happens, so a throw anywhere is an error object too.
  try { return await run(args, deps); }
  catch (e) { one({ error: { code: "failed", message: String((e && /** @type {Error} */ (e).message) || e) } }); return 1; }
}

/**
 * @param {string[]} args
 * @param {Deps} deps
 */
async function run(args, deps) {
  const { flags } = parse(args);
  const json = Boolean(flags.json);
  if (flags.system) {
    // --system prints the plan it applies as it goes; there is no single object to give.
    if (json) { one({ error: { code: "bad_input", message: "--json does not go with --system" } }); return 1; }
    return upSystem(flags);
  }
  const callTool = deps.call || call;
  const platform = deps.platform || process.platform;
  // In JSON mode the one object is the whole output: no prose, no colour, and no questions.
  const say = json ? () => {} : out;
  /** @param {Record<string, any>} o */
  // Under --view the one object is a frame: the link, the box or where things stand, as a card.
  const done = (o, code = 0) => { if (json) { const d = { role, version: VERSION, url: null, port: null, ssh: null, address: null, box: null, ready: false, ...o }; one(d, upView(d)); } return code; };
  const fail = (code, message) => { if (json) one({ error: { code, message } }); else out(beacon("  " + message)); return 1; };

  if (flags.connect !== undefined && (flags.connect === true || !String(flags.connect).trim())) {
    return fail("no_address", "--connect needs your box's address: vyre up --connect https://vyre.<tailnet>.ts.net");
  }
  // The first `vyre up` on this machine: no store yet. It gets the welcome, not a status line.
  const first = !fs.existsSync(config.paths().db);
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
  // A real install on a Mac keeps its vault key in the login keychain. It says so in config, so
  // no other home ever reaches the login keychain by default (core/vault/vault.js).
  const v = cfg.vault || {};
  if (process.platform === "darwin" && isRealHome(config.home()) && dialogsAllowed() && v.keychain === undefined && !v.keystore) config.save({ vault: { keychain: true } });

  const b = await (deps.bring || bring)(role, deps.build);
  if (!b.ok) return fail("vyred_down", b.note || "vyred did not start");
  if (first) {
    say("");
    say(hello(build()));
    say("");
    say("  Vyre runs Claude Code on a machine you own, and gives it memory, a vault and a private");
    say("  address. Setting it up takes about ten minutes, one step at a time.");
    say(dim(`\n  vyred running in the background · your data lives in ${config.home().replace(os.homedir(), "~")}`));
  } else say(b.note ? `  vyred ${signal("running")} ${dim(`· ${VERSION} · ${role} · ${b.note}`)}` : `  vyred is already running ${dim(`· ${VERSION} · ${role}`)}`);

  if (systemdManaged()) {
    // An upgrade can change the units; only root can rewrite them.
    try {
      const me = os.userInfo().username, acct = account(me);
      const want = system.units({ user: me, group: acct.group, home: acct.home, node: process.execPath, pkg: REPO });
      if (fs.readFileSync(UNIT, "utf8") !== want["vyre.service"]) say(beacon("  the service unit is out of date: ") + "sudo vyre up --system --user " + me);
    } catch {}
  }

  if (role === "local") {
    return mac(config.load().network.box || null, { capsule: !flags["no-capsule"] && !json }, { ...deps, tool: callTool, json, say, done, fail });
  }

  // --keep-link (vyre update): report, mint nothing, so the link the user already has still works.
  const keep = Boolean(flags["keep-link"]);
  const link = await callTool("onboard.link", keep ? { mint: false } : {});
  if (link.error) return fail("onboarding_unavailable", "onboarding is not available: " + link.error.message);
  const d = link.data;
  const ssh = d.url ? sshLine(d.port, d.user) : null;
  if (keep && "pending" in d) {
    const left = d.pending && d.expires ? Math.max(1, Math.round((d.expires - Date.now()) / 60_000)) : 0;
    if (json) return done({ url: null, pending: Boolean(d.pending), expires: d.expires ?? null, address: d.address || null });
    say(d.pending ? `  set up is not finished; the link you have still works ${dim(`(${left} min left)`)}` : "  set up is not finished");
    say(dim(`  vyre up prints a new link${d.pending ? " and voids that one" : ""}`));
    return 0;
  }
  if (!d.url) {
    // After onboarding: the same ending the Mac prints, so "is it done?" has one answer. The box
    // cannot ask its own address (its listener refuses itself, ADR 0002), so it asks names.
    const n = await callTool("names.status");
    const ready = Boolean(d.address && n.data && n.data.phase === "serving");
    if (json) return done({ address: d.address || null, ready, passkeyUrl: d.passkeyUrl || null });
    if (d.address) {
      const f = await findAssistant(callTool).catch(() => ({}));
      printEnding({ address: d.address, assistant: f.agent ? f.agent.name : config.load().onboard?.assistant || null });
    }
    else say("  set up is done; there is no address yet (vyre name)");
    // No passkey yet: on a box it is the only way to prove it is you, so offer a fresh link to make one.
    if (d.passkeyUrl) say(`\n  Make your passkey ${dim("(from a device on your tailnet; the link works once, for 10 minutes)")}:\n    ${signal(d.passkeyUrl)}`);
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
  if (platform === "darwin" && !ssh && (deps.openUrl || dialogsAllowed())) {
    say(dim("  Opening it in your browser now."));
    (deps.openUrl || openUrl)(d.url);
  }
  return 0;
}

/** The view of vyre up's one object: the onboarding link, the box, or where things stand. @param {any} d */
function upView(d) {
  const fields = [{ label: "vyred", value: `${d.version} · ${d.role}` }];
  if (d.url) fields.push({ label: "Open this link to set up Vyre", value: String(d.url) });
  if (d.ssh) fields.push({ label: "This box is headless: on your own computer, first", value: String(d.ssh) });
  if (d.address) fields.push({ label: "Address", value: String(d.address) });
  if (d.box) fields.push({ label: "Your box", value: String(d.box) });
  if (d.pairing) fields.push({ label: "Pairing", value: String(d.pairing) });
  if (d.passkeyUrl) fields.push({ label: "Make your passkey", value: String(d.passkeyUrl) });
  if (!d.url && !d.box && !d.address && d.role === "local") fields.push({ label: "No box yet", value: "vyre box add user@host, vyre up --box, or vyre up --connect <address>" });
  return { kind: "card", title: d.ready ? "Vyre is ready" : "Vyre", state: d.ready ? "ok" : "wait", fields };
}

/**
 * `vyre up` on a Mac (ADR 0008 sections 1, 3 and 7). With no box known it looks on the tailnet
 * (link.find); one answer is taken, several are offered, none asks where Vyre should run. Then:
 * the box answers, this Mac is paired with it (link.pair, approved on the box), the Capsule is
 * opened, and the ending is printed. Every step says what to do when it cannot finish.
 * `deps` is for tests; `say`, `done` and `fail` come from up() so --json stays one object.
 * @param {string|null|undefined} box
 */
export async function mac(box, { capsule = true } = {}, deps = {}) {
  const {
    health = b => tailnet.probe(b),
    tool = call,
    platform = process.platform,
    save = config.save,
    io = terminal,
    json = false,
    say = out,
    fail = (_code, message) => { out(beacon("  " + message)); return 1; },
    done = () => 0,
    openCapsule = async () => {
      const c = await import("./capsule.js");
      // The native Capsule builds itself on first run, so its source is enough.
      if (!c.nativeAvailable()) return false;
      return (await c.default.run([])) === 0;
    },
    // Offered only on the person's own terminal, never under node --test: a test never reaches
    // the settings.json of whoever runs it.
    statusline = async () => { if (io === terminal && !process.env.NODE_TEST_CONTEXT) await (await import("./statusline.js")).offerStatusline({ interactive: true, io }); },
  } = /** @type {any} */ (deps);
  const asking = io.tty && !json;

  if (!box) {
    // No address known: look for the box on the tailnet. Exactly one is taken.
    const f = await tool("link.find");
    if (f.error && f.error.code === "not_real_home") say(dim(`  ${f.error.message}`));
    const found = (f.data && f.data.boxes) || [];
    if (found.length === 1) {
      box = found[0].address;
      save({ network: { box } });
      say(`  found your box on the tailnet: ${signal(box)}`);
    } else if (found.length > 1) {
      const list = found.map(x => x.address);
      if (json) return fail("several_boxes", `more than one Vyre box answers on your tailnet: ${list.join(", ")}. Pick one: vyre up --connect <address>`);
      say("  More than one Vyre box answers on your tailnet:");
      list.forEach((a, i) => say(`    ${i + 1}  ${a} ${dim(found[i].node || "")}`));
      if (!asking) { say(`  Pick one: ${dim("vyre up --connect <address>")}`); return 0; }
      const n = Number(await io.ask(`  Which one? (1-${list.length}) `));
      if (!Number.isInteger(n) || n < 1 || n > list.length) return fail("no_choice", "no box chosen; run vyre up again, or vyre up --connect <address>");
      box = list[n - 1];
      save({ network: { box } });
    } else {
      const t = await tailnet.status();
      if (!t.running) {
        // A box on a server is reached over the tailnet at the end, so this Mac needs it either way.
        say(beacon(`  ${t.why || "Tailscale is not running"}`) + (t.installed ? "" : dim(` · ${tailnet.DOWNLOAD}`)));
      }
      if (!asking) {
        say("  No Vyre box yet. Pick where it runs:");
        say(`    on a server you can SSH to   ${dim("vyre box add user@host")}`);
        say(`    on this Mac                  ${dim("vyre up --box")}`);
        say(`    you already set one up       ${dim("vyre up --connect <address>")}`);
        return done({});
      }
      return where(io, deps);
    }
  }

  const h = await health(box);
  if (!h) {
    const t = await tailnet.status();
    const why = !t.running ? `this Mac is not on the tailnet (${t.why || "Tailscale is not running"})` : "the box is offline or unreachable";
    if (json) return fail("box_unreachable", `your box ${box} did not answer from here: ${why}`);
    say(beacon(`  your box ${box} did not answer from here`) + dim(` · ${why}`));
    if (!t.running && !t.installed) say(dim(`  ${tailnet.DOWNLOAD}`));
    return 1;
  }

  const paired = await pair(box, tool, say);
  if (json) return done({ box, ready: paired !== "pending", ...(paired === "pending" ? { pairing: "waiting for approval" } : {}) });
  if (asking) await statusline().catch(() => {});
  if (capsule && platform === "darwin" && !(await openCapsule())) {
    say(`  the Capsule is not installed: ${signal("vyre capsule install")}`);
  }
  if (paired === "pending") {
    // Not ready until the box says yes: say what happens next instead of "Vyre is ready."
    say(dim("\n  Once you approve it, run vyre up again to finish."));
    return 0;
  }
  // The box's health does not name the assistant; the box does, over the link, once paired.
  let assistant = (h && h.assistant) || null;
  if (!assistant && paired === "linked") {
    const f = await findAssistant((name, input = {}) => tool("link.call", { tool: name, input })).catch(() => ({}));
    assistant = f.agent ? f.agent.name : null;
  }
  printEnding({ address: box, assistant });
  return 0;
}

/**
 * Pair this Mac with the box, or say where pairing stands. The link module owns the mechanics:
 * the Mac shows a code and the box's owner approves it (ADR 0008 section 7; `vyre box add`
 * approves it itself over SSH). Resolves "linked", "pending" (a code is waiting for approval),
 * or "unknown" (a vyred without the link module, or an error already said).
 * @returns {Promise<"linked" | "pending" | "unknown">}
 */
async function pair(box, tool, say) {
  const s = await tool("link.status");
  if (s.error) {
    if (s.error.code !== "no_such_tool") say(beacon("  cannot read the link: ") + s.error.message);
    return "unknown";
  }
  if (s.data.linked) { say(`  ${signal("linked")} ${dim("· this Mac and your box work as one")}`); return "linked"; }
  let code = s.data.pending && s.data.pending.code;
  if (!code) {
    const p = await tool("link.pair", { box });
    if (p.error) say(beacon("  pairing did not start: ") + p.error.message + dim(" · vyre link pair " + box));
    code = p.data && p.data.code;
  }
  if (code) {
    say("");
    say(`  Approve this Mac on your phone at ${signal(box)}, or in the Deck on this Mac`);
    say(`  The Deck there names this Mac (${os.hostname()}) and asks for your passkey. Code: ${signal(code)}`);
    say(dim("  vyre link shows when it is done."));
    return "pending";
  }
  return "unknown";
}

/** "Where should Vyre run?", asked on a Mac that knows no box and found none. */
async function where(io, deps) {
  out("");
  out(`  ${bold("Where should Vyre run?")}`);
  out("");
  out(`    1  On a server I can SSH to ${dim("(recommended)")}`);
  out(dim("       Vyre installs itself there and keeps working when this Mac sleeps."));
  out("    2  On this Mac");
  out(dim("       The quickest way to try it. It pauses when this Mac sleeps."));
  out("    3  I already set up a box");
  out(dim("       Pair this Mac with it."));
  out("");
  const choice = (await io.ask("  1, 2 or 3? ")).trim();
  if (choice === "1") {
    const target = (await io.ask("  server (user@host): ")).trim();
    if (!target) { out(beacon("  no server given")); return 1; }
    // Lazily, so `vyre up` loads whatever state box.js is in.
    const add = deps.addBox || (await import("./box.js")).add;
    return add(target, {});
  }
  if (choice === "2") return up(["--box"], deps);
  if (choice === "3") {
    out(dim("  Its address is on the box's last screen, and in the Deck: https://<name>.<tailnet>.ts.net"));
    const a = (await io.ask("  Your box's address: ")).trim();
    if (!a) { out(beacon("  no address given") + dim(" · vyre up --connect <address> when you have it")); return 1; }
    out(dim(`  Asking ${normalize(a)} to pair with this Mac.`));
    return up(["--connect", a], deps);
  }
  out(beacon("  nothing chosen") + dim(" · vyre box add user@host, vyre up --box, or vyre up --connect <address>"));
  return 1;
}

/**
 * vyre up's one JSON object: a line through out (as its tests read it), or under --view a frame
 * with `view` (derived when left out, so an {error} is an error frame).
 * @param {any} d @param {any} [view]
 */
function one(d, view) {
  if (viewing()) emit(d, view);
  else out(JSON.stringify(d));
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
    name: "up", order: 10, usage: "vyre up [--box] [--connect <addr>] [--no-capsule] [--keep-link] [--dry-run] [--json]", summary: "start vyred and print the onboarding link, or this box's address",
    run: args => up(args),
  },
  {
    name: "uninstall", order: 95, hidden: true, usage: "vyre uninstall --system [--purge] [--dry-run]", summary: "remove the systemd units (the data stays unless --purge)",
    async run(args) {
      const { flags } = parse(args);
      if (!flags.system) return usage("vyre uninstall needs --system", "vyre uninstall --system [--purge] [--dry-run]");
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
    async run(args) {
      const [file] = args.filter(a => a !== "--json");
      const target = path.resolve(file || `vyre-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`);
      const r = await backup({ root: config.home(), file: target });
      if (json()) {
        return emit(r, { kind: "card", title: "Backup", state: "ok", fields: [{ label: "File", value: String(r.file) }, { label: "Size", value: `${Math.round(r.bytes / 1024)} KB` },
          { label: "Holds", value: r.included.join(", ") }, { label: "Keep it", value: "somewhere only you can read: it holds the sealed vault" }] });
      }
      out(`  ${signal(r.file)} ${dim(`· ${Math.round(r.bytes / 1024)} KB · ${r.included.join(", ")}`)}`);
      out(dim("  it holds the sealed vault: keep it somewhere only you can read"));
      return 0;
    },
  },
  {
    name: "restore", order: 81, hidden: true, usage: "vyre restore <file> [--force]", summary: "put a backup back (vyred must be stopped)",
    async run(args) {
      const { flags, rest } = parse(args);
      if (!rest[0]) return usage("vyre restore needs the backup file", "vyre restore <file> [--force]");
      try { await restore({ root: config.home(), file: path.resolve(rest[0]), force: Boolean(flags.force) }); }
      catch (e) {
        const m = String(/** @type {Error} */ (e).message);
        return fail(m, { next: /already exists/.test(m) ? `vyre restore ${rest[0]} --force, to replace it` : /is running/.test(m) ? "vyre down, then try again" : undefined });
      }
      if (json()) return emit({ restored: path.resolve(rest[0]) });
      out("  restored · vyre up to start");
      return 0;
    },
  },
  {
    name: "name", order: 30, usage: "vyre name [status|check <n>|claim <n>|ts.net|release] [--json]", summary: "this box's address: <you>.vyre.run",
    verbs: [
      { verb: "status", summary: "this box's address and where it stands", usage: "", read: true },
      { verb: "check", summary: "whether a name is free", usage: "<n>", read: true },
      { verb: "claim", summary: "take <n>.vyre.run for this box", usage: "<n>" },
      { verb: "ts.net", summary: "use the tailnet's own ts.net address instead", usage: "" },
      { verb: "release", summary: "give the name back", usage: "", person: true },
    ],
    async run(args) {
      const [action0, name] = args.filter(a => a !== "--json");
      const action = action0 === "status" ? undefined : action0;
      const TOOLS = { check: "names.check", claim: "names.claim", "ts.net": "names.fallback", release: "names.release" };
      if (action && !(action in TOOLS)) return usage(`vyre name ${action}: not a subcommand`, "vyre name [status|check <n>|claim <n>|ts.net|release]");
      if ((action === "check" || action === "claim") && !name) return usage(`vyre name ${action} needs a name`, `vyre name ${action} alex`);
      const tool = TOOLS[/** @type {keyof typeof TOOLS} */ (action || "")] || "names.status";
      const r = await call(tool, name ? { name } : {});
      if (r.error) return failTool(r.error);
      const d = r.data;
      if (json()) {
        if (tool === "names.check") return emit(d, { kind: "card", title: String(d.name), state: d.valid && d.available ? "ok" : "failed", fields: [{ label: d.valid && d.available ? "Free" : "Not free", value: d.valid && d.available ? String(d.address) : String(d.why || "") }] });
        return emit(d, { kind: "card", title: "Address", state: d.phase === "serving" ? "ok" : "wait", fields: [{ label: "Address", value: d.address || "no address" }, { label: "Phase", value: String(d.phase || "") },
          ...(d.owner ? [{ label: "Owner", value: String(d.owner) }] : []), ...(d.why ? [{ label: "Why", value: String(d.why) }] : [])] });
      }
      if (tool === "names.check") out(d.valid && d.available ? `  ${signal(d.address)} is free` : beacon(`  ${d.name}: ${d.why}`));
      else out(`  ${d.address ? signal(d.address) : dim("no address")} ${dim(`· ${d.phase}${d.owner ? " · owner " + d.owner : ""}${d.why ? " · " + d.why : ""}`)}`);
      return 0;
    },
  },
  {
    name: "owner", order: 31, hidden: true, usage: "vyre owner [<tailscale-login>]", summary: "the one Tailscale login this box serves",
    async run(args) {
      // --json is a flag, never a login: `vyre owner --json` once made "--json" the owner.
      const [login] = args.filter(a => a !== "--json");
      if (!login) {
        const s = await call("names.status");
        if (s.error) return failTool(s.error);
        if (json()) return emit({ owner: s.data.owner || null });
        out(`  ${s.data.owner || "no owner yet"}`);
        return 0;
      }
      const r = await call("names.owner", { login });
      if (r.error) return failTool(r.error);
      if (json()) return emit(r.data);
      out(`  owner: ${signal(login)}`);
      return 0;
    },
  },
];
