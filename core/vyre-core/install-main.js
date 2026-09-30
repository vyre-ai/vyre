// @ts-check
// The root installer's command line. Run by the person-side installer (scripts/install-mac-server.sh)
// under one sudo, and by launchd for the update daemon.
//
//   install   --owner-uid N --owner-name NAME --release-dir DIR --node PATH --vyred-wrapper PATH
//             [--version V] [--owner-home DIR] [--gh-bin PATH] [--node-sha256 HEX] [--colima-program ARG ...] [--dry-run]
//   uninstall [--purge]
//   apply
//
// DIR holds vyre.tgz, manifest.json and manifest.sig. --version defaults to the manifest's own.
// --colima-program is repeatable, one program argument each (the first an absolute path), and
// turns on the com.vyre.colima agent.
//
// Output: one line per step, "  ok  <name>", on stdout. For `install`, the LAST line on stdout is
//   VYRE_CORE_ENROL=<code>
// and nothing follows it. The parent installer reads that line and hands the code to the person;
// it is never written to disk or logged here. Errors go to stderr with exit status 1.
// Everything except `install --dry-run` refuses to run unless the uid is 0.

import fs from "node:fs";
import path from "node:path";
import { install, uninstall, apply, plan } from "./installer.js";

// The installer makes root-owned trees other accounts must read (core runs as _vyre): a caller's
// umask (the install script's root step uses 077 for its scratch folder) must not narrow them.
process.umask(0o022);

const argv = process.argv.slice(2);
const cmd = argv[0];
const fail = (m) => { process.stderr.write(`vyre-install: ${m}\n`); process.exit(1); };

/** @param {string[]} a */
function parse(a) {
  /** @type {Record<string, string | boolean>} */ const f = {};
  /** @type {string[]} */ const colima = [];
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === "--dry-run" || k === "--purge") f[k.slice(2)] = true;
    else if (k.startsWith("--") && i + 1 < a.length) {
      if (k === "--colima-program") colima.push(a[++i]); else f[k.slice(2)] = a[++i];
    } else fail(`unknown or incomplete option ${k}`);
  }
  return { f, colima };
}

const say = (name) => process.stdout.write(`  ok  ${name}\n`);
const dry = argv.includes("--dry-run");
if (!["install", "uninstall", "apply"].includes(cmd)) fail("usage: install-main.js install|uninstall|apply [options]");
if (!(cmd === "install" && dry) && (!process.getuid || process.getuid() !== 0)) fail("this must run as root");

try {
  const { f, colima } = parse(argv.slice(1));
  if (cmd === "install") {
    for (const k of ["owner-uid", "owner-name", "release-dir", "node", "vyred-wrapper"]) if (typeof f[k] !== "string") fail(`--${k} is required`);
    const dir = path.resolve(String(f["release-dir"]));
    const release = { tarball: path.join(dir, "vyre.tgz"), manifest: path.join(dir, "manifest.json"), sig: path.join(dir, "manifest.sig") };
    let version = typeof f.version === "string" ? f.version : "";
    if (!version) {
      try { version = JSON.parse(fs.readFileSync(release.manifest, "utf8")).version; } catch { fail("could not read the version from manifest.json"); }
    }
    const opts = {
      ownerUid: Number(f["owner-uid"]), ownerName: String(f["owner-name"]), version, release,
      nodeBinary: String(f.node), vyredWrapper: String(f["vyred-wrapper"]),
      ...(typeof f["owner-home"] === "string" ? { ownerHome: f["owner-home"] } : {}),
      ...(typeof f["gh-bin"] === "string" ? { ghBin: f["gh-bin"] } : {}),
      ...(typeof f["node-sha256"] === "string" ? { nodeSha256: f["node-sha256"] } : {}),
      ...(colima.length ? { colimaAgent: true, colimaProgram: colima } : {}),
    };
    if (dry) {
      for (const s of plan(opts)) { process.stdout.write(`would  ${s.name}\n`); for (const d of s.detail) process.stdout.write(`         ${d}\n`); }
    } else {
      const { code } = install(opts, { step: say });
      process.stdout.write(`VYRE_CORE_ENROL=${code}\n`);
    }
  } else if (cmd === "uninstall") {
    uninstall({ purge: f.purge === true }, { step: say });
  } else {
    const r = apply({ step: say });
    if (r.status !== "applied") say(r.status === "waiting" ? "waiting for the whole release to land" : "nothing staged");
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
