// kernel/modules/sandbox.js: the command line that runs a module that is not first party with nothing ambient (K6). Two layers: the operating system
// (a new network namespace and a bare file view on Linux with bubblewrap; a sandbox profile on macOS) and Node's permission model (no child process, no
// worker, no addon, reads only of the module's own folder). Node 22 cannot deny the network by itself, which is why the OS layer is not optional: where
// no OS sandbox exists (Windows today) `mechanism()` is null and the kernel refuses to install such a module. The proof that it holds is the supervisor's
// self-test, which runs a probe under this exact command line and requires every attempt to fail.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const exists = (/** @type {string} */ p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const which = (/** @type {string} */ bin) => (process.env.PATH || "").split(path.delimiter).map(d => path.join(d, bin)).find(exists) || null;

/** @param {NodeJS.Platform} [platform] @returns {"bwrap" | "sandbox-exec" | null} */
export function mechanism(platform = process.platform) {
  if (platform === "linux") return which("bwrap") ? "bwrap" : null;
  if (platform === "darwin") return exists("/usr/bin/sandbox-exec") ? "sandbox-exec" : null;
  return null;
}

const NODE_FLAGS = ["--permission"];

/**
 * @param {{ platform?: NodeJS.Platform, execPath?: string, dir: string, args?: string[], entry: string, script?: string }} o dir: the module's folder (read only); entry: the module file inside it
 * @returns {{ cmd: string, args: string[], mechanism: string } | null} null when this platform has no OS sandbox
 */
export function sandboxCommand(o) {
  const platform = o.platform || process.platform, execPath = o.execPath || process.execPath;
  const mech = mechanism(platform);
  if (!mech) return null;
  const real = fs.realpathSync(execPath), nodePrefix = path.dirname(path.dirname(real));
  const dir = fs.realpathSync(o.dir);
  const child = o.script || path.join(HERE, "child.js");
  if (mech === "bwrap") {
    const bind = (/** @type {string} */ p) => (exists(p) ? ["--ro-bind", p, p] : []);
    return { mechanism: mech, cmd: /** @type {string} */ (which("bwrap")), args: [
      "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--clearenv",
      ...bind("/usr"), ...bind("/lib"), ...bind("/lib64"), ...bind("/bin"), ...bind(nodePrefix),
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--ro-bind", dir, "/module", "--ro-bind", child, "/vyre/main.js", "--chdir", "/module",
      "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "VYRE_MODULE_ENTRY", path.posix.join("/module", o.entry),
      real, ...NODE_FLAGS, "--allow-fs-read=/module", "--allow-fs-read=/vyre", "/vyre/main.js", ...(o.args || []),
    ] };
  }
  // macOS: deny the network and every write outright, deny reads of the user's folders, allow the module's own folder and the system.
  const home = process.env.HOME ? fs.realpathSync(process.env.HOME) : "/Users";
  const profile = [
    "(version 1)", "(allow default)", "(deny network*)", "(deny file-write*)",
    `(deny file-read* (subpath ${JSON.stringify(home)}))`, '(deny file-read* (subpath "/Volumes"))',
    `(allow file-read* (subpath ${JSON.stringify(dir)}) (subpath ${JSON.stringify(nodePrefix)}) (literal ${JSON.stringify(child)}))`,
  ].join("\n");
  return { mechanism: mech, cmd: "/usr/bin/sandbox-exec", args: ["-p", profile, real, ...NODE_FLAGS, `--allow-fs-read=${dir}`, `--allow-fs-read=${path.dirname(child)}`, child, ...(o.args || [])] };
}
