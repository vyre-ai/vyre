// @ts-check
// wall: what stops a sandboxed child from opening a socket of its own. The mediated fetch is only
// a rule the child's code could ignore (it can `import net`); the wall is what makes the rule true.
//
// A wall is a way to start the child with no network. None needs root and none needs an install:
//   netns         `unshare --user --map-root-user --net` (Linux): the child has no interface at all
//                 (as root, plain `unshare --net`)
//   sandbox-exec  `/usr/bin/sandbox-exec` with a profile that denies every network operation (macOS)
//   spawner       the box's root spawner runs the child as a uid its firewall rejects (spawner path,
//                 added by launch's box image; probed the same way)
// Each is probed for real before it is trusted: a child started through it tries to connect to a
// listener this process holds, and the wall is accepted only if that connect fails. If no wall
// passes, there is none, and the caller refuses to run a watcher (fail closed, never unisolated).

import fs from "node:fs";
import net from "node:net";
import { execFile } from "node:child_process";

/** @typedef {{ kind: string, why: string, wrap: (argv: string[]) => { cmd: string, args: string[] } }} Wall */

const SANDBOX_PROFILE = "(version 1)(allow default)(deny network*)";
const first = paths => paths.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });

/** @param {{ platform?: string, getuid?: () => number, find?: (paths: string[]) => string|undefined }} [o] @returns {{ kind: string, wrap: (argv: string[]) => { cmd: string, args: string[] } }[]} */
export function candidates({ platform = process.platform, getuid = () => process.getuid?.() ?? -1, find = first } = {}) {
  /** @type {{ kind: string, wrap: (argv: string[]) => { cmd: string, args: string[] } }[]} */
  const out = [];
  if (platform === "linux") {
    const unshare = find(["/usr/bin/unshare", "/bin/unshare"]);
    if (unshare) out.push({ kind: "netns", wrap: argv => ({ cmd: unshare, args: [...(getuid() === 0 ? [] : ["--user", "--map-root-user"]), "--net", "--", ...argv] }) });
  }
  if (platform === "darwin") {
    const sb = find(["/usr/bin/sandbox-exec"]);
    if (sb) out.push({ kind: "sandbox-exec", wrap: argv => ({ cmd: sb, args: ["-p", SANDBOX_PROFILE, ...argv] }) });
  }
  return out;
}

const PROBE = port => `const s=require("node:net").connect(${port},"127.0.0.1");s.on("connect",()=>{console.log("connected");process.exit(0)});s.on("error",e=>{console.log("blocked:"+e.code);process.exit(0)});setTimeout(()=>{console.log("blocked:TIMEOUT");process.exit(0)},3000)`;

const run = (cmd, args) => new Promise(resolve => {
  execFile(cmd, args, { encoding: "utf8", timeout: 8000, env: {} }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim(), err }));
});

/**
 * Probe one candidate for real. The control (the same child with no wrapper) must connect, so a
 * listener that was never reachable cannot make a useless wall look good.
 * @param {{ kind: string, wrap: (argv: string[]) => { cmd: string, args: string[] } }} c
 * @param {string} [node]
 * @returns {Promise<{ ok: boolean, why: string }>}
 */
export async function probe(c, node = process.execPath) {
  const server = net.createServer(s => s.end());
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (server.address()).port;
  try {
    const code = PROBE(port);
    const control = await run(node, ["-e", code]);
    if (control.stdout !== "connected") return { ok: false, why: "the probe listener was not reachable even without a wall" };
    const { cmd, args } = c.wrap([node, "-e", code]);
    const walled = await run(cmd, args);
    if (!walled.ok) return { ok: false, why: `${c.kind} could not start a child: ${(walled.stderr || String(walled.err && walled.err.message)).split("\n")[0].slice(0, 200)}` };
    if (!walled.stdout.startsWith("blocked")) return { ok: false, why: `${c.kind} started a child that could still open a socket` };
    return { ok: true, why: `${c.kind}: a child cannot open a socket` };
  } finally { server.close(); }
}

/** @type {Promise<{ wall: Wall|null, why: string }>|null} */
let cached = null;

/**
 * The first candidate that passes its probe, or null with why. Probed once per process.
 * @param {{ candidates?: ReturnType<typeof candidates>, node?: string, fresh?: boolean }} [o]
 * @returns {Promise<{ wall: Wall|null, why: string }>}
 */
export function getWall({ candidates: list = candidates(), node = process.execPath, fresh = false } = {}) {
  if (cached && !fresh) return cached;
  const p = (async () => {
    const reasons = [];
    for (const c of list) {
      const r = await probe(c, node);
      if (r.ok) return { wall: { kind: c.kind, why: r.why, wrap: c.wrap }, why: r.why };
      reasons.push(r.why);
    }
    return { wall: null, why: reasons.length ? reasons.join("; ") : `this machine (${process.platform}) has no way to start a child without a network` };
  })();
  if (!fresh) cached = p;
  return p;
}

/** For tests: forget the probed wall. */
export function forgetWall() { cached = null; }
