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
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

/** The pass phrase for the tool: the key as hex, in a Buffer the caller zeroes after use. @param {Buffer} key */
const passphrase = key => { const hex = "0123456789abcdef", b = Buffer.alloc(key.length * 2); for (let i = 0; i < key.length; i++) { b[i * 2] = hex.charCodeAt(key[i] >> 4); b[i * 2 + 1] = hex.charCodeAt(key[i] & 15); } return b; };

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

const FSCRYPTCTL = path.join(path.dirname(fileURLToPath(import.meta.url)), "fscryptctl.py");

/** Can this folder's filesystem encrypt a directory with the kernel's own fscrypt (no FUSE, native speed)? Needs python3 and the filesystem's "encrypt" feature (one admin step). @param {string} dir */
export function fscryptSupported(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return false; }
  const r = spawnSync("python3", [FSCRYPTCTL, "probe", dir], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0;
}

/** The line shown when this folder's filesystem cannot encrypt natively and the runner uses gocryptfs instead. */
export const SLOWER_LINE = "Your files for this space are encrypted with a slower method on this computer's disk format (file-heavy work can take several times longer).";

/**
 * What the installer's root helper must do ONCE for the runner's folder (setup, "use this computer for a space"), and what happens
 * without it. Measured on a test box: on ext4, `tune2fs -O encrypt <device>` works on the MOUNTED filesystem, with no remount and no
 * reboot, and the next unprivileged probe succeeds. f2fs can only be changed offline; btrfs, xfs, zfs and network disks cannot, so
 * those use gocryptfs and show SLOWER_LINE (a refusal would leave the member with no lending at all, which is worse than slower).
 * @param {string} base @param {(cmd: string, args: string[]) => { status: number|null, stdout: string }} [runCmd] @param {(dir: string) => boolean} [supported]
 * @returns {{ state: "ready"|"needs-admin"|"unsupported", fstype: string, device: string, command?: string[], fallback?: "gocryptfs", line?: string }}
 */
export function fscryptSetupPlan(base, runCmd = (c, a) => spawnSync(c, a, { encoding: "utf8", timeout: 10_000 }), supported = fscryptSupported) {
  if (supported(base)) return { state: "ready", fstype: "", device: "" };
  const r = runCmd("findmnt", ["-no", "FSTYPE,SOURCE", "--target", base]);
  const [fstype = "", device = ""] = String(r.stdout || "").trim().split(/\s+/);
  if (r.status === 0 && fstype === "ext4" && device.startsWith("/dev/")) return { state: "needs-admin", fstype, device, command: ["tune2fs", "-O", "encrypt", device], fallback: "gocryptfs", line: SLOWER_LINE };
  return { state: "unsupported", fstype, device, fallback: "gocryptfs", line: SLOWER_LINE };
}

/** @param {"darwin"|"linux"|"win32"|string} platform @param {{ sizeGb?: number, base?: string, prefer?: "fscrypt"|"gocryptfs" }} [opts] */
export function driverFor(platform, opts = {}) {
  if (platform === "darwin") return macDriver(opts);
  if (platform === "linux") return opts.prefer === "fscrypt" || (opts.prefer !== "gocryptfs" && opts.base && fscryptSupported(opts.base)) ? fscryptDriver() : linuxDriver();
  if (platform === "win32") { if (process.env.VYRE_WINDOWS_LENDING !== "experimental") throw new Error("Running a space's work on this computer isn't available on Windows yet. Your sessions run on the space's server."); return winDriver(opts); }
  throw new Error(`no encrypted workspace for ${platform} yet`);
}

/** Why encrypted workspaces cannot run here, or "". */
export function workspaceUnavailable(platform = process.platform, opts = undefined) {
  if (platform === "darwin") return fs.existsSync("/usr/bin/hdiutil") ? "" : "hdiutil is missing";
  if (platform === "linux") {
    if (run("python3", ["--version"]).code === 0 && opts && opts.base && fscryptSupported(opts.base)) return "";
    if (run("gocryptfs", ["-version"]).code !== 0) return "gocryptfs is not installed (apt install gocryptfs)";
    if (!fs.existsSync("/dev/fuse")) return "FUSE is not available (/dev/fuse)";
    if (!["fusermount3", "fusermount"].some(t => run("which", [t]).code === 0)) return "fusermount is not installed (apt install fuse3)";
    return "";
  }
  if (platform === "win32") {
    if (process.env.VYRE_WINDOWS_LENDING !== "experimental") return "Running a space's work on this computer isn't available on Windows yet. Your sessions run on the space's server.";
    if (run("net", ["session"]).code !== 0) return "the runner needs administrator rights on Windows to attach the encrypted disk (the Vyre helper has them)";
    const r = run("powershell", ["-NoProfile", "-Command", "if (Get-Command Enable-BitLocker -ErrorAction SilentlyContinue) { 'ok' }"]);
    return /ok/.test(r.out) ? "" : "this edition of Windows has no BitLocker (Windows Home): sessions for this space run on its server";
  }
  return "no encrypted workspace for this system yet";
}

function macDriver({ sizeGb = 8 } = {}) {
  // A sparse BUNDLE (many small band files), not a single sparse image: measured on a hosted Mac, small-file work in the bundle is
  // about 1.0x of a plain folder, against 2.1x to 2.6x for the single-file image.
  const img = dir => path.join(dir, "vol.sparsebundle");
  const mnt = dir => path.join(dir, "mnt");
  return {
    name: "hdiutil-aes256",
    exists: dir => fs.existsSync(img(dir)),
    isMounted: dir => mountedPaths().includes(real(mnt(dir))),
    async create(dir, key) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const r = await runWithPass("/usr/bin/hdiutil", ["create", "-size", `${sizeGb}g`, "-type", "SPARSEBUNDLE", "-fs", "APFS", "-encryption", "AES-256", "-stdinpass", "-volname", "vyre-space", "-quiet", path.join(dir, "vol")], passphrase(key));
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

/**
 * Windows: a BitLocker-protected VHDX (Pro and Enterprise). The disk is made and attached with diskpart (administrator), mounted
 * as a folder, encrypted with the leased key as the BitLocker password (read from stdin into a SecureString, never an argument or
 * a file), and locked and detached on unmount. Measured on the Windows 11 test VM (scripts/runner-win/exp3a-bitlocker.ps1).
 */
function winDriver({ sizeGb = 8 } = {}) {
  const vhd = dir => path.join(dir, "vol.vhdx");
  const mnt = dir => path.join(dir, "mnt");
  const ps = (script, pass) => runWithPass("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], pass || Buffer.alloc(0));
  const dp = async (dir, lines) => {
    const f = path.join(dir, "dp-" + process.pid + ".txt");
    fs.writeFileSync(f, lines.join("\r\n") + "\r\n");
    const r = run("diskpart.exe", ["/s", f]); fs.rmSync(f, { force: true }); return r;
  };
  const unlockScript = m => `$p = [Console]::In.ReadLine(); $s = ConvertTo-SecureString $p -AsPlainText -Force; $p = $null; Unlock-BitLocker -MountPoint '${m}' -Password $s | Out-Null`;
  return {
    name: "bitlocker-vhdx",
    exists: dir => fs.existsSync(vhd(dir)),
    isMounted: dir => { const r = run("powershell.exe", ["-NoProfile", "-Command", `try { (Get-BitLockerVolume -MountPoint '${mnt(dir)}').LockStatus } catch { '' }`]); return /Unlocked/.test(r.out); },
    async create(dir, key) {
      fs.mkdirSync(mnt(dir), { recursive: true });
      const r = await dp(dir, [`create vdisk file="${vhd(dir)}" maximum=${sizeGb * 1024} type=expandable`, `select vdisk file="${vhd(dir)}"`, "attach vdisk", "create partition primary", "format fs=ntfs quick label=vyre", `assign mount="${mnt(dir)}"`]);
      if (r.code !== 0) throw new Error("could not create the workspace: " + r.out.trim().slice(0, 200));
      const e = await ps(`$p = [Console]::In.ReadLine(); $s = ConvertTo-SecureString $p -AsPlainText -Force; $p = $null; Enable-BitLocker -MountPoint '${mnt(dir)}' -EncryptionMethod XtsAes256 -PasswordProtector -Password $s -UsedSpaceOnly -SkipHardwareTest | Out-Null`, passphrase(key));
      if (e.code !== 0) throw new Error("could not encrypt the workspace: " + (e.err || e.out).trim().slice(0, 200));
      await this.unmount(dir);
    },
    async mount(dir, key) {
      // After a detach the mount-point folder is a dangling reparse point: remove it and make a plain one.
      try { fs.rmdirSync(mnt(dir)); } catch {}
      fs.mkdirSync(mnt(dir), { recursive: true });
      // Attach, give the partition the mount folder if it lost it, then unlock with the password.
      await dp(dir, [`select vdisk file="${vhd(dir)}"`, "attach vdisk"]);
      const attach = await ps(`$d = Get-DiskImage -ImagePath '${vhd(dir)}' | Get-Disk; $pt = Get-Partition -DiskNumber $d.Number | Select-Object -First 1; try { Add-PartitionAccessPath -DiskNumber $d.Number -PartitionNumber $pt.PartitionNumber -AccessPath '${mnt(dir)}' -ErrorAction Stop } catch {}`);
      const u = await ps(unlockScript(mnt(dir)), passphrase(key));
      if (u.code !== 0) { await this.unmount(dir).catch(() => {}); throw new Error("could not open the workspace: " + (u.err || u.out || attach.err).trim().slice(0, 200)); }
      return mnt(dir);
    },
    async unmount(dir) {
      await ps(`try { Lock-BitLocker -MountPoint '${mnt(dir)}' -ForceDismount | Out-Null } catch {}`);
      await dp(dir, [`select vdisk file="${vhd(dir)}"`, "detach vdisk"]);
    },
    async destroy(dir) { await this.unmount(dir); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Linux, kernel-native: the workspace is a directory encrypted with fscrypt. Adding the key (unlock) and removing it (lock) are plain
 * ioctls any user may call once the filesystem has the "encrypt" feature, so there is no mount, no FUSE and no root at run time: reads
 * and writes run at the filesystem's own speed (measured: about 1.0x of a plain folder, against 9 to 28x for gocryptfs). The 64-byte
 * fscrypt key is derived from the leased key and goes to the helper over stdin; it is never an argument or a file.
 */
function fscryptDriver() {
  const enc = dir => path.join(dir, "enc");
  const key64 = key => { const k = Buffer.from(crypto.hkdfSync("sha512", key, Buffer.alloc(0), "vyre fscrypt workspace v1", 64)); const hex = Buffer.from(k.toString("hex")); k.fill(0); return hex; };
  const helper = (verb, dir, key) => runWithPass("python3", [FSCRYPTCTL, verb, dir], key ? key64(key) : Buffer.alloc(0));
  const status = dir => { const r = spawnSync("python3", [FSCRYPTCTL, "status", enc(dir)], { encoding: "utf8", timeout: 10_000 }); return r.status === 0 ? r.stdout.trim() : "absent"; };
  return {
    name: "fscrypt",
    exists: dir => fs.existsSync(enc(dir)),
    isMounted: dir => fs.existsSync(enc(dir)) && status(dir) === "present",
    async create(dir, key) {
      fs.mkdirSync(enc(dir), { recursive: true, mode: 0o700 });
      const r = await helper("policy", enc(dir), key);
      if (r.code !== 0) throw new Error("could not create the workspace: " + (r.err || "fscrypt refused").trim().slice(0, 200));
    },
    async mount(dir, key) {
      const r = await helper("add", enc(dir), key);
      if (r.code !== 0) throw new Error("could not open the workspace: " + (r.err || "fscrypt refused").trim().slice(0, 200));
      if (status(dir) !== "present") throw new Error("could not open the workspace: the key did not take");
      return enc(dir);
    },
    async unmount(dir) {
      // The key is removed from the filesystem, so the directory is unreadable at once for anything new. "incomplete" only means a process
      // still holds a file open; the sessions are stopped first, and isMounted reads "present" only while the key is there.
      if (!fs.existsSync(enc(dir))) return;
      await helper("remove", enc(dir));
    },
    async destroy(dir) { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
