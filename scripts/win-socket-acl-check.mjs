#!/usr/bin/env node
// @ts-check
// Windows CI only (ADR 0037's LOW, security review): proves the local vyred socket's folder and
// the socket file itself carry an explicit ACL naming only the current user, SYSTEM and
// Administrators, nothing broader (Users, Everyone, Authenticated Users). Run against real
// icacls output on windows-latest by .github/workflows/node.yml's windows-socket-acl job.
//
//   node scripts/win-socket-acl-check.mjs <dir> <socket-path>
//
// The parser (evaluateAcl) is exported and unit-tested off Windows against sample icacls text
// (scripts/win-socket-acl-check.test.js); only the real spawnSync call below needs a Windows box.

import { spawnSync } from "node:child_process";
import os from "node:os";

/**
 * icacls prints one path line, then one "PRINCIPAL:(flags)" line per ACE (continuation lines
 * indented), then a blank summary. The path and the first ACE can share a line, separated by a
 * space, which is why `target` is stripped from the front of that line rather than split on
 * whitespace (a path can itself contain spaces).
 * @param {string} output @param {string} target
 * @param {{ user: string, computer: string }} who
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function evaluateAcl(output, target, who) {
  const user = who.user.toLowerCase();
  const computer = who.computer.toLowerCase();
  const allowed = [
    new RegExp(`^(${computer}\\\\)?${user}$`, "i"),
    /^(nt authority\\)?system$/i,
    /^(builtin\\)?administrators$/i,
  ];
  const violations = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes(":(")) continue;
    const acePart = line.includes(target) ? line.slice(line.indexOf(target) + target.length).trim() : line;
    const principal = acePart.slice(0, acePart.indexOf(":(")).trim();
    if (!principal) continue;
    if (!allowed.some(re => re.test(principal))) violations.push(principal);
  }
  return { ok: violations.length === 0, violations };
}

/** @param {string} target @param {{ user: string, computer: string }} who */
function check(target, who) {
  const r = spawnSync("icacls", [target], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    console.error(`icacls ${target} failed: ${r.error?.message || r.stderr || r.stdout}`);
    return false;
  }
  console.log(`--- icacls ${target} ---\n${r.stdout}`);
  const { ok, violations } = evaluateAcl(r.stdout, target, who);
  for (const v of violations) console.error(`${target}: unexpected principal on the ACL: "${v}"`);
  return ok;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , dir, sock] = process.argv;
  if (!dir || !sock) { console.error("usage: win-socket-acl-check.mjs <dir> <socket-path>"); process.exit(2); }
  const who = { user: process.env.USERNAME || os.userInfo().username, computer: process.env.COMPUTERNAME || os.hostname() };
  const dirOk = check(dir, who);
  const sockOk = check(sock, who);
  process.exit(dirOk && sockOk ? 0 : 1);
}
