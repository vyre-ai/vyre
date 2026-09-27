// @ts-check
// `vyre update` on the Mac, and on any vyre installed with npm (ADR 0033 section 4).
//
// It reads the GitHub Releases for vyre-ai/vyre, shows what changed since the running version,
// backs up the data into <home>/backups/pre-<version>/, downloads the release into
// <home>/releases/<version>/ and checks every file against its SHA256SUMS, installs it with
// `npm install -g`, and restarts vyred through the same bring() that `vyre up` uses for a stale
// build. If vyred does not come back reporting the new version inside the update window, the
// previous tarball goes back and the backup is restored: store migrations only go forward, so the
// database returns from the backup. Once the new vyred has answered, nothing restores the data on
// its own, so nothing written after a good update is ever lost.
//
// The box's own `vyre update` is the host wrapper (box/vyre); inside the container this refuses.
// A checkout has no build.json stamp and is updated with git, so this refuses there too.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as config from "../../config/index.js";
import { REPO } from "../../daemon/index.js";
import { build } from "../../daemon/build.js";
import { stop } from "../daemonctl.js";
import { backup, restore } from "../../names/backup.js";
import { bring, waitFor, terminal } from "./up.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { EXIT, UsageError, json, emit, fail, usage, parse } from "../kit.js";
import * as R from "../update/releases.js";

const REPO_PATH = "repos/vyre-ai/vyre/releases";
const USAGE = "vyre update [--check] [--channel stable|beta] [--to <version>] [--yes] [--rollback [--restore-data]] [--json]";

/**
 * What `vyre update` needs from the world, so tests can stand in for each piece.
 * @typedef {{ tty: boolean, ask(q: string): Promise<string> }} IO
 * @typedef {{ home?: string, api?: string, npm?: string, repo?: string, build?: () => import("../../daemon/build.js").Build,
 *   bring?: typeof bring, waitFor?: typeof waitFor, backup?: typeof backup, restore?: typeof restore, stop?: typeof stop,
 *   io?: IO, supervisor?: string, window?: number }} Deps
 */

/** Fetch with a time limit, as the one client Vyre is to GitHub. */
async function get(url, accept = "application/octet-stream") {
  const r = await fetch(R.safeUrl(url), { headers: { accept, "user-agent": "vyre-update" }, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r;
}

/** Every release of vyre-ai/vyre, newest first. */
async function list(api) {
  const r = await get(`${api.replace(/\/$/, "")}/${REPO_PATH}?per_page=100`, "application/vnd.github+json");
  return R.releases(await r.json());
}

/** Download to `file`, through a .part name so a cut connection leaves nothing that looks whole. */
async function download(url, file) {
  const r = await get(url);
  const part = file + ".part";
  fs.writeFileSync(part, Buffer.from(await r.arrayBuffer()), { mode: 0o600 });
  fs.renameSync(part, file);
}

/** Download one asset of `rel` into `dir` and keep it only if it matches its line in `sums`. */
async function fetchChecked(rel, name, dir, sums) {
  if (!rel.assets[name]) throw new Error(`release ${rel.version} has no ${name}`);
  const part = path.join(dir, name + ".unchecked");
  await download(rel.assets[name], part);
  try { R.verify(part, name, sums); } catch (e) { fs.rmSync(part, { force: true }); throw e; }
  const file = path.join(dir, name);
  fs.renameSync(part, file);
  return file;
}

/** SHA256SUMS and release.json of a release, into `dir`. Throws on anything that does not check out. */
async function fetchMeta(rel, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!rel.assets.SHA256SUMS) throw new Error(`release ${rel.version} has no SHA256SUMS`);
  const sumsFile = path.join(dir, "SHA256SUMS");
  await download(rel.assets.SHA256SUMS, sumsFile);
  const sums = R.parseSums(fs.readFileSync(sumsFile, "utf8"));
  const meta = JSON.parse(fs.readFileSync(await fetchChecked(rel, "release.json", dir, sums), "utf8"));
  if (meta.version !== rel.version) throw new Error(`release.json says ${meta.version}, the tag says ${rel.version}`);
  return { sums, meta };
}

/** A release folder kept in <home>/releases, checked again before it is used. */
function kept(dir) {
  const tgz = path.join(dir, "vyre.tgz");
  R.verify(tgz, "vyre.tgz", R.parseSums(fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8")));
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf8")); } catch {}
  return { tgz, meta };
}

/** The version folders in <home>/releases that hold a tarball, newest first. */
function releaseDirs(home) {
  const root = path.join(home, "releases");
  let names = [];
  try { names = fs.readdirSync(root); } catch {}
  return names.filter(n => R.parseVersion(n) && fs.existsSync(path.join(root, n, "vyre.tgz")))
    .sort((a, b) => R.compare(b, a)).map(version => ({ version, dir: path.join(root, version) }));
}

/** Keep the two newest release folders and the running one; remove the rest. */
export function prune(home, running) {
  const root = path.join(home, "releases");
  let names = [];
  try { names = fs.readdirSync(root).filter(n => R.parseVersion(n)); } catch { return []; }
  const keep = new Set([...names].sort((a, b) => R.compare(b, a)).slice(0, 2).concat(running));
  const gone = names.filter(n => !keep.has(n));
  for (const n of gone) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  return gone;
}

/** Make sure the running version's tarball is kept, so a failed update has something to go back to. */
async function keepCurrent(releases, current, home) {
  const dir = path.join(home, "releases", current);
  try { return kept(dir); } catch {}
  const rel = releases.find(r => r.version === current);
  if (!rel) return null;
  try {
    const { sums, meta } = await fetchMeta(rel, dir);
    return { tgz: await fetchChecked(rel, "vyre.tgz", dir, sums), meta };
  } catch { fs.rmSync(dir, { recursive: true, force: true }); return null; }
}

/** `npm install -g <tarball>`. Resolves { ok, why } with the tail of npm's output on a failure. */
function npmInstall(npm, tgz) {
  return new Promise(resolve => {
    let log = "";
    let child;
    try { child = spawn(npm, ["install", "-g", tgz], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { resolve({ ok: false, why: /** @type {Error} */ (e).message }); return; }
    child.stdout.on("data", d => { log += d; });
    child.stderr.on("data", d => { log += d; });
    child.on("error", e => resolve({ ok: false, why: `${npm}: ${e.message}` }));
    child.on("close", code => resolve(code === 0 ? { ok: true, why: "" }
      : { ok: false, why: `npm exited ${code}${log.trim() ? ": " + log.trim().split("\n").slice(-2).join(" ") : ""}` }));
  });
}

/** The build a release says it is, for bring() and the health wait. */
const buildOf = (version, meta) => ({ version, commit: typeof meta?.commit === "string" ? meta.commit : null, dirty: false, stamped: typeof meta?.commit === "string" });

/**
 * @param {string[]} args
 * @param {Deps} [deps]
 */
export async function update(args, deps = {}) {
  let flags;
  try { ({ flags } = parse(args, { bool: ["check", "yes", "rollback", "restore-data"], values: ["channel", "to"], cmd: "update" })); }
  catch (e) { if (e instanceof UsageError) return usage(e.message, e.next); throw e; }
  const home = deps.home || config.home();
  const say = json() ? () => {} : out;

  if ((deps.supervisor ?? process.env.VYRE_SUPERVISOR) === "docker") {
    return fail("in the box's container, the host's vyre update does this", { code: "wrong_place", next: "run vyre update on the server itself, or vyre box update from your Mac" });
  }
  const mine = (deps.build || build)();
  if (!mine.stamped || fs.existsSync(path.join(deps.repo || REPO, ".git"))) {
    return fail("this vyre runs from a checkout; update it with git", { code: "checkout", next: "git pull, then vyre up" });
  }
  const cfg = /** @type {any} */ (config.load(home));
  const channel = String(flags.channel || (cfg.update && cfg.update.channel) || "stable");
  if (!["stable", "beta"].includes(channel)) return usage(`vyre update: no channel ${channel}; it is stable or beta`, USAGE);
  if (flags["restore-data"] && !flags.rollback) return usage("vyre update --restore-data goes with --rollback", "vyre update --rollback --restore-data");
  const ctx = {
    home, say, flags, current: mine.version, role: cfg.role,
    npm: deps.npm || process.env.VYRE_NPM_BIN || "npm",
    bring: deps.bring || bring, waitFor: deps.waitFor || waitFor,
    backup: deps.backup || backup, restore: deps.restore || restore, stop: deps.stop || stop,
    io: deps.io || terminal, window: deps.window ?? 60_000,
  };
  if (flags.rollback) return rollback(ctx);

  const api = deps.api || process.env.VYRE_RELEASES_API || "https://api.github.com";
  let releases;
  try { releases = await list(api); }
  catch (e) { return fail(`could not read the releases: ${/** @type {Error} */ (e).message}`, { code: "releases_unreachable", next: "check this machine is online, then try again" }); }
  const want = flags.to ? String(flags.to).replace(/^v/, "") : null;
  if (want && !R.parseVersion(want)) return usage(`vyre update --to ${flags.to}: not a version`, USAGE);
  const target = want ? releases.find(r => r.version === want) : R.pick(releases, channel);
  if (!target) return fail(want ? `there is no release ${want}` : `there is no ${channel} release yet`, { code: "no_release" });
  const waiting = R.compare(target.version, ctx.current) > 0;
  const notes = R.changelog(releases, ctx.current, target.version, channel);

  if (flags.check) {
    if (json()) { emit({ current: ctx.current, latest: target.version, channel }); return waiting ? EXIT.FAILED : EXIT.OK; }
    if (!waiting) { out(`  ${signal(ctx.current)} is the newest ${channel} release`); return EXIT.OK; }
    out(`  ${signal(target.version)} is out on ${channel} ${dim(`· this is ${ctx.current}`)}`);
    showNotes(notes, out);
    out(dim("  vyre update installs it"));
    return EXIT.FAILED;
  }
  if (!waiting) {
    if (want) return fail(`${want} is not newer than ${ctx.current}`, { code: "not_newer", next: "vyre update --rollback puts back the previous release" });
    if (json()) return emit({ updated: false, current: ctx.current, latest: target.version, channel });
    out(`  ${signal(ctx.current)} is the newest ${channel} release; nothing to do`);
    return EXIT.OK;
  }

  say(`  ${bold(`${ctx.current} → ${target.version}`)} ${dim(`· ${channel}`)}`);
  showNotes(notes, say);
  if (!flags.yes) {
    if (!ctx.io.tty || json()) return usage("vyre update needs --yes when it cannot ask", "vyre update --yes");
    const a = (await ctx.io.ask(`  Update to ${target.version} now? (y/N) `)).trim();
    if (!/^y(es)?$/i.test(a)) { out(dim("  nothing changed")); return EXIT.FAILED; }
  }
  return install(ctx, releases, target, channel);
}

/** The notes of each release in the slice, newest first. */
function showNotes(notes, say) {
  for (const n of notes) {
    say("");
    say(`  ${bold(n.version)}`);
    for (const l of (n.notes || "no notes").split("\n")) say(`    ${l}`);
  }
  if (notes.length) say("");
}

/** Download, check, back up, install, restart, and undo it all if vyred does not come back. */
async function install(ctx, releases, target, channel) {
  const { home, say, current } = ctx;
  const dir = path.join(home, "releases", target.version);
  let meta, tgz;
  try {
    const got = await fetchMeta(target, dir);
    meta = got.meta;
    const can = R.canUpdate(releases, current, meta.min_from, target.version, channel);
    if (!can.ok) {
      fs.rmSync(dir, { recursive: true, force: true });
      const step = can.step;
      return fail(`${target.version} updates only from ${meta.min_from} or newer, and this is ${current}`, {
        code: "min_from",
        next: step ? `vyre update --to ${step.version} first, then vyre update` : `install ${meta.min_from} by hand once: npm install -g <its vyre.tgz> && vyre up`,
      });
    }
    tgz = await fetchChecked(target, "vyre.tgz", dir, got.sums);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    return fail(`${/** @type {Error} */ (e).message}; nothing was installed`, { code: "bad_release", next: "try again later; if it keeps failing the release is broken" });
  }
  say(dim(`  checked vyre.tgz against SHA256SUMS · ${dir}`));

  const prev = await keepCurrent(releases, current, home);
  if (!prev) say(beacon(`  no ${current} tarball to go back to`) + dim(" · a failed update restores the data but cannot reinstall this version"));

  const file = path.join(home, "backups", `pre-${target.version}`, "vyre-backup.tar.gz");
  try { await ctx.backup({ root: home, file }); }
  catch (e) { return fail(`the backup before updating did not finish: ${/** @type {Error} */ (e).message}; nothing was installed`, { code: "backup_failed" }); }
  say(dim(`  backed up · ${file}`));

  /** Inside the window: put the old code back, and the data too once the new vyred has run. */
  const undo = async (why, data) => {
    const did = [];
    if (prev) {
      const r = await npmInstall(ctx.npm, prev.tgz);
      did.push(r.ok ? `reinstalled ${current}` : `could not reinstall ${current} (${r.why})`);
    }
    if (data) {
      await ctx.stop();
      try { await ctx.restore({ root: home, file, force: true }); did.push("restored the backup"); }
      catch (e) { did.push(`could not restore the backup (${/** @type {Error} */ (e).message})`); }
    }
    const b = await ctx.bring(ctx.role, () => buildOf(current, prev ? prev.meta : null));
    did.push(b.ok ? "restarted vyred" : `vyred did not restart (${b.note})`);
    return fail(`the update to ${target.version} failed: ${why}. Rolled back: ${did.join(", ")}`, {
      code: "update_failed", next: `the backup stays in ${path.dirname(file)}; vyre up checks vyred`,
    });
  };

  const inst = await npmInstall(ctx.npm, tgz);
  // vyred has not run the new code, so the store is untouched: only the code goes back.
  if (!inst.ok) return undo(`npm install failed: ${inst.why}`, false);
  const next = buildOf(target.version, meta);
  const b = await ctx.bring(ctx.role, () => next);
  if (!b.ok) return undo(b.note || "vyred did not start", true);
  const h = await ctx.waitFor(target.version, ctx.window, next.commit);
  if (!h) return undo(`vyred did not report ${target.version} on /v1/health within ${Math.round(ctx.window / 1000)}s`, true);

  // Healthy: from here on nothing restores the data by itself.
  const removed = prune(home, target.version);
  if (json()) return emit({ updated: true, from: current, to: target.version, channel, backup: file, removed });
  out(`  ${signal("updated")} ${current} → ${target.version} ${dim("· vyred answering")}`);
  out(dim(`  backup from before it: ${file}`));
  if (prev) out(dim(`  vyre update --rollback puts ${current} back`));
  return EXIT.OK;
}

/** `--rollback`: the previous kept release goes back; the data stays unless --restore-data. */
async function rollback(ctx) {
  const { home, say, current, flags } = ctx;
  const prev = releaseDirs(home).find(d => R.compare(d.version, current) < 0);
  if (!prev) return fail(`no release older than ${current} is kept in ${path.join(home, "releases")}`, { code: "no_previous" });
  let old;
  try { old = kept(prev.dir); }
  catch (e) { return fail(`the kept ${prev.version} does not check out: ${/** @type {Error} */ (e).message}`, { code: "bad_release" }); }

  const data = Boolean(flags["restore-data"]);
  const file = path.join(home, "backups", `pre-${current}`, "vyre-backup.tar.gz");
  if (data) {
    let when;
    try { when = fs.statSync(file).mtime; }
    catch { return fail(`there is no backup from before ${current} (${file})`, { code: "no_backup", next: "vyre update --rollback keeps the current data" }); }
    const drops = `this puts back the data from ${when.toISOString().replace("T", " ").slice(0, 16)} UTC, taken before ${current} was installed, and drops everything written since then`;
    if (!flags.yes) {
      if (!ctx.io.tty || json()) return fail(`${drops}; add --yes to go ahead`, { code: "needs_yes", exit: EXIT.USAGE, next: "vyre update --rollback --restore-data --yes" });
      out(beacon(`  ${drops}`));
      const a = (await ctx.io.ask("  Type restore to go ahead: ")).trim();
      if (a !== "restore") { out(dim("  nothing changed")); return EXIT.FAILED; }
    }
  }

  const r = await npmInstall(ctx.npm, old.tgz);
  if (!r.ok) return fail(`could not reinstall ${prev.version}: ${r.why}`, { code: "install_failed" });
  if (data) {
    await ctx.stop();
    try { await ctx.restore({ root: home, file, force: true }); }
    catch (e) { return fail(`${prev.version} is installed but the backup did not go back: ${/** @type {Error} */ (e).message}`, { code: "restore_failed", next: "vyre up starts vyred on the current data" }); }
  }
  const back = buildOf(prev.version, old.meta);
  const b = await ctx.bring(ctx.role, () => back);
  const h = b.ok ? await ctx.waitFor(prev.version, ctx.window, back.commit) : null;
  if (!h) return fail(`${prev.version} is installed but vyred did not come back: ${b.note || "no answer on /v1/health"}`, { code: "vyred_down", next: "vyre up" });
  if (json()) return emit({ rolledBack: true, from: current, to: prev.version, restoredData: data, backup: data ? file : null });
  say(`  ${signal("rolled back")} ${current} → ${prev.version} ${dim(data ? "· data restored from the backup" : "· kept the current data")}`);
  return EXIT.OK;
}

export default {
  name: "update", order: 79, usage: USAGE,
  summary: "install the newest release after a backup, and roll back if it does not come up",
  help: [
    "--check          say whether a newer release is out; exit 0 when current, 1 when one waits",
    "--channel NAME   stable (the default, or config update.channel) or beta",
    "--to VERSION     a given release, for stepping through one an update asks for",
    "--yes            do not ask first (needed when there is no terminal to ask on)",
    "--rollback       put the previous release back and keep the current data",
    "--restore-data   with --rollback: also put back the data from before the update",
    "",
    "Every download is checked against the release's SHA256SUMS. On a box, the host's",
    "vyre update does this; from a checkout, update with git.",
  ].join("\n"),
  run: args => update(args),
};
