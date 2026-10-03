// kernel/devbuild.js: is this daemon a packaged release, or a development tree? A release carries its signed checksums (SHA256SUMS and SHA256SUMS.sig, lib/release-sig.js)
// beside the code; a checkout or a copy made for tests does not. The developer switches that turn K-3 (a file key) and K-2 (the path rule for first-party modules) off are
// honoured only when this says development: in a packaged daemon an environment variable that someone else can set must not weaken the kernel.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** True when `root` (default: this package's own root) carries a release's signed checksums. @param {string} [root] */
export function isPackaged(root = PKG_ROOT) {
  return fs.existsSync(path.join(root, "SHA256SUMS.sig")) || fs.existsSync(path.join(root, "SHA256SUMS"));
}

/** Is an environment developer switch honoured here? Only in a development tree, and only when it is exactly "1". @param {string | undefined} value @param {string} [root] */
export function devSwitch(value, root = PKG_ROOT) { return value === "1" && !isPackaged(root); }
