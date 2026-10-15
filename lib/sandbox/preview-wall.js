// @ts-check
// preview-wall: the network of a preview's own process. A preview serves a page on one loopback port Vyre leased; it needs no other address, so it gets that one port and nothing else: it cannot reach
// the person's machine services, the tailnet, another preview, the vyred socket or the internet. Only the network is walled (the folder and the tools it runs stay as they were).
//   macOS  sandbox-exec: allow everything but the network, then bind and accept on the port, and connect to itself on it. A request to any other address fails.
//   Linux  no wall yet. bubblewrap can drop the network (lib/sandbox/wall.js) but then the page is not reachable from Vyre either, and it cannot let one port through, so a Linux box runs a preview
//          with the shell limits only; `previewWall` answers null there and the caller says so in the preview's log.
import fs from "node:fs";

const first = (/** @type {string[]} */ paths) => paths.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });

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
 * How to start a preview's shell inside its wall, or null where this machine has none.
 * @param {number} port
 * @param {{ platform?: string, find?: (paths: string[]) => string | undefined }} [o]
 * @returns {((script: string) => { cmd: string, args: string[] }) | null}
 */
export function previewWall(port, { platform = process.platform, find = first } = {}) {
  if (platform !== "darwin") return null;
  const sbx = find(["/usr/bin/sandbox-exec"]);
  if (!sbx) return null;
  const profile = previewProfile(port);
  return script => ({ cmd: sbx, args: ["-p", profile, "/bin/sh", "-c", script] });
}
