// @ts-check
// How a session is confined INSIDE the packaged box (ruling of 4 Oct, "b"): the container, a uid of its own per session (an account's, 2000 and up, or the box's one agent) that is never vyred's
// and never root, and the wall. There is no bubblewrap here (the container has no user namespaces and no capabilities to give one). That confinement proves itself before every start, as the
// session's own uid, the way the home sandbox's self-test does: it must be able to use only its own project, and must fail to reach vyred's home, the keys and vault, the daemon's socket, the
// spawner's socket and another agent's home. Any check that fails refuses the start with its name (`sandbox_failed: <check>`); a session never starts unconfined.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAsAgent } from "./client.js";

/** The one program the spawner starts for this (core/spawner/main.js lists it): fixed, in the signed image. */
export const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), "confine-probe.sh");

/**
 * @typedef {{ name: string, path: string }} Out a thing the session must not reach (the name is what a refusal says)
 * @param {{ account?: number | null, shared?: boolean, cwd: string, vyreUid: number, out: Out[], signal?: AbortSignal, timeoutMs?: number, spawn?: typeof spawnAsAgent, probe?: string, socket?: string }} o
 * @returns {Promise<{ ok: boolean, failures: string[], confined_by: "uid", results: { uid: number | null, project: string | null, reached: string[] } }>}
 */
export async function confineSelfTest(o) {
  const spawn = o.spawn || spawnAsAgent;
  const failures = /** @type {string[]} */ ([]);
  // A thing to keep out of reach that is not there proves nothing, so it is a misconfigured box, not a pass.
  const out = o.out.filter(x => { if (fs.existsSync(x.path)) return true; failures.push(`${x.name} is not where the box says it is (${x.path}), so it could not be checked`); return false; });
  const results = { uid: /** @type {number | null} */ (null), project: /** @type {string | null} */ (null), reached: /** @type {string[]} */ ([]) };
  /** @type {any} */ let child = null;
  try {
    child = await spawn([o.probe || PROBE, "allow", o.cwd, "deny", ...out.map(x => x.path)], { cwd: o.cwd, env: { PATH: "/usr/bin:/bin" }, ...(o.account != null ? { account: o.account, shared: Boolean(o.shared) } : {}), ...(o.socket ? { socket: o.socket } : {}) });
  } catch (e) { return { ok: false, failures: [...failures, `the confinement check could not start: ${String(/** @type {Error} */ (e).message || e).slice(0, 160)}`], confined_by: "uid", results }; }
  let text = "";
  child.stdout.on("data", (/** @type {any} */ d) => { text += d; });
  child.stderr.on("data", () => {});
  try { child.stdin.end(); } catch { /* the probe reads nothing */ }
  const killer = () => { try { child.kill("SIGKILL"); } catch {} };
  if (o.signal) { if (o.signal.aborted) killer(); else o.signal.addEventListener("abort", killer, { once: true }); }
  const timer = setTimeout(killer, o.timeoutMs || 20_000); timer.unref?.();
  await new Promise(res => { child.once("close", res); child.once("exit", res); child.once("error", res); });
  clearTimeout(timer);
  for (const line of text.split("\n")) {
    let m;
    if ((m = /^uid (\d+)$/.exec(line))) results.uid = Number(m[1]);
    else if ((m = /^project (rw|no)$/.exec(line))) results.project = m[1];
    else if ((m = /^reached (\d+)$/.exec(line))) results.reached.push(out[Number(m[1])] ? out[Number(m[1])].name : `path ${m[1]}`);
  }
  if (results.uid === null) failures.push("the confinement check said nothing, so who the session runs as is unknown");
  else if (results.uid === 0) failures.push("the session would run as root");
  else if (results.uid === o.vyreUid) failures.push("the session would run as the same user as Vyre");
  if (results.project !== "rw") failures.push("the session cannot use its own project folder");
  for (const n of results.reached) failures.push(`the session can reach ${n}`);
  const answered = results.reached.length + (text.match(/^denied \d+$/gm) || []).length;
  if (results.uid !== null && answered !== out.length) failures.push("the confinement check did not answer for every protected path");
  return { ok: failures.length === 0, failures, confined_by: "uid", results };
}
