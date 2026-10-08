// @ts-check
// RULES.md, "Every printed word is product copy": no cute sign-offs and no filler in what the installers print. The last thing
// install-box.sh prints is the next step, not a send-off. Scans the printed lines of the three installers for banned phrases.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLERS = ["scripts/install-box.sh", "scripts/install-mac-server.sh", "scripts/install-windows.ps1"];
const BANNED = /best work|keep the thread|end the week|a fine moment for a coffee|grab a coffee|enjoy|cheers|have fun|sit back|hang tight|voila/i;
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");

test("the installers print no sign-off or filler", () => {
  const bad = [];
  for (const f of INSTALLERS) read(f).split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    if (BANNED.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 110)}`);
  });
  assert.deepEqual(bad, [], `sign-offs or filler in installer output (say what happened and what to do next):\n${bad.join("\n")}`);
});

test("install-box.sh finish() ends on the next step, with no line after it but a blank one", () => {
  const src = read("scripts/install-box.sh");
  const body = src.slice(src.indexOf("\nfinish() {"));
  const fn = body.slice(0, body.indexOf("\n}\n"));
  const says = fn.split("\n").map(l => l.trim()).filter(l => l.startsWith("say "));
  assert.equal(says[says.length - 1], 'say ""', "finish() closes with one blank line");
  const lastText = says.filter(l => l !== 'say ""').pop() || "";
  assert.match(lastText, /Run it again|Start it|run that on your own computer|Go back to the Vyre app|stdout|Open the Vyre app, choose|Go back to the Vyre app/, "the last printed text says what to do next");
});

test("IR-4 the Docker installer and the box wrapper print no internal product name, and no \"(s)\"", () => {
  const bad = [];
  for (const f of ["scripts/install-box.sh", "box/vyre"]) read(f).split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line) || !/\b(say|die|echo) "/.test(line)) return;
    // A command a person types names its tool (vyre call wink.server.code) and a compose project is a program name: both are commands, not prose.
    const prose = line.replace(/\bwink\.[a-z.]+/g, "").replace(/vyre-\$n-twenty/g, "");
    if (/\b(Twenty|Wink|kernel|Headscale|vyred)\b|\(s\)/i.test(prose)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 110)}`);
  });
  assert.deepEqual(bad, [], `internal names in what a person reads:\n${bad.join("\n")}`);
});
