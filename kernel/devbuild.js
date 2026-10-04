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

/** The one line a packaged daemon prints when it is asked to start with the kernel off. */
/** What a release-kind build says when VYRE_KERNEL=0 is set: it is ignored, and the kernel stays on. */
export const KERNEL_FLAG_IGNORED = "VYRE_KERNEL=0 is ignored: this build always runs with the kernel on";
export const KERNEL_OFF_REFUSAL = "This Vyre release does not run with its security layer off.";

/**
 * Is the kernel on for this start? On by default. `opts.kernel` decides when it is given; else VYRE_KERNEL=0 turns it off in a development build only (the one-release flag, so a
 * regression needs no rollback), and a packaged build ignores the variable, so something that can set an environment cannot weaken it. @param {{ kernel?: boolean }} opts @param {Record<string, string | undefined>} [env] @param {string} [root]
 */
export const kernelWanted = (opts, env = process.env, root) => (typeof opts.kernel === "boolean" ? opts.kernel : !(env.VYRE_KERNEL === "0" && !isPackaged(root)));

/**
 * MA-5: every protection the kernel gates applies only with the kernel on, so a packaged build refuses to start without it. Returns the refusal line, or null when the start may go ahead
 * (the kernel is on, or this is a development checkout). @param {boolean} kernelOn @param {string} [root]
 */
export const kernelOffRefusal = (kernelOn, root) => (kernelOn || !isPackaged(root) ? null : KERNEL_OFF_REFUSAL);
