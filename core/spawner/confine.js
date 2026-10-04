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
 * @typedef {{ name: string, path: string, list?: boolean }} Out a thing the session must not reach (the name is what a refusal says); `list` ones may be entered, only read or listed counts
 * @param {{ account?: number | null, shared?: boolean, cwd?: string, workdirs?: string[], vyreUid: number, out: Out[], allowListen?: number[], refuseListen?: boolean, signal?: AbortSignal, timeoutMs?: number, spawn?: typeof spawnAsAgent, probe?: string, socket?: string }} o
 * @returns {Promise<{ ok: boolean, failures: string[], confined_by: "uid", results: { uid: number | null, project: string[], reached: string[], listening: number[] } }>}
 */
export async function confineSelfTest(o) {
  const spawn = o.spawn || spawnAsAgent;
  const failures = /** @type {string[]} */ ([]);
  const dirs = o.workdirs && o.workdirs.length ? o.workdirs : (o.cwd ? [o.cwd] : []);
  // A thing to keep out of reach that is not there proves nothing, so it is a misconfigured box, not a pass. Deny paths first, then list-only paths: the probe numbers them in that order.
  const exists = (/** @type {Out} */ x) => { if (fs.existsSync(x.path)) return true; failures.push(`${x.name} is not where the box says it is (${x.path}), so it could not be checked`); return false; };
  const out = [...o.out.filter(x => !x.list), ...o.out.filter(x => x.list)].filter(exists);
  const denyPaths = out.filter(x => !x.list).map(x => x.path), listPaths = out.filter(x => x.list).map(x => x.path);
  const results = { uid: /** @type {number | null} */ (null), project: /** @type {string[]} */ ([]), reached: /** @type {string[]} */ ([]), listening: /** @type {number[]} */ ([]) };
  /** @type {any} */ let child = null;
  try {
    child = await spawn([o.probe || PROBE, "allow", ...dirs, "deny", ...denyPaths, "list", ...listPaths], { cwd: dirs[0], env: { PATH: "/usr/bin:/bin" }, ...(o.account != null ? { account: o.account, shared: Boolean(o.shared) } : {}), ...(o.socket ? { socket: o.socket } : {}) });
  } catch (e) { return { ok: false, failures: [...failures, `the confinement check could not start: ${String(/** @type {Error} */ (e).message || e).slice(0, 160)}`], confined_by: "uid", results }; }
  let text = "";
  child.stdout.on("data", (/** @type {any} */ d) => { text += d; });
  child.stderr.on("data", () => {});
  try { child.stdin.end(); } catch { /* the probe reads nothing */ }
  const killer = () => { try { child.kill("SIGKILL"); } catch {} };
  if (o.signal) { if (o.signal.aborted) killer(); else o.signal.addEventListener("abort", killer, { once: true }); }
  const timer = setTimeout(killer, o.timeoutMs || 20_000);   // not unref'd: the check waits on it, and it is cleared the moment the probe ends
  await new Promise(res => { child.once("close", res); child.once("exit", res); child.once("error", res); });
  clearTimeout(timer);
  let denied = 0;
  for (const line of text.split("\n")) {
    let m;
    if ((m = /^uid (\d+)$/.exec(line))) results.uid = Number(m[1]);
    else if ((m = /^project (rw|no)$/.exec(line))) results.project.push(m[1]);
    else if ((m = /^reached (\d+)$/.exec(line))) results.reached.push(out[Number(m[1])] ? out[Number(m[1])].name : `path ${m[1]}`);
    else if (/^denied \d+$/.test(line)) denied++;
    else if ((m = /^listen (\d+)$/.exec(line))) results.listening.push(Number(m[1]));
  }
  if (results.uid === null) failures.push("the confinement check said nothing, so who the session runs as is unknown");
  else if (results.uid === 0) failures.push("the session would run as root");
  else if (results.uid === o.vyreUid) failures.push("the session would run as the same user as Vyre");
  if (dirs.length === 0) failures.push("the session has no project folder to check");
  dirs.forEach((d, i) => { if (results.project[i] !== "rw") failures.push(`the session cannot use its own project folder ${d}`); });
  for (const n of results.reached) failures.push(`the session can reach ${n}`);
  // The session shares the box's network: a port something listens on is a door it can knock on. Reported always (results.listening); a start is refused for it only when the box asks (refuseListen):
  // the packaged box has one loopback listener nobody has named yet (found by the hosted run), so today it is a finding, not a gate.
  if (o.refuseListen) for (const port of [...new Set(results.listening)]) if (!(o.allowListen || []).includes(port)) failures.push(`the session can connect to port ${port}, which something in the box listens on`);
  if (results.uid !== null && results.reached.length + denied !== out.length) failures.push("the confinement check did not answer for every protected path");
  return { ok: failures.length === 0, failures, confined_by: "uid", results };
}
