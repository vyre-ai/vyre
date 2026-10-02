// @ts-check
// Every printed word is product copy (team/RULES.md, 2 Oct 2026). The installers and the CLI's install, update, uninstall and
// pairing output follow the website's voice: no filler, no cute sign-offs, no internal names (vyred, the stack, the box, the
// wrapper, the mailbox, units) where a person reads them. This test reads the text those files print, not their logic.
//
// What it checks:
//   1. the strings in say/die/echo/printf/step/ask/done_step/Write-Host/throw (shell, PowerShell) and out/say/fail/beacon/dim
//      (the CLI) hold none of the banned words or phrases below;
//   2. a dry run of install-box.sh prints plain lines, with no sign-off, in plain ASCII.
// The web-started install's behaviour (one next step, no local link) is tested where the output is produced:
// test/install-box-v2.test.js (the installer's last line) and core/cli/commands/up.test.js (vyre up).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const read = f => fs.readFileSync(path.join(REPO, f), "utf8");

const SHELL = ["scripts/install-box.sh", "scripts/install-mac-server.sh", "box/vyre"];
const POWERSHELL = ["scripts/install-windows.ps1"];
const CLI = ["core/cli/commands/up.js", "core/cli/commands/update.js", "core/cli/commands/box.js", "core/cli/ending.js"];

/** Filler and sign-offs that no printed line may carry. */
const FILLER = [
  /best work/i, /keep the thread/i, /end of the week|end the week/i, /nothing changes without asking/i, /a fine moment/i,
  /for a coffee/i, /not ours\b/i, /we'll keep/i, /you've got this/i, /sit back/i, /grab a /i, /buckle up/i,
];
/** Internal names. A person reads "Vyre", "this server", "Vyre's files". */
const INTERNAL = [
  [/\bvyred\b(?![._-])/i, "vyred"],
  [/\b(?:the|this|your|a|an|old|new|earlier|fresh) box\b(?!\/)/i, "the box"],
  [/\bstack\b/i, "the stack"],
  [/\bwrapper\b/, "the wrapper"],
  [/mailbox/i, "the mailbox"],
  [/root-equivalent/i, "root-equivalent"],
  [/\bunits?\b/i, "systemd units"],
];

/** Text that is a command, a file name or a code, not prose. Taken out before the check. */
function strip(text) {
  return text
    .replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, "")        // variables
    .replace(/\bvyre box (?:add|update|move|backup|status|forget)\b/g, "")
    .replace(/\bvyre (?:up|update|uninstall|logs|status) --box\b/g, "")
    .replace(/--box\b/g, "")
    .replace(/\bvyred\.(?:out|pid|sock|log)\b/g, "")
    .replace(/\bbox\/[\w./-]+/g, "")                         // box/compose.yml, box/Dockerfile
    .replace(/\b[\w.-]+\.(?:sh|js|yml|json|ps1|tgz|env|path|service)\b/g, "")
    .replace(/\bvyre-[a-z]+\b/g, "");
}

/** The string literals on lines that print something. */
function printed(file, src) {
  const out = [];
  const lines = src.split("\n");
  const isSh = SHELL.includes(file), isPs = POWERSHELL.includes(file);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("//") || t.startsWith("*")) return;
    if (t.includes("[Unit]")) return;   // the text of a systemd unit file, which a person never reads in this output
    let hit = false;
    if (isSh) hit = /(?:^|[\s;&|({])(?:say|die|echo|printf|step|ask|done_step)\s/.test(line) && !/^\s*printf\s+'%s\\n'\s+"#/.test(line);
    else if (isPs) hit = /Write-Host|\bthrow\b/.test(line);
    else hit = /\b(?:out|say|fail|beacon|dim|ctx\.say)\(|summary:/.test(line);
    if (!hit) return;
    // Skip lines that only parse or compare (a regex, a sed, a case pattern), since they print nothing.
    if (isSh && /\bsed\b|grep -|\bawk\b|\bcase\b.*\)\s*$/.test(line) && !/(?:say|die|echo) "/.test(line)) return;
    const re = isSh ? /"((?:[^"\\]|\\.)*)"|'([^']*)'/g : isPs ? /"((?:[^"`\\]|`.|\\.)*)"|'([^']*)'/g : /"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`|'((?:[^'\\]|\\.)*)'/g;
    for (const m of line.matchAll(re)) {
      const s = m[1] ?? m[2] ?? m[3] ?? "";
      if (/^[\s$%\\a-z0-9_=\-.:/{}()|*+<>[\]]*$/i.test(s) && !/\s[a-z]{3,}\s/i.test(s) && s.split(/\s+/).length < 3) continue; // codes, keys, one-word args
      out.push({ file, line: i + 1, text: s });
    }
  });
  return out;
}

const targets = [...SHELL, ...POWERSHELL, ...CLI];

test("printed copy: no filler or sign-off in the installers or the CLI", () => {
  const bad = [];
  for (const f of targets) for (const p of printed(f, read(f))) for (const re of FILLER) if (re.test(p.text)) bad.push(`${p.file}:${p.line}: ${p.text.slice(0, 100)}`);
  assert.deepEqual(bad, [], `printed filler (team/RULES.md, "Every printed word is product copy"):\n${bad.join("\n")}`);
});

test("printed copy: no internal name where a person reads it", () => {
  const bad = [];
  for (const f of targets) for (const p of printed(f, read(f))) {
    const text = strip(p.text);
    for (const [re, name] of INTERNAL) if (re.test(text)) bad.push(`${p.file}:${p.line}: "${name}" in: ${p.text.slice(0, 110)}`);
  }
  assert.deepEqual(bad, [], `internal names in printed copy (say "Vyre", "this server", "Vyre's files"):\n${bad.join("\n")}`);
});

/** A temp server with stub uname, id, docker and sudo, like test/install-box-look.test.js. */
function server(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-copy-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const stubs = {
    uname: "echo Linux",
    id: 'case "$1" in -u) echo 1000 ;; -un|-gn) echo alex ;; *) exit 1 ;; esac',
    docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; esac; exit 0',
    sudo: 'exec "$@"',
  };
  for (const [name, body] of Object.entries(stubs)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return {
    PATH: `${bin}:/usr/bin:/bin`, HOME: base, VYRE_DIR: path.join(base, "srv", "vyre"),
    VYRE_WRAPPER: path.join(base, "bin-out", "vyre"), VYRE_TUN: "/dev/null", VYRE_DOCKER_SOCK: path.join(base, "none"),
  };
}

test("printed copy: a dry run of the installer reads plainly, in order, with no sign-off", t => {
  const r = spawnSync("sh", [path.join(REPO, "scripts", "install-box.sh"), "--dry-run", "--yes", "--from", REPO], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: server(t) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Installing Vyre on this server\. This takes about 3 minutes\./);
  assert.match(r.stdout, /Vyre's files go in /);
  for (const re of FILLER) assert.doesNotMatch(r.stdout, re);
  for (const [re, name] of INTERNAL) assert.doesNotMatch(strip(r.stdout.replace(/would run: .*|would write .*|would put .*|would download.*|would read .*/g, "")), re, name);
  const last = r.stdout.trim().split("\n").pop() || "";
  assert.match(last, /Run it again without --dry-run to install Vyre\./, "the last line is the next step, not a sign-off");
});
