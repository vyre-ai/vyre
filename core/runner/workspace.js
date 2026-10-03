// @ts-check
// The encrypted workspace, one per space, on this computer (DESIGN-local-runner section 3).
//
// Everything the session reads and writes, its transcript, its home folder and the space's files, lives inside it,
// so nothing of the space is in plain text on this disk. The key arrives from the lease and goes to the encryption
// tool over a pipe, never in an argument, a file or the environment.
//
//   macOS    an encrypted sparse disk image (AES-256), attached with hdiutil at a private mount point
//   Linux    gocryptfs (an encrypted overlay: file contents and names are ciphertext on disk)
//   Windows  chosen by the spike (team/0.3/SPIKE-runner-windows.md)
//
// A driver has the same five calls: exists, create, mount, unmount, destroy, plus isMounted. "dir" is this space's
// folder under the runner's base; the mounted, readable view is dir/mnt, and only while the lease holds.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/** The pass phrase for the tool: the key as hex, in a Buffer the caller zeroes after use. @param {Buffer} key */
const passphrase = key => Buffer.from(key.toString("hex"));

/** Run a tool with the pass phrase on its stdin. @returns {Promise<{ code: number|null, err: string, out: string }>} */
function runWithPass(cmd, args, pass) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let err = "", out = "";
    p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d);
    p.on("error", e => resolve({ code: -1, err: String(e.message), out }));
    p.on("close", code => { pass.fill(0); resolve({ code, err, out }); });
    p.stdin.on("error", () => {});
    p.stdin.end(pass);
  });
}

const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 }); return { code: r.status, err: String(r.stderr || ""), out: String(r.stdout || "") }; };
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

function mountedPaths() {
  if (process.platform === "linux") { try { return fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").map(l => (l.split(" ")[4] || "").replace(/\\040/g, " ")); } catch { return []; } }
  const r = run("/sbin/mount", []);
  return r.out.split("\n").map(l => (/ on (.+?) \(/.exec(l) || [])[1]).filter(Boolean);
}

/** @param {"darwin"|"linux"|"win32"|string} platform @param {{ sizeGb?: number }} [opts] */
export function driverFor(platform, opts = {}) {
  if (platform === "darwin") return macDriver(opts);
  if (platform === "linux") return linuxDriver();
  throw new Error(`no encrypted workspace for ${platform} yet`);
}

/** Why encrypted workspaces cannot run here, or "". */
export function workspaceUnavailable(platform = process.platform) {
  if (platform === "darwin") return fs.existsSync("/usr/bin/hdiutil") ? "" : "hdiutil is missing";
  if (platform === "linux") {
    if (run("gocryptfs", ["-version"]).code !== 0) return "gocryptfs is not installed (apt install gocryptfs)";
    if (!fs.existsSync("/dev/fuse")) return "FUSE is not available (/dev/fuse)";
    if (!["fusermount3", "fusermount"].some(t => run("which", [t]).code === 0)) return "fusermount is not installed (apt install fuse3)";
    return "";
  }
  return "no encrypted workspace for this system yet";
}

function macDriver({ sizeGb = 8 } = {}) {
  const img = dir => path.join(dir, "vol.sparseimage");
  const mnt = dir => path.join(dir, "mnt");
  return {
    name: "hdiutil-aes256",
    exists: dir => fs.existsSync(img(dir)),
    isMounted: dir => mountedPaths().includes(real(mnt(dir))),
    async create(dir, key) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const r = await runWithPass("/usr/bin/hdiutil", ["create", "-size", `${sizeGb}g`, "-type", "SPARSE", "-fs", "APFS", "-encryption", "AES-256", "-stdinpass", "-volname", "vyre-space", "-quiet", path.join(dir, "vol")], passphrase(key));
      if (r.code !== 0) throw new Error("could not create the workspace: " + r.err.trim().slice(0, 200));
    },
    async mount(dir, key) {
      fs.mkdirSync(mnt(dir), { recursive: true, mode: 0o700 });
      const r = await runWithPass("/usr/bin/hdiutil", ["attach", "-stdinpass", "-nobrowse", "-noverify", "-noautoopen", "-owners", "on", "-mountpoint", mnt(dir), "-quiet", img(dir)], passphrase(key));
      if (r.code !== 0) throw new Error("could not open the workspace: " + r.err.trim().slice(0, 200));
      return real(mnt(dir));
    },
    async unmount(dir) {
      if (!fs.existsSync(mnt(dir))) return;
      let r = run("/usr/bin/hdiutil", ["detach", mnt(dir), "-quiet"]);
      if (r.code !== 0) r = run("/usr/bin/hdiutil", ["detach", mnt(dir), "-force", "-quiet"]);
      if (r.code !== 0 && this.isMounted(dir)) throw new Error("could not close the workspace: " + r.err.trim().slice(0, 200));
    },
    async destroy(dir) { await this.unmount(dir); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function linuxDriver() {
  const cipher = dir => path.join(dir, "cipher");
  const mnt = dir => path.join(dir, "mnt");
  /** the gocryptfs process that holds each mount, so unmount reaps it */
  const procs = new Map();
  const fusermount = () => ["fusermount3", "fusermount"].find(t => run("which", [t]).code === 0) || "fusermount3";
  return {
    name: "gocryptfs",
    exists: dir => fs.existsSync(path.join(cipher(dir), "gocryptfs.conf")),
    isMounted: dir => mountedPaths().includes(real(mnt(dir))),
    async create(dir, key) {
      fs.mkdirSync(cipher(dir), { recursive: true, mode: 0o700 });
      // The key is 32 random bytes from the vault, so a light scrypt cost loses nothing and keeps open fast.
      const r = await runWithPass("gocryptfs", ["-init", "-q", "-scryptn", "10", cipher(dir)], passphrase(key));
      if (r.code !== 0) throw new Error("could not create the workspace: " + r.err.trim().slice(0, 200));
    },
    async mount(dir, key) {
      fs.mkdirSync(mnt(dir), { recursive: true, mode: 0o700 });
      const p = spawn("gocryptfs", ["-q", "-fg", "-nosyslog", "-noprealloc", cipher(dir), mnt(dir)], { stdio: ["pipe", "ignore", "pipe"] });
      let err = ""; p.stderr.on("data", d => err += d);
      let exited = false; p.on("close", () => { exited = true; });
      p.stdin.on("error", () => {});
      const pass = passphrase(key); p.stdin.end(pass); pass.fill(0);
      const t0 = Date.now();
      while (Date.now() - t0 < 15_000) {
        if (exited) throw new Error("could not open the workspace: " + err.trim().slice(0, 200));
        if (this.isMounted(dir)) { procs.set(dir, p); return real(mnt(dir)); }
        await new Promise(r => setTimeout(r, 50));
      }
      p.kill(); throw new Error("could not open the workspace: it did not mount in time");
    },
    async unmount(dir) {
      if (this.isMounted(dir)) {
        let r = run(fusermount(), ["-u", mnt(dir)]);
        if (r.code !== 0) r = run(fusermount(), ["-uz", mnt(dir)]);
        if (r.code !== 0 && this.isMounted(dir)) throw new Error("could not close the workspace: " + r.err.trim().slice(0, 200));
      }
      const p = procs.get(dir); procs.delete(dir);
      if (p && p.exitCode === null) await new Promise(res => { const t = setTimeout(() => { p.kill("SIGKILL"); res(undefined); }, 3000); p.once("close", () => { clearTimeout(t); res(undefined); }); });
    },
    async destroy(dir) { await this.unmount(dir); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
