// kernel/devbuild.js: is this daemon a packaged release, or a development tree? It is decided when the build is made, not by a file a user can delete: lib/build-kind.js
// says "development" in a checkout, and scripts/build-site.sh stamps "release" into the package it signs. Anything but the exact word "development" (a missing,
// unreadable or edited-away file included) means packaged. The developer switches that turn K-3 (a file key) and K-2 (the path rule for first-party modules) off are
// honoured only in a development build: in a packaged daemon an environment variable that someone else can set must not weaken the kernel.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_LINE } from "../lib/build-kind-text.js";

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** @type {unknown} */ let COMPILED = null;
try { COMPILED = (await import("../lib/build-kind.js")).BUILD_KIND; } catch { COMPILED = null; }

/**
 * True unless the build says "development". With a `root` (tests) the kind is read from that folder's lib/build-kind.js text instead, so a fixture can be either kind;
 * a carried release signature (SHA256SUMS.sig) also means packaged. @param {string} [root]
 */
export function isPackaged(root) {
  if (root === undefined) return COMPILED !== "development" || fs.existsSync(path.join(PKG_ROOT, "SHA256SUMS.sig"));
  let text = "";
  try { text = fs.readFileSync(path.join(root, "lib", "build-kind.js"), "utf8"); } catch { return true; }
  return !text.includes(DEV_LINE) || fs.existsSync(path.join(root, "SHA256SUMS.sig"));
}

/** Is an environment developer switch honoured here? Only in a development build, and only when it is exactly "1". @param {string | undefined} value @param {string} [root] */
export function devSwitch(value, root) { return value === "1" && !isPackaged(root); }

/**
 * MA-5, as ruled: every protection the kernel gates applies only with the kernel on, so a release-kind build ALWAYS runs with it on. An opt-out (VYRE_KERNEL=0, `opts.kernel === false`) is ignored there,
 * not refused: the daemon starts, says so in its log and in its status (`ignored`). A development checkout keeps today's rule (on when asked: opts.kernel, or VYRE_KERNEL=1).
 * @param {{ kernel?: boolean }} opts @param {string} [root] a package folder, for tests @param {Record<string, string | undefined>} [env]
 * @returns {{ on: boolean, ignored: string | null }}
 */
export function kernelPlan(opts, root, env = process.env) {
  const asked = opts.kernel === true || (opts.kernel === undefined && env.VYRE_KERNEL === "1");
  if (!isPackaged(root)) return { on: asked, ignored: null };
  const optedOut = opts.kernel === false ? "opts.kernel=false" : opts.kernel === undefined && env.VYRE_KERNEL === "0" ? "VYRE_KERNEL=0" : null;
  return { on: true, ignored: optedOut };
}
