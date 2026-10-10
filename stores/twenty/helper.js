// @ts-check
// The daemon's side of the Space helper (box/vyre `space-helper`, docs/work/space-helper.md). On a box the daemon runs in a container with no Docker of its own: a Space's Twenty is
// started, stopped and removed by a root helper on the host, asked for through a spool. The daemon drops one small file `req-<32 hex>` holding `<verb> <space>` into the spool (a folder only
// it can write, mounted at /run/vyre-spaces) and reads the answer from `status-<id>` in the status folder root owns (mounted read-only at /run/vyre-spaces-state): `running`, then `ok`, `failed`
// or `busy` with a short message. A request carries nothing but the verb and the Space's name: no path, image, secret or flag. Nothing here runs a command.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SPOOL_DIR = "/run/vyre-spaces";
export const STATE_DIR = "/run/vyre-spaces-state";
const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const VERBS = new Set(["up", "stop", "down", "app-up", "app-stop", "app-down", "pub-build", "pub-up", "pub-stop", "pub-down"]);
/** A published server is asked for by its deployment's id (team/contracts/builder.md). */
const PUB_VERBS = new Set(["pub-build", "pub-up", "pub-stop", "pub-down"]);
const DEP = /^dep_[0-9a-f]{16}$/;

/** @typedef {{ spool?: string, state?: string }} HelperDirs */

/** Is the helper's spool here: both folders exist and the spool can be written? This is the box's capability check for Twenty (the host has Docker, the container does not). @param {HelperDirs} [d] */
export function helperPresent(d = {}) {
  const spool = d.spool ?? SPOOL_DIR, state = d.state ?? STATE_DIR;
  try {
    if (!fs.statSync(spool).isDirectory() || !fs.statSync(state).isDirectory()) return false;
    fs.accessSync(spool, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

/**
 * Ask the helper for one verb and wait for its answer. Resolves `{ state: "ok", message }`; a refusal or a failure rejects with the helper's own short message.
 * @param {"up" | "stop" | "down" | "app-up" | "app-stop" | "app-down" | "pub-build" | "pub-up" | "pub-stop" | "pub-down"} verb @param {string} name the Space's compose name (`spc-abc...`), or an app module's name for the app verbs
 * @param {HelperDirs & { what?: string, timeoutMs?: number, pollMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number, log?: (m: string) => void }} [o]
 */
export async function askHelper(verb, name, o = {}) {
  if (!VERBS.has(verb) || !(PUB_VERBS.has(verb) ? DEP.test(name) : NAME.test(name))) throw Object.assign(new Error("not a request the helper knows"), { code: "invalid" });
  const spool = o.spool ?? SPOOL_DIR, state = o.state ?? STATE_DIR;
  const sleep = o.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const id = crypto.randomBytes(16).toString("hex");
  const tmp = path.join(spool, `.tmp-${id}`);
  fs.writeFileSync(tmp, `${verb} ${name}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, path.join(spool, `req-${id}`));
  const deadline = now() + (o.timeoutMs ?? 30 * 60_000);
  let last = "";
  for (;;) {
    /** @type {any} */ let st = null;
    try { st = JSON.parse(fs.readFileSync(path.join(state, `status-${id}`), "utf8")); } catch { st = null; }
    if (st && st.id === id) {
      if (st.state === "ok") return { state: "ok", message: String(st.message || "") };
      if (st.state === "failed" || st.state === "busy") throw Object.assign(new Error(`the server could not ${verb} ${o.what ?? "this space's store"}: ${String(st.message || st.state)}`), { code: st.state === "busy" ? "unavailable" : "failed" });
      if (st.state === "running" && st.message !== last) { last = String(st.message || ""); if (o.log) o.log(`helper ${verb}: ${last}`); }
    }
    if (now() > deadline) throw Object.assign(new Error(`the server did not answer a request to ${verb} ${o.what ?? "this space's store"} in time (wait a minute and try again)`), { code: "unavailable" });
    await sleep(o.pollMs ?? 1000);
  }
}

/**
 * A provisioning Runner (stores/twenty/provision.js) for a box: the docker calls `provisionSpace` makes become requests to the helper. Pulling images is the helper's own step; starting the project is
 * the helper's `up` (it also joins this container to the Space's network, so Twenty is reached by its alias); stopping and removing are `stop` and `down`. Anything else the Runner is asked to run
 * (an exec in a container, a volume tar) is not something the helper does, and is refused plainly.
 * @param {string} name the Space's compose name @param {HelperDirs & { log?: (m: string) => void, sleep?: (ms: number) => Promise<void>, timeoutMs?: number, pollMs?: number }} [o]
 */
export function helperRunner(name, o = {}) {
  /** @type {Promise<any> | null} */ let up = null;
  const none = { stdout: "", stderr: "" };
  return {
    /** @param {string} cmd @param {string[]} args */
    async exec(cmd, args) {
      if (cmd !== "docker") throw new Error(`the helper does not run ${cmd}`);
      if (args[0] === "network") return none; // the helper already put this container on the Space's network
      if (args[0] !== "compose") throw new Error(`the helper does not run docker ${args[0]}`);
      if (args.includes("pull")) return none;
      if (args.includes("up")) { up = up ?? askHelper("up", name, o); await up; return none; }
      if (args.includes("stop")) { await askHelper("stop", name, o); up = null; return none; }
      if (args.includes("down")) { await askHelper("down", name, o); up = null; return none; }
      throw new Error("the helper does not run that compose command");
    },
    fetch,
    sleep: o.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))),
    /**
     * The admin password root made for a Space started from the saved database (the helper's `status/admin-<name>`, readable by this uid only, removed by root after ten minutes), or null when root
     * did not use the saved database. A server's provisioning asks after the Space is up, and signs in with it once.
     */
    async adminPassword() {
      try { const t = fs.readFileSync(path.join(o.state ?? STATE_DIR, `admin-${name}`), "utf8").trim(); return /^[0-9a-f]{32,128}$/.test(t) ? t : null; } catch { return null; }
    },
  };
}
