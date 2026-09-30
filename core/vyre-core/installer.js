// @ts-check
// The ROOT side of the Mac server install (ADR 0040 sections 1 and 5, phase 4).
//
// Pure, seamed functions. Nothing here runs a command directly: every command goes through an
// injected `run(cmd, args, { input })`, and every path is built under an injectable `root`
// (default "/"), so a test installs into a temp dir and records the commands instead of touching
// the machine. The one exception is release.js's extract(), which shells out to tar itself; it is
// pointed at /usr/bin/tar on a Mac and runs only on a tarball that has already been verified.
//
// Order matters and is part of the contract (see plan()): the release is verified BEFORE anything
// on the machine changes, so a bad signature, a tampered tarball or an old version leaves no
// account, no file and no launchd job behind.
//
// Trust: the release files arrive from a directory the person (or `_vyre`) can write. They are
// read into memory ONCE, verified there, and only the verified bytes are written to a root-owned
// work directory and extracted. Nothing is ever verified in one place and used from another.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { RELEASE_KEY, verifyManifest, checkFloor, compareVersions, readFloor, raiseFloor, checkTarball, extract } from "./release.js";

export const ACCOUNT = "_vyre";
export const LABELS = Object.freeze({
  core: "com.vyre.core",
  update: "com.vyre.core.update",
  vyred: "com.vyre.vyred",
  colima: "com.vyre.colima",
});
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const UID_MIN = 200;
const UID_MAX = 399;

/** Runtime paths (what the machine sees; `root` is only a prefix for where we write). */
const RT = Object.freeze({
  base: "/Library/Application Support/Vyre",
  daemons: "/Library/LaunchDaemons",
  // Not /var/run: macOS clears it at boot, and _vyre cannot recreate a root folder.
  socketDir: "/Library/Application Support/Vyre/run",
});
export const RUNTIME = Object.freeze({
  base: RT.base,
  versions: `${RT.base}/versions`,
  current: `${RT.base}/current`,
  node: `${RT.base}/node`,
  data: `${RT.base}/data`,
  staging: `${RT.base}/staging`,
  floor: `${RT.base}/.floor`,
  socketDir: RT.socketDir,
  mainJs: `${RT.base}/current/core/vyre-core/main.js`,
  installMainJs: `${RT.base}/current/core/vyre-core/install-main.js`,
});

/** @typedef {(cmd: string, args: string[], o?: { input?: string }) => string} Run */

/** The default run: absolute paths only, an empty-ish environment, cwd "/". Returns stdout. */
/** @type {Run} */
export function defaultRun(cmd, args, { input } = {}) {
  if (!path.isAbsolute(cmd)) throw new Error(`refusing to run a relative command: ${cmd}`);
  return execFileSync(cmd, args, {
    input,
    encoding: "utf8",
    cwd: "/",
    env: { PATH: SAFE_PATH },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

/**
 * @typedef {object} Opts
 * @property {number} ownerUid
 * @property {string} ownerName
 * @property {string} [ownerHome]  default /Users/<ownerName>
 * @property {string} version
 * @property {{ tarball: string, manifest: string, sig: string }} release  file paths
 * @property {string} nodeBinary  the bundled node to copy in
 * @property {string} vyredWrapper  person-side wrapper vyred's LaunchDaemon runs, as the owner
 * @property {string} [ghBin]  absolute path of the gh CLI, set as VYRE_GH_BIN in vyred's LaunchDaemon environment
 * @property {boolean} [colimaAgent]
 * @property {string[]} [colimaProgram]  program arguments for com.vyre.colima
 */

/** @typedef {{ run?: Run, root?: string, key?: string, tar?: string, step?: (name: string) => void }} Seams */

const ownerNameOk = (n) => typeof n === "string" && /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(n) && n !== "root" && n !== ACCOUNT;

/** @param {Opts} o */
function checkOpts(o) {
  if (!o || typeof o !== "object") throw new Error("install needs options");
  if (!Number.isInteger(o.ownerUid) || o.ownerUid <= 0) throw new Error("ownerUid must be the owner's own uid, never root");
  if (!ownerNameOk(o.ownerName)) throw new Error("ownerName is not a usable account name (and is never root or _vyre)");
  if (typeof o.version !== "string" || !o.version) throw new Error("version is required");
  if (!o.release || !o.release.tarball || !o.release.manifest || !o.release.sig) throw new Error("release needs tarball, manifest and sig paths");
  if (!o.nodeBinary || !path.isAbsolute(o.nodeBinary)) throw new Error("nodeBinary must be an absolute path");
  if (!o.vyredWrapper || !path.isAbsolute(o.vyredWrapper)) throw new Error("vyredWrapper must be an absolute path");
  if (o.ghBin !== undefined && (!path.isAbsolute(o.ghBin) || /[\0\n]/.test(o.ghBin))) throw new Error("ghBin must be an absolute path");
  if (o.ownerHome !== undefined && !path.isAbsolute(o.ownerHome)) throw new Error("ownerHome must be an absolute path");
  if (o.colimaAgent && (!Array.isArray(o.colimaProgram) || !o.colimaProgram.length || !o.colimaProgram.every((a) => typeof a === "string") || !path.isAbsolute(o.colimaProgram[0])))
    throw new Error("colimaAgent needs colimaProgram: program arguments starting with an absolute path");
}

/**
 * The install as ordered data, for --dry-run and tests. No side effects.
 * @param {Opts} opts
 * @returns {{ id: string, name: string, detail: string[] }[]}
 */
export function plan(opts) {
  checkOpts(opts);
  const labels = [LABELS.core, LABELS.update, LABELS.vyred, ...(opts.colimaAgent ? [LABELS.colima] : [])];
  return [
    { id: "verify-release", name: `verify release ${opts.version} (signature, tarball hash, version floor)`, detail: [`floor: ${RUNTIME.floor}`, "nothing on the machine changes before this passes"] },
    { id: "account", name: `create the ${ACCOUNT} system account (skipped if it exists)`, detail: [`dscl . -create /Users/${ACCOUNT}`, `dscl . -create /Groups/${ACCOUNT}`, `id in ${UID_MIN}-${UID_MAX}, shell /usr/bin/false, home /var/empty, hidden`] },
    { id: "code-tree", name: `extract ${opts.version} and flip current`, detail: [`${RUNTIME.versions}/${opts.version}`, `${RUNTIME.current} -> versions/${opts.version} (current.new, then rename)`, "root:wheel, no group or other write"] },
    { id: "node", name: "install the bundled node", detail: [`${RUNTIME.node} root:wheel 0755`] },
    { id: "dirs", name: "make the data, staging and socket folders", detail: [`${RUNTIME.data} ${ACCOUNT} 0700`, `${RUNTIME.staging} ${ACCOUNT} 0700`, `${RUNTIME.socketDir} ${ACCOUNT} 0755`] },
    { id: "plists", name: "write the LaunchDaemon plists", detail: labels.map((l) => `${RT.daemons}/${l}.plist root:wheel 0644`) },
    { id: "launchd", name: "bootstrap the daemons (core first)", detail: labels.map((l) => `launchctl bootstrap system ${RT.daemons}/${l}.plist`) },
    { id: "enrol-code", name: "mint the one-time enrolment code (returned, never logged or written)", detail: [`sudo -u ${ACCOUNT} node main.js code`] },
  ];
}

// ---------------------------------------------------------------------------------------------
// paths under root

/** @param {string} root */
function paths(root) {
  const j = (rt) => path.join(root, rt);
  return {
    base: j(RUNTIME.base), versions: j(RUNTIME.versions), current: j(RUNTIME.current), currentNew: j(`${RUNTIME.current}.new`),
    node: j(RUNTIME.node), data: j(RUNTIME.data), staging: j(RUNTIME.staging), floor: j(RUNTIME.floor), coreJson: j(`${RT.base}/core.json`), socketDir: j(RT.socketDir),
    plist: (label) => j(`${RT.daemons}/${label}.plist`), daemons: j(RT.daemons),
  };
}

const rand = () => crypto.randomBytes(4).toString("hex");
const defTar = () => (process.platform === "darwin" ? "/usr/bin/tar" : "tar");

/** @param {Run} run @param {string} owner @param {string} p @param {boolean} [recursive] */
const chown = (run, owner, p, recursive = false) => run("/usr/sbin/chown", [...(recursive ? ["-R"] : []), owner, p]);

/** @param {string} p @param {number} mode */
function mkdirMode(p, mode) {
  fs.mkdirSync(p, { recursive: true });
  fs.chmodSync(p, mode);
}

// ---------------------------------------------------------------------------------------------
// verify

/**
 * Read the three release files into memory once and check them. Throws, changing nothing.
 * @param {{ tarball: string, manifest: string, sig: string }} files
 * @param {{ key: string, floorPath: string, strictFloor: boolean, version?: string }} o
 *   strictFloor: an update must be ABOVE the floor; a (re)install may equal it, so a re-run repairs.
 */
export function verifyRelease(files, { key, floorPath, strictFloor, version }) {
  const regular = (p, what) => {
    const st = fs.lstatSync(p);
    if (!st.isFile()) throw new Error(`${what} is not a regular file`);
  };
  regular(files.manifest, "manifest");
  regular(files.sig, "signature");
  regular(files.tarball, "tarball");
  const manifestBytes = fs.readFileSync(files.manifest);
  const sigBytes = fs.readFileSync(files.sig);
  const manifest = verifyManifest(manifestBytes, sigBytes, { key });
  const tarBuf = fs.readFileSync(files.tarball);
  if (crypto.createHash("sha256").update(tarBuf).digest("hex") !== manifest.sha256.toLowerCase()) throw new Error("tarball sha256 does not match the manifest");
  if (version !== undefined && manifest.version !== version) throw new Error(`the manifest is for ${manifest.version}, not ${version}`);
  const floor = readFloor(floorPath);
  if (strictFloor) checkFloor(manifest.version, floor);
  else if (floor && compareVersions(manifest.version, floor) < 0) throw new Error(`version ${manifest.version} is below the floor ${floor}`);
  return { manifest, tarBuf };
}

// ---------------------------------------------------------------------------------------------
// the code tree

/** TODO(capsule-signing): sign Capsule.app inside `dir` with core's own signing key (ADR 0040
 *  section 4) before the flip. Out of scope for phase 4: deliberately a no-op. Never sign
 *  anything outside a freshly extracted, verified tree. @param {string} dir */
export function signCapsule(dir) { void dir; }

/**
 * Point `current` at versions/<version> in one atomic step: write current.new, then rename it
 * over current. A crash before the rename leaves the old current exactly as it was.
 * @param {string} root @param {string} version @param {Run} run
 */
export function flipCurrent(root, version, run) {
  const p = paths(root);
  fs.rmSync(p.currentNew, { recursive: true, force: true });
  fs.symlinkSync(`versions/${version}`, p.currentNew);
  run("/usr/sbin/chown", ["-h", "root:wheel", p.currentNew]);
  fs.renameSync(p.currentNew, p.current);
}

/**
 * Extract a verified tarball into versions/<version> and normalize ownership. Does not flip.
 * Returns a function that discards the previous same-version tree once the flip has happened.
 * @param {{ root: string, run: Run, tar: string }} c
 * @param {string} version @param {Buffer} tarBuf already verified against the manifest
 * @param {{ sha256: string }} manifest
 */
function extractVersion(c, version, tarBuf, manifest) {
  const p = paths(c.root);
  mkdirMode(p.base, 0o755);
  chown(c.run, "root:wheel", p.base);
  const work = fs.mkdtempSync(path.join(p.base, ".work-"));
  fs.chmodSync(work, 0o700);
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
  const dest = path.join(p.versions, version);
  let aside = null;
  try {
    const file = path.join(work, "vyre.tgz");
    fs.writeFileSync(file, tarBuf, { mode: 0o600 });
    checkTarball(file, manifest);
    mkdirMode(p.versions, 0o755);
    chown(c.run, "root:wheel", p.versions);
    if (fs.existsSync(dest)) { aside = `${dest}.old-${rand()}`; fs.renameSync(dest, aside); }
    extract(file, dest, { tar: c.tar });
    if (!fs.existsSync(path.join(dest, "core", "vyre-core", "main.js"))) throw new Error("the release has no vyre-core in it");
    chown(c.run, "root:wheel", dest, true);
    signCapsule(dest);
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    if (aside) try { fs.renameSync(aside, dest); } catch { /* leave it aside rather than lose it */ }
    cleanup();
    throw e;
  }
  return () => { cleanup(); if (aside) fs.rmSync(aside, { recursive: true, force: true }); };
}

// ---------------------------------------------------------------------------------------------
// the account

/** @param {string} out @returns {Set<number>} */
function ids(out) {
  const s = new Set();
  for (const line of String(out).split("\n")) { const n = Number(line.trim().split(/\s+/).pop()); if (Number.isInteger(n)) s.add(n); }
  return s;
}
/** @param {Run} run @param {string[]} a @returns {string | null} */
function tryRun(run, a) { try { return run(a[0], a.slice(1)); } catch { return null; } }
const DSCL = "/usr/bin/dscl";

/** Create the _vyre user and group. Skips whichever exists, so a re-run repairs. @param {Run} run */
export function ensureAccount(run) {
  const groupRead = tryRun(run, [DSCL, ".", "-read", `/Groups/${ACCOUNT}`, "PrimaryGroupID"]);
  const userRead = tryRun(run, [DSCL, ".", "-read", `/Users/${ACCOUNT}`, "UniqueID"]);
  /** @type {string[]} */ const did = [];
  let gid = groupRead === null ? null : Number((groupRead.match(/(\d+)/) || [])[1]);
  if (groupRead !== null && !Number.isInteger(gid)) throw new Error(`could not read the ${ACCOUNT} group id`);
  const used = () => new Set([...ids(run(DSCL, [".", "-list", "/Users", "UniqueID"])), ...ids(run(DSCL, [".", "-list", "/Groups", "PrimaryGroupID"]))]);
  const free = () => {
    const u = used();
    for (let i = UID_MIN; i <= UID_MAX; i++) if (!u.has(i)) return i;
    throw new Error(`no free id in ${UID_MIN}-${UID_MAX}`);
  };
  if (groupRead === null) {
    gid = free();
    run(DSCL, [".", "-create", `/Groups/${ACCOUNT}`]);
    run(DSCL, [".", "-create", `/Groups/${ACCOUNT}`, "PrimaryGroupID", String(gid)]);
    run(DSCL, [".", "-create", `/Groups/${ACCOUNT}`, "RealName", "Vyre core"]);
    did.push("group");
  }
  if (userRead === null) {
    const uid = ids(run(DSCL, [".", "-list", "/Users", "UniqueID"])).has(/** @type {number} */ (gid)) ? free() : /** @type {number} */ (gid);
    const u = `/Users/${ACCOUNT}`;
    run(DSCL, [".", "-create", u]);
    run(DSCL, [".", "-create", u, "UniqueID", String(uid)]);
    run(DSCL, [".", "-create", u, "PrimaryGroupID", String(gid)]);
    run(DSCL, [".", "-create", u, "UserShell", "/usr/bin/false"]);
    run(DSCL, [".", "-create", u, "RealName", "Vyre core"]);
    run(DSCL, [".", "-create", u, "NFSHomeDirectory", "/var/empty"]);
    run(DSCL, [".", "-create", u, "IsHidden", "1"]);
    did.push("user");
  }
  return did;
}

// ---------------------------------------------------------------------------------------------
// plists

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** @param {any} v @param {string} pad */
function xml(v, pad) {
  if (typeof v === "boolean") return `${pad}<${v}/>\n`;
  if (typeof v === "number") return `${pad}<integer>${v}</integer>\n`;
  if (typeof v === "string") return `${pad}<string>${esc(v)}</string>\n`;
  if (Array.isArray(v)) return `${pad}<array>\n${v.map((x) => xml(x, pad + "  ")).join("")}${pad}</array>\n`;
  return `${pad}<dict>\n${Object.entries(v).map(([k, x]) => `${pad}  <key>${esc(k)}</key>\n${xml(x, pad + "  ")}`).join("")}${pad}</dict>\n`;
}
/** @param {Record<string, any>} dict */
export function plistXml(dict) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${xml(dict, "")}</plist>\n`;
}

/**
 * The plists as objects, keyed by label. Core's environment holds VYRE_CORE_OWNER and nothing
 * else. vyred runs as the OWNER, never root and never _vyre.
 * @param {Opts} o
 */
export function buildPlists(o) {
  checkOpts(o);
  const home = o.ownerHome || `/Users/${o.ownerName}`;
  /** @type {Record<string, Record<string, any>>} */
  const out = {
    [LABELS.core]: {
      Label: LABELS.core,
      ProgramArguments: [RUNTIME.node, RUNTIME.mainJs, "serve"],
      UserName: ACCOUNT,
      EnvironmentVariables: { VYRE_CORE_OWNER: String(o.ownerUid) },
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
    },
    // Root, no sockets: wakes when something lands in the folder _vyre owns, then re-verifies
    // everything itself.
    [LABELS.update]: {
      Label: LABELS.update,
      ProgramArguments: [RUNTIME.node, RUNTIME.installMainJs, "apply"],
      WatchPaths: [RUNTIME.staging],
    },
    [LABELS.vyred]: {
      Label: LABELS.vyred,
      ProgramArguments: [o.vyredWrapper],
      UserName: o.ownerName,
      EnvironmentVariables: { HOME: home, ...(o.ghBin ? { VYRE_GH_BIN: o.ghBin } : {}) },
      RunAtLoad: true,
      KeepAlive: true,
    },
  };
  if (o.colimaAgent) {
    out[LABELS.colima] = {
      Label: LABELS.colima,
      ProgramArguments: /** @type {string[]} */ (o.colimaProgram),
      UserName: o.ownerName,
      EnvironmentVariables: { HOME: home },
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// install

/**
 * Do the install. Returns the one-time enrolment code (and its expiry); the caller hands it on
 * and never stores it. Every step is idempotent.
 * @param {Opts} opts
 * @param {Seams} [seams]
 * @returns {{ code: string, expires: number }}
 */
export function install(opts, seams = {}) {
  checkOpts(opts);
  const run = seams.run || defaultRun;
  const root = seams.root || "/";
  const step = seams.step || (() => {});
  const p = paths(root);
  const tar = seams.tar || defTar();
  const steps = plan(opts);
  const done = (id) => step(/** @type {any} */ (steps.find((s) => s.id === id)).name);

  // 1. Verify, before anything changes.
  const nodeSt = fs.statSync(opts.nodeBinary);
  if (!nodeSt.isFile()) throw new Error("nodeBinary is not a file");
  const { manifest, tarBuf } = verifyRelease(opts.release, { key: seams.key || RELEASE_KEY, floorPath: p.floor, strictFloor: false, version: opts.version });
  done("verify-release");

  // 2. The account.
  ensureAccount(run);
  done("account");

  // 3. Code tree, atomic flip, floor.
  const finish = extractVersion({ root, run, tar }, manifest.version, tarBuf, manifest);
  flipCurrent(root, manifest.version, run);
  finish();
  raiseFloor(p.floor, manifest.version);
  chown(run, "root:wheel", p.floor);
  done("code-tree");

  // The bundled node: copied, never the person's own on PATH.
  const nodeNew = `${p.node}.new`;
  fs.copyFileSync(opts.nodeBinary, nodeNew);
  fs.chmodSync(nodeNew, 0o755);
  chown(run, "root:wheel", nodeNew);
  fs.renameSync(nodeNew, p.node);
  done("node");

  // 4. Folders.
  const owned = `${ACCOUNT}:${ACCOUNT}`;
  mkdirMode(p.data, 0o700); chown(run, owned, p.data);
  mkdirMode(p.staging, 0o700); chown(run, owned, p.staging);
  mkdirMode(p.socketDir, 0o755); chown(run, owned, p.socketDir);
  // Where vyred finds core: root-owned core.json naming the socket and core's uid (readCoreConfig).
  const coreUid = Number(((run(DSCL, [".", "-read", `/Users/${ACCOUNT}`, "UniqueID"]) || "").match(/(\d+)/) || [])[1]);
  if (!Number.isInteger(coreUid) || coreUid <= 0) throw new Error(`could not read the ${ACCOUNT} user id`);
  const cfgTmp = `${p.coreJson}.tmp-${rand()}`;
  fs.writeFileSync(cfgTmp, JSON.stringify({ socket: `${RT.socketDir}/vyre-core.sock`, uid: coreUid }) + "\n", { mode: 0o644 });
  fs.chmodSync(cfgTmp, 0o644);
  chown(run, "root:wheel", cfgTmp);
  fs.renameSync(cfgTmp, p.coreJson);
  done("dirs");

  // 5. Plists.
  const plists = buildPlists(opts);
  mkdirMode(p.daemons, 0o755);
  for (const [label, dict] of Object.entries(plists)) {
    const file = p.plist(label);
    const tmp = `${file}.tmp-${rand()}`;
    fs.writeFileSync(tmp, plistXml(dict), { mode: 0o644 });
    fs.chmodSync(tmp, 0o644);
    chown(run, "root:wheel", tmp);
    fs.renameSync(tmp, file);
  }
  done("plists");

  // 6. Load them, core first. Bootout first if already loaded, so a re-run picks up new plists.
  for (const label of Object.keys(plists)) {
    if (tryRun(run, ["/bin/launchctl", "print", `system/${label}`]) !== null) run("/bin/launchctl", ["bootout", `system/${label}`]);
    run("/bin/launchctl", ["bootstrap", "system", p.plist(label)]);
  }
  done("launchd");

  // 7. The enrolment code, as _vyre, from the bundled node and the tree we just verified.
  const out = run("/usr/bin/sudo", ["-n", "-u", ACCOUNT, "/usr/bin/env", "-i", `PATH=${SAFE_PATH}`, `VYRE_CORE_OWNER=${opts.ownerUid}`, RUNTIME.node, RUNTIME.mainJs, "code"]);
  const [code, expires] = String(out).trim().split(/\s+/);
  if (!code) throw new Error("vyre-core did not print an enrolment code");
  done("enrol-code");
  return { code, expires: Number(expires) || 0 };
}

// ---------------------------------------------------------------------------------------------
// uninstall

/**
 * @param {{ purge?: boolean, colimaAgent?: boolean }} [opts]
 * @param {Seams} [seams]
 */
export function uninstall(opts = {}, seams = {}) {
  const run = seams.run || defaultRun;
  const root = seams.root || "/";
  const step = seams.step || (() => {});
  const p = paths(root);
  for (const label of [LABELS.colima, LABELS.vyred, LABELS.update, LABELS.core]) {
    const file = p.plist(label);
    if (fs.existsSync(file) || tryRun(run, ["/bin/launchctl", "print", `system/${label}`]) !== null) tryRun(run, ["/bin/launchctl", "bootout", `system/${label}`]);
    fs.rmSync(file, { force: true });
  }
  step("stopped and removed the LaunchDaemons");
  for (const d of [p.coreJson, p.versions, p.current, p.currentNew, p.node, `${p.node}.new`, p.socketDir, p.staging]) fs.rmSync(d, { recursive: true, force: true });
  step("removed the code, the bundled node and the socket folder");
  if (opts.purge) {
    fs.rmSync(p.data, { recursive: true, force: true });
    fs.rmSync(p.floor, { force: true });
    try { fs.rmdirSync(p.base); } catch { /* not empty: leave it */ }
    tryRun(run, [DSCL, ".", "-delete", `/Users/${ACCOUNT}`]);
    tryRun(run, [DSCL, ".", "-delete", `/Groups/${ACCOUNT}`]);
    step(`deleted the data and the ${ACCOUNT} account`);
  } else step(`kept the data folder and the ${ACCOUNT} account`);
}

// ---------------------------------------------------------------------------------------------
// apply (the root update daemon)

export const STAGED = Object.freeze({ tarball: "vyre.tgz", manifest: "manifest.json", sig: "manifest.sig" });

/** @param {string} dir */
function emptyDir(dir) {
  for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
}

/**
 * Apply a staged release. core writes vyre.tgz and manifest.json, then manifest.sig LAST (by
 * rename); with no sig yet there is nothing to do. Everything is re-verified here, from bytes
 * read once, and old versions are refused by the floor. A refusal empties staging and throws.
 * A crash between extract and flip leaves the old version current.
 * @param {Seams} [seams]
 * @returns {{ status: "empty" | "waiting" | "applied", version?: string }}
 */
export function apply(seams = {}) {
  const run = seams.run || defaultRun;
  const root = seams.root || "/";
  const step = seams.step || (() => {});
  const p = paths(root);
  const tar = seams.tar || defTar();
  if (!fs.existsSync(p.staging)) return { status: "empty" };
  const names = fs.readdirSync(p.staging);
  if (!names.length) return { status: "empty" };
  const files = { tarball: path.join(p.staging, STAGED.tarball), manifest: path.join(p.staging, STAGED.manifest), sig: path.join(p.staging, STAGED.sig) };
  if (!Object.values(files).every((f) => fs.existsSync(f))) return { status: "waiting" };
  let verified;
  try {
    verified = verifyRelease(files, { key: seams.key || RELEASE_KEY, floorPath: p.floor, strictFloor: true });
  } catch (e) {
    emptyDir(p.staging);
    throw e;
  }
  step(`verified ${verified.manifest.version}`);
  let finish;
  try {
    finish = extractVersion({ root, run, tar }, verified.manifest.version, verified.tarBuf, verified.manifest);
  } catch (e) {
    emptyDir(p.staging);
    throw e;
  }
  step("extracted");
  flipCurrent(root, verified.manifest.version, run);
  finish();
  raiseFloor(p.floor, verified.manifest.version);
  run("/bin/launchctl", ["kickstart", "-k", `system/${LABELS.core}`]);
  emptyDir(p.staging);
  step(`now on ${verified.manifest.version}`);
  return { status: "applied", version: verified.manifest.version };
}
