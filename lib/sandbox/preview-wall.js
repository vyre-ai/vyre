// @ts-check
// preview-wall: the network of a preview's own process. A preview serves a page on one loopback port Vyre leased; it needs no other address, so it gets that one port and nothing else: it cannot reach
// the person's machine services, the tailnet, another preview, the vyred port or the internet. Only the network is walled (the folder and the tools it runs stay as they were).
//   macOS  sandbox-exec: allow everything but the network, then bind and accept on the port, and connect to itself on it. A request to any other address fails.
//   Linux  bubblewrap with a private network (nothing outside, not even the host's loopback). The dev server listens on its own loopback in there; a small forwarder inside (preview-forward.js) offers that
//          port on a unix socket in a folder the sandbox shares, and the caller (core/previews/supervisor.js) relays the leased port on the host to that socket. Nothing else gets out. Unix sockets of the
//          person's own account that live in the filesystem stay reachable, as they were: the wall is the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const first = (/** @type {string[]} */ paths) => paths.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
const FORWARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "preview-forward.js");
const q = (/** @type {string} */ s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** Does bubblewrap start a child with a private network here (it needs unprivileged user namespaces)? Asked once per path. @type {Map<string, boolean>} */
const works = new Map();
function bwrapWorks(/** @type {string} */ bwrap) {
  if (!works.has(bwrap)) {
    let ok = false;
    try { ok = spawnSync(bwrap, ["--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--unshare-net", "--die-with-parent", "--", "/bin/true"], { timeout: 5000, stdio: "ignore" }).status === 0; } catch { ok = false; }
    works.set(bwrap, ok);
  }
  return Boolean(works.get(bwrap));
}

/**
 * The sandbox-exec profile for a preview on `port`: everything allowed except the network, and the network allowed only for that one port on this machine.
 * @param {number} port
 */
export function previewProfile(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("a preview's port is a number from 1 to 65535");
  return ["(version 1)", "(allow default)", "(deny network*)",
    `(allow network-bind (local tcp "*:${port}"))`,
    `(allow network-inbound (local tcp "*:${port}"))`,
    `(allow network-outbound (remote tcp "localhost:${port}"))`].join("\n");
}

/**
 * The bubblewrap argv for a preview: the host's filesystem as it is, no network of any kind inside, its own process space (so the forwarder ends with the preview), and the forwarder started beside the
 * command. @param {string} bwrap @param {number} port @param {string} socket @param {string} script @param {string} [node]
 */
export function bwrapPreviewArgs(bwrap, port, socket, script, node = process.execPath) {
  return [bwrap, ["--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--unshare-net", "--unshare-pid", "--die-with-parent", "--",
    "/bin/sh", "-c", `${q(node)} ${q(FORWARD)} ${q(socket)} ${port} & exec /bin/sh -c ${q(script)}`]];
}

/**
 * How to start a preview's shell inside its wall, or null where this machine has none. On Linux the returned function also carries `socket`: where the forwarder offers the preview's port, for the caller to
 * relay the leased port to (and `dir`, the private folder to remove after).
 * @param {number} port
 * @param {{ platform?: string, find?: (paths: string[]) => string | undefined, probe?: (bwrap: string) => boolean, base?: string }} [o]
 * @returns {(((script: string) => { cmd: string, args: string[] }) & { socket?: string, dir?: string }) | null}
 */
export function previewWall(port, { platform = process.platform, find = first, probe = bwrapWorks, base } = {}) {
  if (platform === "darwin") {
    const sbx = find(["/usr/bin/sandbox-exec"]);
    if (!sbx) return null;
    const profile = previewProfile(port);
    return script => ({ cmd: sbx, args: ["-p", profile, "/bin/sh", "-c", script] });
  }
  if (platform === "linux") {
    const bwrap = find(["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]);
    if (!bwrap || !probe(bwrap)) return null;
    // a private folder (only this account) holds the one socket the sandbox and Vyre share
    const dir = fs.mkdtempSync(path.join(base || os.tmpdir(), "vyre-pv-"));
    fs.chmodSync(dir, 0o700);
    const socket = path.join(dir, "p.sock");
    const wrap = /** @type {any} */ ((/** @type {string} */ script) => { const [cmd, args] = bwrapPreviewArgs(bwrap, port, socket, script); return { cmd, args }; });
    wrap.socket = socket; wrap.dir = dir;
    return wrap;
  }
  return null;
}
