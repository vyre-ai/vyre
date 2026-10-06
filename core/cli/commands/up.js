// @ts-check
// `vyre up` and the box's system commands.
//
// `vyre up` is the one command a person types. It starts vyred (or restarts it after an upgrade),
// then prints one thing: on a server whether it is paired (and how to pair it), or on a Mac the box it talks to.
// `vyre up --system` (as root) installs the systemd units; `vyre uninstall --system` removes them.
// Both print every change and make none with --dry-run. See docs/INSTALL.md and ADR 0002.
//
// --json shapes: up {role, version, url, port, ssh, address, box, ready, ...} or {error} ·
// backup {file, bytes, included} · restore {restored} · name {address, phase, owner?, why?} and
// name check {name, valid, available, address?, why?} · owner {owner}. Only `vyre name` has verbs.

import { windowsHome } from "../../daemon/host-guard.js";
import { isPackaged } from "../../../kernel/devbuild.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { request, call } from "../../daemon/client.js";
import { ensureUp, stop } from "../daemonctl.js";
import { REPO, VERSION } from "../../daemon/index.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, fail, failTool, usage, viewing, openInBrowser } from "../kit.js";
import * as config from "../../config/index.js";
import { dialogsAllowed, isRealHome, realBoxAllowed } from "../../config/dialogs.js";
import * as system from "../../names/system.js";
import { wallSteps, wallUninstallSteps } from "../../../lib/sandbox/index.js";
import { backup, restore, estimate, planRestore, isStream, inspect as inspectSealed } from "../../names/backup.js";
import { hiddenPrompt } from "../../vault/cli-io.js";
import { probe as probeBox } from "../probe.js";
import { printEnding } from "../ending.js";
import { hello } from "../brand.js";
import { findAssistant } from "./assistant.js";
import { pairHere } from "./pair-here.js";
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
 * A backup passphrase (R8): typed twice, hidden, on a real terminal; one line, unhidden, when
 * stdin is piped (scripted use, e2e2's matrix, `vyre setup --name ... --yes`'s own automation).
 * @param {string} question @param {{ confirm?: boolean }} [opts]
 */
export async function readPassphrase(question, { confirm = false } = {}) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    const { value: line } = await rl[Symbol.asyncIterator]().next();
    rl.close();
    if (line == null || !line.trim()) throw new Error("no passphrase piped on stdin");
    return line.trim();
  }
  const a = await hiddenPrompt(question);
  if (confirm) {
    const b = await hiddenPrompt("again: ");
    if (a !== b) throw new Error("the two did not match");
  }
  return a;
}

const UNIT = path.join(system.ETC, "vyre.service");
/** The folders that hold this machine's session transcripts, as config.json names them, the ones that exist. */
const transcriptRoots = () => (config.load().transcripts || []).filter(r => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
const systemdManaged = () => process.platform === "linux" && fs.existsSync(UNIT);

/** vyred's /v1/health, or null when it does not answer. */
export async function health() { const h = await request("GET", "/v1/health"); return h.error ? null : h.data; }

/** Wait for vyred to answer with the wanted version and build (after systemd restarts it). */
export async function waitFor(version, ms = 15_000, commit = null) {
  for (let t = 0; t < ms; t += 250) {
    const h = await health();
    if (h && h.version === version && (!commit || h.commit === commit)) return h;
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

/**
 * Start vyred, or restart it when it runs an older version or the wrong role. `mineOf` names the
 * build that should be running: this package's own, or for `vyre update` the release it just
 * installed, since this process still holds the old code and the old version number.
 */
export async function bring(role, mineOf = build) {
  { const w = windowsHome({ packaged: isPackaged() }); if (!w.ok) return { ok: false, note: w.why }; } // no home on Windows until 0.3.0
  const h = await health();
  // A release is stamped with its commit (build.json). An upgrade that keeps the version number
  // still changes the commit, and the vyred started before it runs the old code: that one is
  // restarted, as is one whose build is dirty or unknown. A checkout (no stamp) compares versions.
  const mine = mineOf();
  const sameBuild = !mine.stamped || (h && h.commit === mine.commit && h.dirty === false && mine.dirty === false);
  if (h && h.version === mine.version && h.role === role && sameBuild) return { ok: true, note: null };
  const was = h ? label({ version: h.version, commit: h.commit ?? null, dirty: h.dirty ?? null }) : "";
  const now = label(mine);
  const restarted = h && h.version === mine.version && !sameBuild ? `updated · restarted vyred (${was} → ${now})` : `restarted ${was} → ${now}`;
  if (h && h.supervisor === "systemd") {
    // systemd restarts it (Restart=always) with the code npm just installed.
    try { process.kill(h.pid, "SIGTERM"); } catch {}
    const back = await waitFor(mine.version, 15_000, mine.stamped ? mine.commit : null);
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
 *   openUrl?: (url: string) => void, platform?: string, sleep?: (ms: number) => Promise<void> }} Deps
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
  openInBrowser(url);
}

/** A box on this machine's own loopback (a dev world or a test's): never the person's real box. */
function loopbackBox(box) {
  try { const h = new URL(String(box)).hostname; return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1"; } catch { return false; }
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

/** Common, obviously-not-a-secret .env values: no point nudging over these. */
const ENV_NOT_SECRET = new Set(["true", "false", "development", "production", "test", "staging", "localhost", "debug", "info", "warn", "error"]);

/**
 * A rough, local count of .env values in `dir` that look like secrets and are not already a
 * vault:// reference - no vault call, so no presence and no network: just enough to nudge
 * (vault sweep and vault import do the real, careful work). Top-level .env* files only.
 * @param {string} dir
 */
export function envCandidates(dir) {
  let n = 0;
  for (const name of [".env", ".env.local", ".env.development", ".env.production"]) {
    let text;
    try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      if (v.length < 10 || v.startsWith("vault://") || /^\d+$/.test(v) || ENV_NOT_SECRET.has(v.toLowerCase())) continue;
      n++;
    }
  }
  return n;
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
    return fail("no_address", "--connect needs your box's address: vyre up --connect https://<name>.vyre.run");
  }
  // The first `vyre up` on this machine: no store yet. It gets the welcome, not a status line.
  const first = !fs.existsSync(config.paths().db);
  const cfg = config.load();
  let role = cfg.role;
  if (flags.box) role = "box";
  if (flags.local || flags.connect) role = "local";
  if (flags["dry-run"]) {
    say(`  would start vyred ${VERSION} as ${os.userInfo().username}, role ${role}, home ${config.home()}`);
    say(`  would then print ${role === "box" ? "whether this server is paired" : "the box this machine talks to"}`);
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
  if (!first) {
    const found = envCandidates(process.cwd());
    if (found) say(dim(`  found ${found} secret-looking value${found === 1 ? "" : "s"} in .env here, not in the vault yet · vyre vault import . --rewrite brings them in`));
  }

  if (systemdManaged()) {
    // An upgrade can change the units; only root can rewrite them.
    try {
      const me = os.userInfo().username, acct = account(me);
      const want = system.units({ user: me, group: acct.group, home: acct.home, node: process.execPath, pkg: REPO });
      if (fs.readFileSync(UNIT, "utf8") !== want["vyre.service"]) say(beacon("  the service unit is out of date: ") + "sudo vyre up --system --user " + me);
    } catch {}
  }

  if (role === "local") {
    // Nothing is sent to a box from here: pairing is a code (vyre link pair <code>). --connect only saves the address (onboarding's choice 3 comes this way too).
    return mac(config.load().network.box || null, { capsule: !flags["no-capsule"] && !json, pair: Boolean(flags.connect) }, { ...deps, tool: callTool, json, say, done, fail });
  }

  // A server has no first-run page and no one-time link (the kernel is always on): the way in is pairing. Say whether it is paired, and if not, where the code comes from.
  // `--keep-link` (passed by vyre update) is accepted and changes nothing.
  let st = await callTool("wink.server.status");
  // A daemon with the whole signed module list answers on its socket before every module has started: the tool is "not there" for a few seconds, then it is. Wait (a minute at most).
  for (let tries = 0; st.error && st.error.code === "no_such_tool" && tries < 30; tries++) {
    await (deps.sleep || ((/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms))))(2000);
    st = await callTool("wink.server.status");
  }
  if (st.error) return fail("pairing_unavailable", "pairing is not available on this server: " + st.error.message);
  const s = st.data || {};
  if (s.owned) {
    if (json) return done({ paired: true, space: s.space || null, ready: true });
    say(`  paired to ${signal(String(s.space || "your space"))}${s.device ? dim(` · by ${s.device}`) : ""}`);
    return 0;
  }
  if (json) return done({ paired: false, ready: false, pairing: "vyre call wink.server.code '{\"qr\":true}'" });
  // Not paired yet and on a terminal: show the pairing here, the same one the installer shows (pair-here.js: the QR, the long code and the typed code, then the code the app shows typed back).
  const io = deps.io || terminal;
  if (io.tty && !flags["keep-link"]) { await pairHere({ tool: callTool, io, say, ...(deps.sleep ? { sleep: deps.sleep } : {}) }); return 0; }
  say(`  not paired yet. Pair this server from your Vyre app: run ${signal("vyre call wink.server.code '{\"qr\":true}'")} here, then scan the QR or paste the long code.`);
  return 0;
}

/** The view of vyre up's one object: the pairing state, the box, or where things stand. @param {any} d */
function upView(d) {
  const fields = [{ label: "vyred", value: `${d.version} · ${d.role}` }];
  if (d.paired !== undefined) fields.push({ label: "Paired", value: d.paired ? String(d.space || "yes") : "not yet" });
  if (d.address) fields.push({ label: "Address", value: String(d.address) });
  if (d.box) fields.push({ label: "Your box", value: String(d.box) });
  if (d.pairing) fields.push({ label: "Pairing", value: String(d.pairing) });
  if (!d.box && !d.address && d.role === "local") fields.push({ label: "No box yet", value: "vyre box add user@host, vyre up --box, or vyre up --connect <address>" });
  return { kind: "card", title: d.ready ? "Vyre is ready" : "Vyre", state: d.ready ? "ok" : "wait", fields };
}

/**
 * `vyre up` on a Mac (ADR 0008 sections 1, 3 and 7). With no box known it asks where Vyre should run. Then:
 * the box answers, this Mac is paired with it (wink.server.home; pairing is `vyre link pair <code>`), the Capsule is
 * opened, and the ending is printed. Every step says what to do when it cannot finish.
 * `deps` is for tests; `say`, `done` and `fail` come from up() so --json stays one object.
 * @param {string|null|undefined} box
 */
export async function mac(box, { capsule = true, pair: asked = false } = {}, deps = {}) {
  const {
    health = b => probeBox(b),
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
    // May this home talk to that box? Tests stand in for the rule (they run under node --test).
    mayReach = () => realBoxAllowed(config.home()),
    statusline = async () => { if (io === terminal && !process.env.NODE_TEST_CONTEXT) await (await import("./statusline.js")).offerStatusline({ interactive: true, io }); },
  } = /** @type {any} */ (deps);
  const asking = io.tty && !json;

  if (!box) {
    // No address known: ask where Vyre should run.
    if (!asking) {
      say("  No Vyre box yet. Pick where it runs:");
      say(`    on a server you can SSH to   ${dim("vyre box add user@host")}`);
      say(`    on this Mac                  ${dim("vyre up --box")}`);
      say(`    you already set one up       ${dim("vyre up --connect <address>")}`);
      return done({});
    }
    return where(io, deps);
  }

  const h = await health(box);
  if (!h) {
    const why = "the box is offline or unreachable";
    if (json) return fail("box_unreachable", `your box ${box} did not answer from here: ${why}`);
    say(beacon(`  your box ${box} did not answer from here`) + dim(` · ${why}`));
    return 1;
  }

  // A temp or dev home never talks to a real box unless its owner says so (core/config/dialogs.js).
  if (!loopbackBox(box) && !mayReach(box)) {
    const why = `this home (${config.home()}) is not ~/.vyre, so it does not talk to a real box; set VYRE_ALLOW_REAL_BOX=1 if you mean it`;
    if (json) return fail("not_real_home", why);
    say(beacon("  " + why));
    return 1;
  }
  const paired = await pair(box, tool, say);
  if (json) return done({ box, ready: paired !== "unpaired", ...(paired === "unpaired" ? { pairing: "vyre link pair <code>, with the code the server shows" } : {}) });
  if (asking) await statusline().catch(() => {});
  if (capsule && platform === "darwin" && !(await openCapsule())) {
    say(`  the Capsule is not installed: ${signal("vyre capsule install")}`);
  }
  if (paired === "unpaired") {
    say(dim(`\n  This Mac is not paired with ${box} yet. On the server, run: vyre call wink.server.code '{"qr":true}', then here: vyre link pair <code>`));
    return 0;
  }
  // The box's health does not name the assistant; the box does, over the link, once paired.
  let assistant = (h && h.assistant) || null;
  if (!assistant && paired === "linked") {
    const f = await findAssistant((name, input = {}) => tool("wink.server.call", { tool: name, input })).catch(() => ({}));
    assistant = f.agent ? f.agent.name : null;
  }
  printEnding({ address: box, assistant });
  return 0;
}

/**
 * Say whether this Mac is paired with its box. Pairing is Wink's: the server shows a code (a typed WINK code, or the QR's long code) at its own terminal,
 * the person gives it here (`vyre link pair <code>`), and confirms three words at the server. There is nothing to start from the Mac by address alone.
 * Resolves "linked" or "unpaired", or "unknown" (a vyred without the Wink module, or an error already said).
 * @param {string} box @param {any} tool @param {(s: string) => void} say
 * @returns {Promise<"linked" | "unpaired" | "unknown">}
 */
async function pair(box, tool, say) {
  const s = await tool("wink.server.home");
  if (s.error) {
    if (s.error.code !== "no_such_tool") say(beacon("  cannot read the link: ") + s.error.message);
    return "unknown";
  }
  if (s.data.linked) { say(`  ${signal("linked")} ${dim("· this Mac and your box work as one")}`); return "linked"; }
  return "unpaired";
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
    out(dim("  Its address is on the box's last screen, and in the Deck: https://<name>.vyre.run"));
    const a = (await io.ask("  Your box's address: ")).trim();
    if (!a) { out(beacon("  no address given") + dim(" · vyre up --connect <address> when you have it")); return 1; }
    out(dim(`  Saved ${normalize(a)}. To pair this Mac with it: on the server run vyre call wink.server.code '{"qr":true}', then here run vyre link pair <code>.`));
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
    hasUnit: seen.units, systemd: seen.systemd, wall: wallSteps() });
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
      await system.apply(system.uninstallPlan({ purge: Boolean(flags.purge), home, wall: process.platform === "linux" ? wallUninstallSteps() : [] }), { dryRun, out: l => out("  " + l) });
      return 0;
    },
  },
  {
    name: "daemon", order: 96, hidden: true, summary: "run vyred in the foreground (what systemd runs)",
    async run() { await import("../../daemon/main.js"); return new Promise(() => {}); },
  },
  {
    name: "backup", order: 80, usage: "vyre backup [file] [--skip-projects] [--skip-transcripts] [--work DIR] [--with-provider-logins]",
    summary: "seal your data, project files and session transcripts into one passphrase-locked file (an unfinished one resumes)",
    async run(args) {
      const { flags, rest } = parse(args, ["user", "connect", "work"]);
      const target = path.resolve(rest[0] || `vyre-backup-${new Date().toISOString().slice(0, 10)}.vyre`);
      // Project files: the box's /work by default, or the folder named. A Mac with none has only its data.
      const skip = Boolean(flags["skip-projects"]) || process.env.VYRE_BACKUP_SKIP_PROJECTS === "1";
      const workRoot = typeof flags.work === "string" ? path.resolve(flags.work) : config.workDir();
      const roots = fs.existsSync(workRoot) && fs.statSync(workRoot).isDirectory() ? [workRoot] : [];
      // The folders holding session transcripts (Claude Code's, and the synced copies) ride along unless left out.
      const skipT = Boolean(flags["skip-transcripts"]) || process.env.VYRE_BACKUP_SKIP_TRANSCRIPTS === "1";
      const tRoots = skipT ? [] : transcriptRoots();
      const est = estimate({ root: config.home(), workRoots: [...(skip ? [] : roots), ...tRoots] });
      const mb = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${Math.round(n / 1024 / 1024)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;
      if (!json()) {
        out(dim(`  your data: ${mb(est.state)}` + (skip ? " · project files skipped" : roots.length ? ` · project files in ${workRoot}: ${mb(est.work[0].bytes)} (${est.work[0].files} files)` : " · no project folder here")
          + (skipT ? " · transcripts skipped" : tRoots.length ? ` · transcripts: ${mb(est.work.slice(skip ? 0 : roots.length).reduce((n, w) => n + w.bytes, 0))}` : " · no transcripts found")));
        if (est.total - est.state > 1024 ** 3) out(dim("  that is a lot: add --skip-projects if they live in git or Drive, or --skip-transcripts"));
      }
      let passphrase;
      try { passphrase = await readPassphrase("backup passphrase (12 characters or more): ", { confirm: true }); }
      catch (e) { return fail(String(/** @type {Error} */ (e).message)); }
      let last = 0;
      const onProgress = process.stderr.isTTY && !json() ? p => { const now = Date.now(); if (p.total && now - last > 2000) { last = now; process.stderr.write(`\r  ${Math.min(100, Math.round(p.done / p.total * 100))}% of the project files `); } } : undefined;
      let r;
      try { r = await backup({ root: config.home(), file: target, passphrase, includeProviderLogins: Boolean(flags["with-provider-logins"]), work: { roots, skip, transcripts: tRoots, skipTranscripts: skipT }, onProgress }); }
      finally { passphrase = ""; if (onProgress) process.stderr.write("\r\x1b[K"); }
      const holds = r.included.join(", ") + (r.projects.length ? `, project files (${r.projects.map(p => p.name).join(", ")})` : "")
        + (r.excludedLogins.length ? ` (left out: ${r.excludedLogins.join(", ")}, sign in again after restoring, or pass --with-provider-logins next time)` : "");
      const size = mb(r.bytes);
      if (json()) {
        return emit({ ...r, estimate: est }, { kind: "card", title: "Backup", state: "ok", fields: [{ label: "File", value: String(r.file) }, { label: "Size", value: size },
          { label: "Holds", value: holds }, { label: "Keep it", value: "somewhere only you can read: it opens only with that passphrase" }] });
      }
      out(`  ${signal(r.file)} ${dim(`· ${size} · ${holds}${r.resumed ? " · picked up an unfinished export" : ""}`)}`);
      for (const w of r.warnings) out(dim(`  note: ${w}`));
      out(dim("  it opens only with that passphrase; keep the two apart"));
      return 0;
    },
  },
  {
    name: "restore", order: 81, hidden: true, usage: "vyre restore <file> [--force] [--skip-projects] [--skip-transcripts] [--work-to DIR]", summary: "put a backup back (vyred must be stopped)",
    async run(args) {
      const { flags, rest } = parse(args, ["user", "connect", "work-to"]);
      if (!rest[0]) return usage("vyre restore needs the backup file", "vyre restore <file> [--force]");
      const file = path.resolve(rest[0]);
      let v2 = false;
      try {
        const fd = fs.openSync(file, "r"); const head = Buffer.alloc(8192);
        let n = 0; try { n = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
        v2 = isStream(head.subarray(0, n));
        const { header } = inspectSealed(v2 ? head.subarray(0, n) : fs.readFileSync(file));
        out(dim(`  backup from ${new Date(header.at).toISOString().slice(0, 10)} · ${Math.round(fs.statSync(file).size / 1024)} KB sealed`));
      } catch (e) { return fail(`${file} is not a sealed Vyre backup: ${String(/** @type {Error} */ (e).message)}`); }
      let passphrase;
      try { passphrase = await readPassphrase("backup passphrase: "); }
      catch (e) { return fail(String(/** @type {Error} */ (e).message)); }
      let r;
      try {
        // --work-to DIR: where the project files go, when it is not where they came from. Each
        // project gets a folder of its own name inside it.
        const workTo = typeof flags["work-to"] === "string" ? new Proxy({}, { get: (_, name) => typeof name === "string" ? path.resolve(String(flags["work-to"]), name) : undefined }) : undefined;
        // Where the project files will go, said before anything is written (and refused if it is not allowed).
        if (v2) {
          const plan = planRestore({ file, passphrase, workTo, skipProjects: Boolean(flags["skip-projects"]), skipTranscripts: Boolean(flags["skip-transcripts"]), projectRoots: [config.workDir(), ...transcriptRoots()] });
          if (!json()) for (const p of plan.projects) out(dim(`  project files "${p.name}" -> ${p.to} (${p.files} files)`));
        }
        r = await restore({ root: config.home(), file, passphrase, force: Boolean(flags.force), skipProjects: Boolean(flags["skip-projects"]), skipTranscripts: Boolean(flags["skip-transcripts"]), projectRoots: [config.workDir(), ...transcriptRoots()], workTo });
      }
      catch (e) {
        const m = String(/** @type {Error} */ (e).message);
        return fail(m, { next: /already exists/.test(m) ? `vyre restore ${rest[0]} --force, to replace it` : /is running/.test(m) ? "vyre down, then try again" : undefined });
      }
      finally { passphrase = ""; }
      if (json()) return emit({ restored: path.resolve(rest[0]), projects: r.projects, publicLinks: "as they were when the backup was made" });
      out("  restored · vyre up to start");
      if (r.restored && r.restored.includes("data")) out(dim("  artifacts are back with their versions; public links return as they were when the backup was made, so a link that was on then is on again"));
      return 0;
    },
  },
  {
    name: "name", order: 30, usage: "vyre name [status|check <n>|claim <n>|release] [--json]", summary: "this box's address: <you>.vyre.run",
    verbs: [
      { verb: "status", summary: "this box's address and where it stands", usage: "", read: true },
      { verb: "check", summary: "whether a name is free", usage: "<n>", read: true },
      { verb: "claim", summary: "take <n>.vyre.run for this box", usage: "<n>" },
      { verb: "release", summary: "give the name back", usage: "", person: true },
    ],
    async run(args) {
      const [action0, name] = args.filter(a => a !== "--json");
      const action = action0 === "status" ? undefined : action0;
      const TOOLS = { check: "names.check", claim: "names.claim", release: "names.release" };
      if (action && !(action in TOOLS)) return usage(`vyre name ${action}: not a subcommand`, "vyre name [status|check <n>|claim <n>|release]");
      if ((action === "check" || action === "claim") && !name) return usage(`vyre name ${action} needs a name`, `vyre name ${action} alex`);
      const tool = TOOLS[/** @type {keyof typeof TOOLS} */ (action || "")] || "names.status";
      const r = await call(tool, name ? { name } : {});
      if (r.error) return failTool(r.error);
      const d = r.data;
      if (json()) {
        if (tool === "names.check") return emit(d, { kind: "card", title: String(d.name), state: d.valid && d.available ? "ok" : "failed", fields: [{ label: d.valid && d.available ? "Free" : "Not free", value: d.valid && d.available ? String(d.address) : String(d.why || "") }] });
        return emit(d, { kind: "card", title: "Address", state: d.phase === "serving" || d.phase === "named" ? "ok" : "wait", fields: [{ label: "Name", value: d.name ? `${d.name}.vyre.run` : "none yet" }, { label: "Address", value: d.address || "not published yet" }, { label: "Phase", value: String(d.phase || "") },
          ...(d.why ? [{ label: "Why", value: String(d.why) }] : [])] });
      }
      if (tool === "names.check") out(d.valid && d.available ? `  ${signal(d.address)} is free` : beacon(`  ${d.name}: ${d.why}`));
      else out(`  ${d.address ? signal(d.address) : d.name ? signal(`${d.name}.vyre.run`) : dim("no name")} ${dim(`· ${d.phase}${d.why ? " · " + d.why : ""}`)}`);
      return 0;
    },
  },
];
