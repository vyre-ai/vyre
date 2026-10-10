// @ts-check
// What a lender's runner says about itself in the signed hello (R031-95 2.2): its version and the protocol it speaks to the home. The home keeps RUNNER_PROTOCOL_MIN: a runner older than that is told so (2.6).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 2: every write names the session's epoch, the heartbeat and the release exist (R031-95 2.4). A runner older than the home's minimum is told so and never half-runs a session (2.6).
export const RUNNER_PROTOCOL = 2;
export const RUNNER_PROTOCOL_MIN = 2;
/** @type {string | null} */ let version = null;
/** This runner's version, read from the package once. */
export function runnerVersion() {
  if (version) return version;
  try { version = String(JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")).version || "0.0.0"); } catch { version = "0.0.0"; }
  return /^[0-9A-Za-z._+-]{1,40}$/.test(version) ? version : "0.0.0";
}
