// @ts-check
// `vyre box`: put Vyre on a server from the Mac, and look after it from there (ADR 0008
// sections 2 and 8). Everything on the server happens over SSH (../ssh.js), so the person never
// opens a shell on it. `vyre box add` is also what `vyre up` runs when the person says "a server".
//
// Every step is worked out from what the server says, not from what this command remembers, so
// running `vyre box add` again after a Ctrl-C carries on from where the box stands.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as config from "../../config/index.js";
import * as tailnet from "../tailnet.js";
import { remote, quote, line, validTarget } from "../ssh.js";
import { ensureUp } from "../daemonctl.js";
import { call } from "../../daemon/client.js";
import { VERSION } from "../../daemon/index.js";
import { printEnding } from "../ending.js";
import { out, dim, signal, beacon } from "../style.js";

const INSTALLER = fileURLToPath(new URL("../../../scripts/install-box.sh", import.meta.url));
const VOLUMES = ["vyre-home", "vyre-work", "tailscale-state"];
const LABELS = { you: "You", claude: "Claude Code", tailscale: "Tailscale", name: "Your address", history: "Your history", devices: "Your devices" };

// A remote script's first lines: the stack folder, and whether this account reaches Docker itself
// or through sudo (a fresh Docker install leaves the account out of the docker group).
const PRELUDE = 'DIR=${VYRE_DIR:-/srv/vyre}; if docker info >/dev/null 2>&1; then D=""; else D="sudo -n"; fi';

/**
 * Local settings the server's commands should see too. VYRE_WRAPPER moves the host wrapper, so a
 * second stack on a server (a test one beside the person's own) never replaces theirs.
 */
function passEnv(env = process.env) {
  return ["VYRE_DIR", "VYRE_BOX_URL", "VYRE_WRAPPER"].filter(k => env[k]).map(k => `${k}=${env[k]}`);
}

/** A POSIX sh script, run on the server with this Mac's VYRE_DIR and VYRE_BOX_URL. */
export function script(body, env = process.env) {
  return line("env", ...passEnv(env), "sh", "-c", `${PRELUDE}\n${body}`);
}

/** The host's `vyre` wrapper, through sudo when the account cannot reach Docker. */
export function vyre(args, env = process.env) {
  return script(`exec $D env VYRE_DIR="$DIR" vyre ${args.map(quote).join(" ")}`, env);
}

// ---- look before touching (step 3) ----

export const PREFLIGHT = [
  'echo "os=$(uname -s)"',
  'echo "docker=$(docker compose version --short 2>/dev/null || echo none)"',
  'if [ "$(id -u)" = 0 ]; then echo sudo=root; elif sudo -n true 2>/dev/null; then echo sudo=yes; else echo sudo=no; fi',
  'if [ -c "${VYRE_TUN:-/dev/net/tun}" ]; then echo tun=yes; else echo tun=no; fi',
  'if [ -f "$DIR/compose.yml" ]; then echo box=yes; else echo box=no; fi',
  'echo "distro=$( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"',
  'echo "dir=$DIR"',
  'echo "user=$(id -un)"',
  'if id -nG | tr " " "\\n" | grep -qx docker; then echo docker_group=yes; else echo docker_group=no; fi',
  'echo "volumes=$($D docker volume ls -q --filter label=com.docker.compose.project=vyre 2>/dev/null | tr "\\n" " ")"',
].join("\n");

/**
 * @typedef {{ os: string, docker: string|null, sudo: "root"|"yes"|"no", tun: boolean, box: boolean, distro: string, dir: string,
 *   user: string, dockerGroup: boolean, volumes: string[] }} Preflight
 * @param {string} text key=value lines
 * @returns {Preflight}
 */
export function parsePreflight(text) {
  const kv = Object.fromEntries(String(text).split("\n").map(l => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
  return {
    os: kv.os || "", docker: kv.docker && kv.docker !== "none" ? kv.docker : null,
    sudo: kv.sudo === "root" || kv.sudo === "yes" ? kv.sudo : "no",
    tun: kv.tun === "yes", box: kv.box === "yes", distro: kv.distro || "", dir: kv.dir || "/srv/vyre",
    user: kv.user || "", dockerGroup: kv.docker_group === "yes", volumes: (kv.volumes || "").split(/\s+/).filter(Boolean),
  };
}

/**
 * Must the account join the docker group? When sudo needs a password, every later call over SSH
 * (which cannot ask) would fail to reach Docker; joining once, while sudo can ask, avoids that.
 */
export function needsGroup(p) {
  return p.sudo === "no" && !p.dockerGroup;
}

/** What installing will do, in the words the person is asked about. */
export function plan(p, env = process.env) {
  return [
    p.docker ? `use the Docker already there (Compose ${p.docker})` : "install Docker with get.docker.com",
    `create ${p.dir} and put Vyre's stack in it`,
    `add ${env.VYRE_WRAPPER || "/usr/local/bin/vyre"}`,
    "start Vyre, which waits for you to finish setting it up in your browser",
    ...(p.sudo === "no" ? ["sudo will ask for your password on this terminal"] : []),
    ...(needsGroup(p) ? [`add ${p.user || "your account"} to the docker group (root-equivalent on this server; lets Vyre manage the stack without your password)`] : []),
  ];
}

/** Why this server cannot take a box, or null when it can. */
export function unfit(p) {
  if (p.os !== "Linux") return `${p.os || "this server"} is not Linux; a Vyre box runs on Linux with Docker`;
  if (!p.tun) return "this server has no /dev/net/tun, which Tailscale needs. Try: sudo modprobe tun. On a VPS, turn on TUN in the provider's panel";
  return null;
}

// ---- asking ----

/** Ask once. true or false; null when there is no terminal to ask on. */
async function ask(question, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`  ${question} [y/N] `)).trim()); }
  finally { rl.close(); }
}

/** Show the plan and ask. Returns an exit code to stop with, or null to go ahead. */
async function agree(lines, question, yes) {
  for (const l of lines) out(`    ${l}`);
  out("");
  const ok = await ask(question, yes);
  if (ok) return null;
  if (ok === null) out(`  nothing changed. Run it in a terminal to answer, or add ${signal("--yes")}.`);
  else out("  nothing changed.");
  return 1;
}

// ---- the link (step 5) ----

/**
 * The box's answer to `vyre up --json`, or its text when that flag is not there yet.
 * @returns {{ url: string|null, port: number|null, address: string|null } | null}
 */
export function parseLink(text) {
  const s = String(text || "");
  // The object may be on one line or pretty-printed, after any notes vyre up printed first.
  const at = s.search(/^\s*\{/m);
  if (at >= 0) {
    try {
      const j = JSON.parse(s.slice(at));
      const port = j.port || (j.url && Number(new URL(j.url).port)) || null;
      return { url: j.url || null, port: port ? Number(port) : null, address: j.address || null };
    } catch {}
  }
  const m = /http:\/\/127\.0\.0\.1:(\d+)\/onboard\?t=\S+/.exec(s);
  const a = /your address: (https:\/\/\S+)/.exec(s);
  if (!m && !a) return null;
  return { url: m ? m[0] : null, port: m ? Number(m[1]) : null, address: a ? a[1] : null };
}

function openBrowser(url, env = process.env) {
  const bin = env.VYRE_OPEN_BIN || (process.platform === "darwin" ? "open" : "xdg-open");
  try { spawn(bin, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
}

// ---- the wait (step 6) ----

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Is onboarding far enough along that the Mac can take over? */
export function settled(s) {
  return Boolean(s && (s.finished || (s.address && s.steps && s.steps.name === "done")));
}

/**
 * Poll onboard.status, printing each step once as it is done or skipped. Resolves with the last
 * status, or "late" once the link has expired (it lives an hour; the wait gives it 65 minutes).
 */
async function wait(r, env = process.env) {
  const every = Number(env.VYRE_BOX_POLL_MS) || 5000;
  const until = Date.now() + (Number(env.VYRE_BOX_WAIT_MS) || 65 * 60_000);
  const said = new Set();
  let quiet = false;
  for (;;) {
    let s = null;
    try { s = await r.json(vyre(["call", "onboard.status"], env)); quiet = false; }
    catch (e) { if (!quiet) out(dim(`  the box did not answer (${/** @type {Error} */ (e).message}); still trying`)); quiet = true; }
    for (const [k, state] of Object.entries((s && s.steps) || {})) {
      if (said.has(k) || !["done", "skipped"].includes(state)) continue;
      said.add(k);
      out(`  ${(LABELS[k] || k).padEnd(14)} ${state === "done" ? signal("done") : dim("skipped")}`);
    }
    if (settled(s)) return s;
    if (Date.now() >= until) return "late";
    await sleep(every);
  }
}

/**
 * One Ctrl-C handler for a whole command run: fn closes the SSH masters (which removes their
 * /tmp folders) and says what state things were left in, then the command exits 130.
 */
function onInterrupt(fn) {
  let busy = false;
  const h = () => {
    if (busy) return;
    busy = true;
    Promise.resolve().then(fn).catch(() => {}).finally(() => process.exit(130));
  };
  process.on("SIGINT", h);
  return () => { process.off("SIGINT", h); };
}

const resume = target => `run vyre box add ${target} again to carry on.`;

// ---- add ----

/** Step 1: this Mac is on its tailnet. Returns the tailnet, or null after saying why not. */
async function macFirst(env) {
  const t = await tailnet.status(env);
  if (t.running) return t;
  out(beacon(`  ${t.why || "Tailscale is not running"}`));
  if (!t.installed) out(`  Vyre reaches your box over Tailscale. Get it here, sign in, then run this again: ${signal(tailnet.DOWNLOAD)}`);
  return null;
}

/** Step 2: reach the server, asking for a password once if there is no key. */
async function reach(r) {
  out(dim(`  reaching ${r.target}`));
  const o = await r.open();
  if (!o.ok) out(beacon(`  could not reach ${r.target}: `) + o.why);
  return o.ok;
}

/** Step 3: one call that reads what is there. */
async function look(r, env) {
  const res = await r.run(script(PREFLIGHT, env));
  if (res.code !== 0) throw new Error(res.stderr.trim().split("\n")[0] || `the check on ${r.target} failed`);
  const p = parsePreflight(res.stdout);
  out(`  ${r.target}: ${p.distro || p.os}${p.docker ? `, Docker Compose ${p.docker}` : ", no Docker yet"}${p.box ? `, Vyre in ${p.dir}` : ""}`);
  return p;
}

/**
 * Step 4: copy the installer that shipped with this package and run it. The copy matches the
 * Mac's version; --yes because the person already said yes to the plan; a terminal so sudo can ask.
 */
async function install(r, args, env, group = false) {
  const src = env.VYRE_BOX_INSTALLER || INSTALLER;
  const tmp = (await r.run("mktemp")).stdout.trim();
  if (!tmp) throw new Error(`could not make a temporary file on ${r.target}`);
  try {
    const put = await r.put(src, tmp);
    if (put.code !== 0) throw new Error(put.stderr.trim() || "could not copy the installer");
    const tty = Boolean(process.stdin.isTTY);
    // Joining the docker group rides the same terminal session, so sudo's cached password covers it.
    const join = group ? ' && sudo usermod -aG docker "$(id -un)"' : "";
    const res = await r.run(line("env", ...passEnv(env), ...(env.VYRE_NO_UP ? ["VYRE_NO_UP=1"] : []), "sh", tmp, ...args) + join, { tty });
    if (!tty) { if (res.stdout.trim()) out(res.stdout.replace(/^/gm, "  ").trimEnd()); if (res.stderr.trim()) out(dim(res.stderr.trim())); }
    if (res.code === 0 && group) {
      // Group membership comes with a new login, so the held connection is made again.
      const o = await r.reopen();
      if (!o.ok) throw new Error(`could not reach ${r.target} again after joining the docker group: ${o.why}`);
    }
    return res.code;
  } finally { await r.run(line("rm", "-f", tmp)); }
}

/** Step 5: the one-time link from the box. */
async function link(r, env) {
  const res = await r.run(vyre(["up", "--json"], env));
  const l = parseLink(res.stdout);
  if (!l || (!l.url && !l.address)) throw new Error(res.stderr.trim().split("\n")[0] || res.stdout.trim().split("\n")[0] || "vyre up on the box printed no link");
  return l;
}

/**
 * Step 7: remember the box, start this Mac's vyred, pair, and print the ending. Pairing shows a
 * code on the Mac for the box's owner to approve (ADR 0008 section 7). Here the person has just
 * proved they own the server by reaching it over SSH, so the Mac approves its own code there,
 * as `vyre link approve` on the box, and nobody types it.
 */
async function finish(r, target, s, t, env, tool = call) {
  config.save({ box: { ssh: target }, network: { box: s.address || undefined } });
  if (!s.address) {
    // Onboarding finished with the address step skipped: nothing on the tailnet to pair with yet.
    out(beacon("  your box has no address yet.") + ` Run ${signal(`vyre box add ${target}`)} again to finish ${signal("Your address")} in the browser.`);
    printEnding({ address: null, assistant: s.assistant });
    return 0;
  }
  const up = await ensureUp();
  if (!up.ok) out(beacon("  this Mac's vyred did not start: ") + dim(String(up.log)));
  else await pairOver(r, s.address, env, tool);
  if (s.owner && t.login && s.owner !== t.login) out(beacon(`  the box serves ${s.owner}, and this Mac is signed in to Tailscale as ${t.login}.`) + " Sign this Mac in to Tailscale as the box's owner, then run vyre up.");
  printEnding({ address: s.address, assistant: s.assistant });
  return 0;
}

/** Pair this Mac with the box, approving the code on the box over the SSH connection. */
async function pairOver(r, address, env, tool) {
  const st = await tool("link.status");
  if (st.error && st.error.code === "no_such_tool") { out(dim("  pairing is not in this version yet; this Mac will pair when it is")); return; }
  if (st.data && st.data.linked) return;
  const p = await tool("link.pair", { box: address });
  if (p.error) { out(beacon("  pairing: ") + p.error.message + dim(` · vyre link pair ${address}`)); return; }
  const a = await r.run(vyre(["link", "approve", String(p.data.code)], env));
  if (a.code === 0) out(`  ${signal("paired")} ${dim("· this Mac and your box work as one")}`);
  // Once the box has a passkey, approving needs a person on a device (the presence floor), not SSH.
  else out(beacon("  pairing is waiting for approval: ") + `approve "${os.hostname()}" in the Deck on your phone ${dim(`(code ${p.data.code})`)}`);
}

/**
 * `vyre box add user@host`: ADR 0008 section 2, steps 1 to 7. `vyre up` calls this too.
 * @param {string} target user@host
 * @param {{ yes?: boolean, env?: NodeJS.ProcessEnv, call?: typeof call }} [opts] call stands in for this Mac's vyred in tests
 * @returns {Promise<number>} exit code
 */
export async function add(target, opts = {}) {
  const env = opts.env || process.env;
  if (!validTarget(target)) { out("  vyre box add <user@host>"); return 1; }
  const t = await macFirst(env);
  if (!t) return 1;
  const r = remote(target, { env });
  const off = onInterrupt(async () => { await r.close(); out(`\n  Stopped. Your box is as you left it; ${resume(target)}`); });
  try {
    if (!(await reach(r))) return 1;
    const p = await look(r, env);
    const why = unfit(p);
    if (why) { out(beacon(`  ${why}. Nothing changed.`)); return 1; }
    if (p.box) out(`  Vyre is already on ${r.target}; carrying on from where it stands.`);
    else {
      out(`\n  Vyre will, on ${r.target}:`);
      const no = await agree(plan(p, env), "Go ahead?", opts.yes);
      if (no !== null) return no;
      const code = await install(r, ["--yes"], env, needsGroup(p));
      if (code !== 0) { out(beacon(`  the installer stopped (exit ${code}). Fix what it said, then run this again.`)); return 1; }
    }
    return await onboard(r, target, t, env, opts.call || call);
  } catch (e) {
    out(beacon("  stopped: ") + /** @type {Error} */ (e).message);
    return 1;
  } finally { off(); await r.close(); }
}

/** Steps 5 to 7: link, tunnel, browser, wait, finish. */
async function onboard(r, target, t, env, tool) {
  // A finished box needs no browser: go straight to the end (resuming, or a box set up by curl).
  const before = await r.json(vyre(["call", "onboard.status"], env)).catch(() => ({}));
  // An address still to set up is finished in the browser, so only a box with one skips it.
  if (before.finished && before.address) return finish(r, target, before, t, env, tool);
  const l = await link(r, env);
  if (!l.url) return finish(r, target, await r.json(vyre(["call", "onboard.status"], env)), t, env, tool);
  const tunnel = await r.tunnel(/** @type {number} */ (l.port), /** @type {number} */ (l.port));
  let s;
  try {
    openBrowser(l.url, env);
    out(`\n  Finish in your browser. I'll wait here.\n\n    ${signal(l.url)}\n`);
    s = await wait(r, env);
  } finally { await tunnel.close(); }
  if (s === "late") {
    out(beacon("\n  The setup link has expired.") + ` Your box is as you left it; ${resume(target)}`);
    return 1;
  }
  return finish(r, target, s, t, env, tool);
}

// ---- the saved box (section 8) ----

/** The saved box's ssh target, or null after saying how to add one. */
function saved() {
  const c = /** @type {any} */ (config.load());
  const t = c.box && c.box.ssh;
  if (!t) out(`  no box yet: ${signal("vyre box add <user@host>")}`);
  return t || null;
}

/** Open the saved box, run fn with it, close it. On Ctrl-C, close it and run stopped. */
async function withBox(target, fn, stopped = () => out("\n  Stopped.")) {
  const r = remote(target);
  const off = onInterrupt(async () => { await r.close(); stopped(); });
  try { return (await reach(r)) ? await fn(r) : 1; }
  catch (e) { out(beacon("  stopped: ") + /** @type {Error} */ (e).message); return 1; }
  finally { off(); await r.close(); }
}

async function status() {
  const target = saved();
  if (!target) return 0;
  const address = config.load().network.box;
  const h = address ? await tailnet.probe(address) : null;
  out(`  your box  ${signal(address || "no address yet")} ${dim(`· ${target}`)}`);
  out(h ? `  ${signal("answering")} ${dim(`· ${h.version || ""}`)}` : beacon("  not answering from here") + dim(" · is this Mac on your tailnet?"));
  return h ? 0 : 1;
}

/** -1, 0 or 1, comparing dotted versions. */
export function newer(a, b) {
  const x = String(a).split(/[.-]/).map(Number), y = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}

async function update() {
  const target = saved();
  if (!target) return 1;
  return withBox(target, async r => {
    const u = await r.run(vyre(["update"]), { tty: Boolean(process.stdin.isTTY) });
    if (!process.stdin.isTTY && u.stdout.trim()) out(u.stdout.replace(/^/gm, "  ").trimEnd());
    if (u.code !== 0) { out(beacon(`  vyre update on the box stopped (exit ${u.code})`)); return 1; }
    const v = (await r.run(vyre(["version"]))).stdout.trim();
    const cmp = newer(v, VERSION);
    if (cmp > 0) out(`  the box runs ${signal(v)}, newer than this Mac's ${VERSION}: ${signal("npm i -g vyre@latest && vyre up")}`);
    else if (cmp < 0) out(`  the box runs ${v}, older than this Mac's ${VERSION}; its next image catches up`);
    else out(`  the box and this Mac both run ${signal(v)}`);
    return 0;
  });
}

/** A script that fails, naming them, when any of the three volumes is missing on this server. */
const HAS_VOLUMES = `for v in ${VOLUMES.join(" ")}; do $D docker volume inspect vyre_$v >/dev/null 2>&1 || { echo "vyre_$v is missing on this server" >&2; exit 3; }; done`;

// The restart is set up before the stack stops, and runs however the copy ends: a dropped
// connection (HUP) or a Ctrl-C exits the script, and EXIT starts the stack again.
const BACKUP = [
  'cd "$DIR"', HAS_VOLUMES,
  "trap '$D docker compose start >&2' EXIT", "trap 'exit 1' HUP INT TERM",
  "$D docker compose stop >&2",
  `$D docker run --rm ${VOLUMES.map(v => `-v vyre_${v}:/b/${v}:ro`).join(" ")} alpine tar czf - -C /b ${VOLUMES.join(" ")}`,
].join("\n");

async function backup(file, flags = {}) {
  const target = saved();
  if (!target) return 1;
  const dest = path.resolve(file || `vyre-box-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`);
  if (fs.existsSync(dest) && !flags.force) { out(beacon(`  ${dest} exists; `) + "pick another file, or add --force to replace it"); return 1; }
  const partial = dest + ".partial";
  return withBox(target, async r => {
    out(dim(`  stopping the box while it copies; it starts again after`));
    const fd = fs.openSync(partial, "w", 0o600);
    fs.fchmodSync(fd, 0o600);
    const child = r.spawn(script(BACKUP), ["ignore", fd, "pipe"]);
    let err = "";
    child.stderr?.on("data", c => { err += c; });
    const code = await new Promise(res => { child.on("close", c => res(c ?? 1)); child.on("error", () => res(127)); });
    fs.closeSync(fd);
    if (code !== 0) {
      fs.rmSync(partial, { force: true });
      out(beacon(`  the backup failed: `) + (err.trim().split("\n").pop() || `exit ${code}`));
      return 1;
    }
    fs.renameSync(partial, dest);
    out(`  ${signal(dest)} ${dim(`· ${Math.round(fs.statSync(dest).size / 1024)} KB · ${VOLUMES.join(", ")}`)}`);
    out(dim("  keep it private: it holds your vault"));
    return 0;
  }, () => { fs.rmSync(partial, { force: true }); out("\n  Stopped. The box starts its stack again on its own; no backup was written."); });
}

const tail = (s, n = 3) => s.trim().split("\n").slice(-n).join(" / ");

/** Stream one volume from the old server to the new one through this Mac. */
async function carry(from, to, v) {
  const src = from.spawn(script(`exec $D docker run --rm -v vyre_${v}:/v:ro alpine tar czf - -C /v .`), ["ignore", "pipe", "pipe"]);
  const labels = `--label run.vyre=1 --label com.docker.compose.project=vyre --label com.docker.compose.volume=${v}`;
  const dst = to.spawn(script(`$D docker volume create ${labels} vyre_${v} >/dev/null && exec $D docker run --rm -i -v vyre_${v}:/v alpine tar xzf - -C /v`), ["pipe", "ignore", "pipe"]);
  const err = { src: "", dst: "" };
  src.stderr?.on("data", c => { err.src += c; });
  dst.stderr?.on("data", c => { err.dst += c; });
  // The new side may die first; its closed stdin must fail this volume, not crash the Mac.
  dst.stdin?.on("error", () => {});
  src.stdout?.on("error", () => {});
  /** @type {any} */ (src.stdout).pipe(dst.stdin);
  const done = c => new Promise(res => { c.on("close", x => res(x ?? 1)); c.on("error", () => res(127)); });
  const [a, b] = await Promise.all([done(src), done(dst)]);
  if (a !== 0 || b !== 0) {
    const why = [a !== 0 && `old: ${tail(err.src) || `exit ${a}`}`, b !== 0 && `new: ${tail(err.dst) || `exit ${b}`}`].filter(Boolean).join("; ");
    throw new Error(`copying ${v} failed (${why})`);
  }
  out(`  ${v.padEnd(16)} ${signal("moved")}`);
}

/** Wait for the box's address to answer from this Mac, up to VYRE_BOX_PROBE_MS (default 2 minutes). */
async function answers(address, probe, env = process.env) {
  const until = Date.now() + (Number(env.VYRE_BOX_PROBE_MS ?? 120_000));
  for (;;) {
    if (await probe(address)) return true;
    if (Date.now() >= until) return false;
    await sleep(3000);
  }
}

/**
 * `vyre box move user@newhost` (ADR 0008 section 8). Once the old stack stops, every way out
 * either finishes the move or starts the old stack again, and says which.
 * @param {string} newTarget
 * @param {{ yes?: boolean }} [flags]
 * @param {{ probe?: (address: string) => Promise<any> }} [deps] probe stands in for tailnet.probe in tests
 */
export async function move(newTarget, flags = {}, deps = {}) {
  const probe = deps.probe || tailnet.probe;
  const oldTarget = saved();
  if (!oldTarget) return 1;
  if (!validTarget(newTarget)) { out("  vyre box move <user@newhost>"); return 1; }
  const env = { ...process.env, VYRE_NO_UP: "1" };
  const from = remote(oldTarget), to = remote(newTarget, { env });
  let oldStopped = false;

  /** Start the old stack again and say truthfully whether it came back. */
  const restore = async () => {
    const r = await from.run(script('cd "$DIR" && $D docker compose start'));
    if (r.code === 0) out(`  your box is running again on ${signal(oldTarget)}, as it was`);
    else out(beacon(`  the old box did not start again (${tail(r.stderr) || `exit ${r.code}`}).`) + ` On ${oldTarget}, run: cd /srv/vyre && docker compose start`);
  };
  const off = onInterrupt(async () => {
    out("\n  Stopped.");
    if (oldStopped) await restore();
    else out(`  ${oldTarget} was not touched.`);
    await from.close(); await to.close();
  });

  try {
    if (!(await reach(from)) || !(await reach(to))) return 1;
    const p = await look(to, env);
    const why = unfit(p);
    if (why) { out(beacon(`  ${why}. Nothing changed.`)); return 1; }
    if (p.box) { out(beacon(`  ${newTarget} already holds a box in ${p.dir}; moving would overwrite it. Nothing changed.`)); return 1; }
    if (p.volumes.length) { out(beacon(`  ${newTarget} holds Vyre volumes from an earlier box (${p.volumes.join(", ")}); moving would overwrite them. Nothing changed.`)); return 1; }
    const has = await from.run(script(HAS_VOLUMES));
    if (has.code !== 0) { out(beacon(`  ${tail(has.stderr) || `the volumes on ${oldTarget} could not be checked`}. Nothing changed.`)); return 1; }

    out(`\n  Vyre will move from ${oldTarget} to ${newTarget}:`);
    const no = await agree([...plan(p).filter(l => !l.startsWith("start Vyre")), `stop Vyre on ${oldTarget} (it is down until the move ends)`,
      `copy ${VOLUMES.join(", ")} across, through this computer`, `start Vyre on ${newTarget}, same name and address`,
      `take Vyre off ${oldTarget} once the new one answers, keeping its volumes`], "Go ahead?", flags.yes);
    if (no !== null) return no;

    if ((await install(to, ["--yes"], env, needsGroup(p))) !== 0) { out(beacon(`  the installer stopped on ${newTarget}; ${oldTarget} was not touched.`)); return 1; }
    // Until install-box.sh honours VYRE_NO_UP, the installer starts a fresh stack: take it down,
    // with the empty volumes it just made (the preflight saw none there before), so nothing holds them.
    const down = await to.run(script('cd "$DIR" && $D docker compose down -v'));
    if (down.code !== 0) { out(beacon(`  could not clear the fresh stack on ${newTarget}: ${tail(down.stderr)}. ${oldTarget} was not touched.`)); return 1; }

    oldStopped = true;
    try {
      const stop = await from.run(script('cd "$DIR" && $D docker compose stop'));
      if (stop.code !== 0) throw new Error(`could not stop the old box: ${tail(stop.stderr) || `exit ${stop.code}`}`);
      for (const v of VOLUMES) await carry(from, to, v);
      const l = await link(to, env);
      if (!l.address) throw new Error(`${newTarget} started but has no address`);
      out(dim(`  waiting for ${l.address} to answer from here`));
      if (!(await answers(l.address, probe, env))) throw new Error(`${l.address} did not answer from this Mac`);
    } catch (e) {
      out(beacon("  the move stopped: ") + /** @type {Error} */ (e).message);
      const s = await to.run(script('cd "$DIR" && $D docker compose stop'));
      out(s.code === 0 ? `  stopped Vyre on ${newTarget}` : beacon(`  could not stop Vyre on ${newTarget}: `) + tail(s.stderr));
      await restore();
      return 1;
    }

    config.save({ box: { ssh: newTarget } });
    out(`  your box now runs on ${signal(newTarget)}`);
    const u = await install(from, ["--yes", "--uninstall"], process.env);
    if (u === 0) out(`  Vyre is off ${oldTarget}; its volumes stay there until you delete them`);
    else out(beacon(`  taking Vyre off ${oldTarget} stopped (exit ${u}).`) + ` Its stack is stopped and its volumes kept; to finish, run install-box.sh --uninstall on ${oldTarget}.`);
    return 0;
  } catch (e) {
    out(beacon("  stopped: ") + /** @type {Error} */ (e).message);
    if (oldStopped) await restore();
    return 1;
  } finally { off(); await from.close(); await to.close(); }
}

async function remove(flags) {
  const target = saved();
  if (!target) return 1;
  out(`\n  Vyre will, on ${target}:`);
  const no = await agree(["stop the stack and remove /usr/local/bin/vyre",
    flags.purge ? "then ask on the server before deleting the volumes (vault, Claude's sign-in, store, /work)" : "keep the volumes, so a reinstall picks up where it left off",
    "and this Mac forgets the box"], "Go ahead?", flags.yes);
  if (no !== null) return no;
  return withBox(target, async r => {
    const code = await install(r, ["--uninstall", ...(flags.purge ? ["--purge"] : [])], process.env);
    if (code !== 0) { out(beacon(`  the uninstall stopped (exit ${code}); this Mac still remembers the box`)); return 1; }
    config.save({ box: null, network: { box: null } });
    out("  this Mac has forgotten the box");
    return 0;
  });
}

async function run(args) {
  const flags = Object.fromEntries(args.filter(a => a.startsWith("--")).map(a => [a.slice(2), true]));
  const rest = args.filter(a => !a.startsWith("--"));
  const [sub, arg] = rest;
  switch (sub) {
    case undefined: case "status": return status();
    case "add": return add(arg, { yes: Boolean(flags.yes) });
    case "update": return update();
    case "backup": return backup(arg, flags);
    case "move": return move(arg, flags);
    case "remove": return remove(flags);
    default: out(`  ${USAGE}`); return 1;
  }
}

const usage = "vyre box [add|update|backup|move|remove]";
const USAGE = "vyre box add <user@host> | update | backup [file] | move <user@newhost> | remove [--purge]";

export default [{ name: "box", order: 12, usage, summary: "put Vyre on a server from this Mac, and look after it", run }];
