// @ts-check
// Installs the one pinned chrome-headless-shell the browser tests use (test/headless-chrome.js finds it), so a test that needs a real browser runs on every box and in CI instead of skipping.
// The download is Google's Chrome for Testing; the zip is checked against the hash below before it is unpacked. Idempotent: with the pinned build in place it only prints the path.
// Usage: node scripts/install-test-chrome.mjs   (prints the binary's path)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const PIN = { version: "153.0.8010.12", platform: "linux64", sha256: "a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d" };
export const HOME_DIR = path.join(os.homedir(), ".cache", "vyre", "chrome-headless-shell", PIN.version);
export const BIN = path.join(HOME_DIR, `chrome-headless-shell-${PIN.platform}`, "chrome-headless-shell");

export async function install() {
  if (fs.existsSync(BIN)) return BIN;
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error(`the pinned browser is the ${PIN.platform} build; browser tests run on the Linux test boxes and in CI, not here`);
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${PIN.version}/${PIN.platform}/chrome-headless-shell-${PIN.platform}.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download ${url}: ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash("sha256").update(zip).digest("hex");
  if (got !== PIN.sha256) throw new Error(`the downloaded browser is not the pinned one (sha256 ${got}); nothing was unpacked`);
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const file = path.join(HOME_DIR, "chs.zip");
  fs.writeFileSync(file, zip);
  execFileSync("unzip", ["-q", "-o", file, "-d", HOME_DIR]);
  fs.rmSync(file);
  fs.chmodSync(BIN, 0o755);
  return BIN;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(await install());
