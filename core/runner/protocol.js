// @ts-check
// What a lender's runner says about itself in the signed hello (R031-95 2.2): its version and the protocol it speaks to the home. The home keeps RUNNER_PROTOCOL_MIN: a runner older than that is told so (2.6).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devSwitch } from "../../kernel/devbuild.js";

export const RUNNER_PROTOCOL = 1;
export const RUNNER_PROTOCOL_MIN = 1;
/** @type {string | null} */ let version = null;
/** This runner's version, read from the package once. */
export function runnerVersion() {
  if (version) return version;
  try { version = String(JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")).version || "0.0.0"); } catch { version = "0.0.0"; }
  return /^[0-9A-Za-z._+-]{1,40}$/.test(version) ? version : "0.0.0";
}

/** Does the home ask a lender's computer to sign its lease request? Always, except where a development build is told VYRE_SIGNED_LEASES_OFF=1; a packaged build ignores the switch (S1). @param {Record<string, string | undefined>} env @param {string} [root] */
export function signedLeasesWanted(env, root) { return !devSwitch(env.VYRE_SIGNED_LEASES_OFF, root); }
