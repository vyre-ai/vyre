// @ts-check
// `irm https://vyre.run/w | iex` runs scripts/install-windows.ps1: build-site.sh puts it at site/w, site/_headers serves it as plain text, release-check
// compares it, and the script itself points at a real release (a stable tag's VyreSetup.exe and SHA256SUMS) and says what it does not verify.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = f => fs.readFileSync(path.join(REPO, f), "utf8");

test("vyre.run/w: built from the script, served as plain text, compared by release-check, ignored by git like install.sh", () => {
  assert.match(read("scripts/build-site.sh"), /cp "\$src\/scripts\/install-windows\.ps1" "\$here\/site\/w"/);
  assert.match(read("site/_headers"), /\n\/w\n\s+Content-Type: text\/plain; charset=utf-8\n\s+X-Content-Type-Options: nosniff/);
  assert.match(read("scripts/release-check.sh"), /site\/w differs from scripts\/install-windows\.ps1/);
  assert.match(read("scripts/release-check.sh"), /\$base\/w is not served as text\/plain/);
  assert.ok(read(".gitignore").split("\n").includes("site/w"));
});

test("install-windows.ps1: points at a real release, checks the installer against SHA256SUMS, and says plainly what it does not check", () => {
  const ps = read("scripts/install-windows.ps1");
  assert.ok(!/Not yet pointed at a\s+real release/.test(ps.replace(/\s+/g, " ").replace("#", "")) && !/Not yet pointed/.test(ps), "the stale status line is gone");
  assert.match(ps, /\$exeUrl\s+= "\$ReleaseBase\/VyreSetup\.exe"/);
  assert.match(ps, /\$sumsUrl = "\$ReleaseBase\/SHA256SUMS"/);
  assert.match(ps, /\(v\\d\+\\\.\\d\+\\\.\\d\+\)/, "only a plain stable vX.Y.Z tag is chosen, never a prerelease");
  assert.match(ps, /SHA256SUMS must list VyreSetup\.exe exactly once/);
  assert.match(ps, /does NOT check SHA256SUMS\.sig/);
  assert.ok(!/VyreSetup\.msi/.test(ps), "no link to an installer that does not exist");
});

test("install-windows.ps1: checks for Tailscale, tells the person where to get it, and never installs it", () => {
  const ps = read("scripts/install-windows.ps1");
  assert.match(ps, /function Test-Tailscale/);
  assert.match(ps, /Write-TailscaleNote\r?\n/);
  assert.match(ps, /Tailscale is not on this PC yet/);
  assert.match(ps, /https:\/\/tailscale\.com\/download\/windows/);
  assert.match(ps, /does not install it for you/);
  assert.ok(!/winget|choco|Start-Process[^\n]*tailscale/i.test(ps.replace(/#[^\n]*/g, "")), "no silent install of Tailscale");
  assert.ok(!/\u2014|\u00a7/.test(ps.match(/function Write-TailscaleNote[\s\S]*?\n}/)[0]), "no em dash or section sign in what it prints");
});
