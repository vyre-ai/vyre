// @ts-check
// The test box keeps one directory per Space ever made (/var/lib/vyre-spaces/private/spaces) and its helper refuses a new Space at VYRE_SPACES_CAP (16): "too many Spaces on this server". A walk removes its
// containers but not those directories, so after sixteen walks every Records start waited 20 minutes and failed. This clears them: at a walk's START when no Docker stack is running (nothing of anyone's to
// lose) and at its END for the stacks of its own Space. Only on a box the walk owns (VYRE_JOURNEY_BOX=1 or a CI runner); it does nothing anywhere else, and a missing sudo or path is not an error.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const SLOTS = "/var/lib/vyre-spaces/private";
const mine = () => process.env.VYRE_JOURNEY_BOX === "1" || process.env.CI === "true";
const docker = (/** @type {string[]} */ args) => spawnSync("docker", args, { encoding: "utf8" });

/** Containers that are running now, one name per line. */
const running = () => String(docker(["ps", "--format", "{{.Names}}"]).stdout || "").split("\n").filter(Boolean);

/** Free the Space slots when no stack is running. Answers what it did, for the walk's log. */
export function clearSpaceSlots() {
  if (!mine()) return "not a box this walk owns: slots left alone";
  const up = running();
  if (up.length) return `slots left alone: ${up.length} container(s) are running (${up.slice(0, 3).join(", ")})`;
  if (!fs.existsSync("/var/lib/vyre-spaces")) return "no Space helper here: nothing to clear";
  const r = spawnSync("sudo", ["-n", "sh", "-c", `rm -rf ${SLOTS}/spaces/* ; rm -f /var/lib/vyre-spaces/status/status-*`], { encoding: "utf8" });
  return r.status === 0 ? "Space slots cleared" : `slots not cleared (${String(r.stderr || "").trim().slice(0, 80) || "no sudo"})`;
}

/** At a walk's end: remove the Records stacks (containers and volumes) its Space made, then free the slots if nothing else is running. */
export function removeOwnStacks() {
  if (!mine()) return;
  const names = String(docker(["ps", "-a", "--format", "{{.Names}}", "--filter", "name=vyre-spc-"]).stdout || "").split("\n").filter(Boolean);
  if (names.length) docker(["rm", "-f", ...names]);
  const vols = String(docker(["volume", "ls", "-q", "--filter", "name=vyre-spc-"]).stdout || "").split("\n").filter(Boolean);
  if (vols.length) docker(["volume", "rm", ...vols]);
  clearSpaceSlots();
}
