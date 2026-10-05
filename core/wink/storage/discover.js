// @ts-check
// discover: drives a device can see from where it sits. A scanner is a port: scan({ from }) answers { found, note? }, where found is a list of
// candidate drives and note says in plain words why a scanner had nothing to say (a missing tool, a closed port). The real scanners shell out to
// the tools the machine already has (avahi-browse or dns-sd, smbclient, showmount) and say so when one is missing; tests pass fakes.
// Scans run on demand only, never faster than once a minute, and the last answer is kept.

import { execFile } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";

export const MIN_SCAN_GAP_MS = 60_000;
export const SERVICES = [["_smb._tcp", "smb"], ["_nfs._tcp", "nfs"], ["_afpovertcp._tcp", "afp"], ["_adisk._tcp", "adisk"]];
const KINDS = new Set(["smb", "nfs", "usb-disk", "afp", "adisk"]);

/** @typedef {{ name: string, kind: string, host?: string, share?: string, path?: string, size?: number, via?: string }} Found */

/** A stable id for a candidate, so a pick refers to what was shown. @param {Found} f */
export const candidateId = f => "cand_" + crypto.createHash("sha256").update([f.kind, f.host || "", f.share || f.path || ""].join("\n")).digest("hex").slice(0, 16);

/** Run a program with a time limit; resolves { ok, out } and never throws. @param {string} cmd @param {string[]} args @param {number} [ms] */
export function run(cmd, args, ms = 8000) {
  return new Promise(res => {
    try {
      execFile(cmd, args, { timeout: ms, maxBuffer: 2_000_000, encoding: "utf8" }, (err, out) => {
        const e = /** @type {any} */ (err);
        if (e && e.code === "ENOENT") return res({ ok: false, missing: true, out: "" });
        res({ ok: !e || Boolean(out), out: String(out || ""), timedOut: Boolean(e && e.killed) });
      });
    } catch { res({ ok: false, missing: true, out: "" }); }
  });
}

/** Hosts and names from `avahi-browse -rpt <type>` (resolved, parseable, terminate): lines start with "=" and split on ";". @param {string} out @param {string} kind */
export function parseAvahi(out, kind) {
  /** @type {Found[]} */
  const found = [];
  for (const line of out.split("\n")) {
    const p = line.split(";");
    if (p[0] !== "=" || p.length < 9) continue;
    const host = p[6] || p[7];
    const name = p[3] || host;
    if (name) found.push({ name: name.replace(/\\(\d{3})/g, (_, n) => String.fromCharCode(Number(n))), kind, host, via: "mdns" });
  }
  return found;
}

/** Instances from `dns-sd -B <type> local` run for a short time: the name is in the last columns. @param {string} out @param {string} kind */
export function parseDnsSd(out, kind) {
  /** @type {Found[]} */
  const found = [];
  for (const line of out.split("\n")) {
    const m = /\bAdd\s+\d+\s+\d+\s+local\.\s+_[a-z]+\._tcp\.\s+(.+?)\s*$/.exec(line);
    if (m) found.push({ name: m[1], kind, host: `${m[1].replace(/\s+/g, "-")}.local`, via: "mdns" });
  }
  return found;
}

/** Shares from `smbclient -L host -N -g`: lines like `Disk|name|comment`. @param {string} out @param {string} host */
export function parseSmbShares(out, host) {
  /** @type {Found[]} */
  const found = [];
  for (const line of out.split("\n")) {
    const p = line.split("|");
    if (p[0] === "Disk" && p[1] && !/\$$/.test(p[1])) found.push({ name: `${p[1]} on ${host}`, kind: "smb", host, share: p[1], via: "smb" });
  }
  return found;
}

/** Exports from `showmount -e host --no-headers`, or the older form with a header line. @param {string} out @param {string} host */
export function parseExports(out, host) {
  /** @type {Found[]} */
  const found = [];
  for (const line of out.split("\n")) {
    const m = /^(\/\S*)\s+(.*)$/.exec(line.trim());
    if (m) found.push({ name: `${m[1]} on ${host}`, kind: "nfs", host, path: m[1], via: "nfs" });
  }
  return found;
}

/**
 * mDNS and DNS-SD: what announces itself as a file server. avahi-browse on Linux, dns-sd on macOS.
 * @param {{ run?: typeof run }} [o]
 */
export function mdnsScanner({ run: sh = run } = {}) {
  return {
    name: "mdns",
    /** @returns {Promise<{ found: Found[], note?: string }>} */
    async scan() {
      /** @type {Found[]} */ const found = [];
      let missing = 0, asked = 0;
      for (const [type, kind] of SERVICES) {
        asked++;
        const a = /** @type {any} */ (await sh("avahi-browse", ["-rpt", type], 8000));
        if (!a.missing) { found.push(...parseAvahi(a.out, kind)); continue; }
        // dns-sd never ends on its own: it is stopped by the time limit, and what it printed is read.
        const d = /** @type {any} */ (await sh("dns-sd", ["-B", type, "local"], 3000));
        if (d.missing) { missing++; continue; }
        found.push(...parseDnsSd(d.out, kind));
      }
      return { found, ...(missing === asked ? { note: "This device has neither avahi-browse nor dns-sd, so announced drives could not be looked for." } : {}) };
    },
  };
}

/**
 * SMB: for each file server found by name, list its shares with smbclient (anonymous). A host that asks for a login still counts, with no shares listed.
 * @param {{ run?: typeof run, hosts?: () => Found[] }} [o]
 */
export function smbScanner({ run: sh = run, hosts = () => [] } = {}) {
  return {
    name: "smb",
    /** @returns {Promise<{ found: Found[], note?: string }>} */
    async scan() {
      const hs = [...new Set(hosts().filter(h => h.kind === "smb" && h.host).map(h => /** @type {string} */ (h.host)))].slice(0, 12);
      if (!hs.length) return { found: [] };
      /** @type {Found[]} */ const found = [];
      for (const h of hs) {
        const r = /** @type {any} */ (await sh("smbclient", ["-L", h, "-N", "-g"], 8000));
        if (r.missing) return { found, note: "smbclient is not installed on this device, so shared folders could not be listed. The servers were found but not their folders." };
        const shares = parseSmbShares(r.out, h);
        if (shares.length) found.push(...shares);
        else found.push({ name: h, kind: "smb", host: h, via: "smb" });
      }
      return { found };
    },
  };
}

/**
 * NFS: exports for each host announced for NFS, through showmount. Hosts the caller names are tried too.
 * @param {{ run?: typeof run, hosts?: () => Found[], extra?: () => string[] }} [o]
 */
export function nfsScanner({ run: sh = run, hosts = () => [], extra = () => [] } = {}) {
  return {
    name: "nfs",
    /** @returns {Promise<{ found: Found[], note?: string }>} */
    async scan() {
      const hs = [...new Set([...hosts().filter(h => h.kind === "nfs" && h.host).map(h => /** @type {string} */ (h.host)), ...extra()])].slice(0, 12);
      if (!hs.length) return { found: [] };
      /** @type {Found[]} */ const found = [];
      for (const h of hs) {
        const r = /** @type {any} */ (await sh("showmount", ["-e", h], 8000));
        if (r.missing) return { found, note: "showmount is not installed on this device, so network folders could not be listed." };
        found.push(...parseExports(r.out, h));
      }
      return { found };
    },
  };
}

/** Real block-device mounts from /proc/self/mountinfo text: an attached cloud volume (/mnt/volume_nyc1_01) or a disk mounted anywhere, never the system's own partitions. @param {string} text @returns {{ path: string, source: string, fstype: string }[]} */
export function parseMountinfo(text) {
  const SYSTEM = /^\/(boot(\/.*)?|efi|usr|etc|var\/lib\/(docker|containerd|kubelet|snapd)(\/.*)?|snap(\/.*)?|run(\/.*)?|proc|sys|dev)$/;
  const out = [];
  let rootSource = "";
  for (const line of String(text).split("\n")) {
    const dash = line.indexOf(" - ");
    if (dash < 0) continue;
    const a = line.slice(0, dash).split(" "), b = line.slice(dash + 3).split(" ");
    const mount = (a[4] || "").replace(/\\040/g, " "), fstype = b[0] || "", source = b[1] || "";
    if (mount === "/") rootSource = source;
    if (!source.startsWith("/dev/") || /^(squashfs|iso9660|overlay|tmpfs)$/.test(fstype)) continue;
    if (SYSTEM.test(mount) || mount === "/") continue;
    out.push({ path: mount, source, fstype });
  }
  return out.filter(m => m.source !== rootSource && !/^\/dev\/loop/.test(m.source));
}

/**
 * Disks attached to this device: real block-device mounts (a cloud volume on a server, a USB disk on a computer) and the mount points under the usual places, with their size when the system says it.
 * @param {{ roots?: string[], fs?: Pick<typeof fs, "readdirSync" | "statfsSync" | "statSync" | "readFileSync"> }} [o]
 */
export function localDiskScanner({ roots = ["/Volumes", "/media", "/mnt"], fs: f = fs } = {}) {
  return {
    name: "local",
    /** @returns {Promise<{ found: Found[], note?: string }>} */
    async scan() {
      /** @type {Found[]} */ const found = [];
      const seenPath = new Set();
      const add = (/** @type {string} */ name, /** @type {string} */ p) => {
        if (seenPath.has(p)) return;
        try {
          if (!f.statSync(p).isDirectory()) return;
          const s = f.statfsSync(p);
          // A mount point of the system's own drive is not a drive someone plugged in.
          if (!s.blocks) return;
          seenPath.add(p);
          found.push({ name, kind: "usb-disk", path: p, size: Number(s.blocks) * Number(s.bsize), via: "local" });
        } catch { /* not a mount */ }
      };
      try { for (const m of parseMountinfo(String(f.readFileSync("/proc/self/mountinfo", "utf8")))) add(m.path.split("/").filter(Boolean).pop() || m.path, m.path); } catch { /* no mountinfo here (macOS, Windows) */ }
      for (const root of roots) {
        let names = [];
        try { names = /** @type {string[]} */ (/** @type {any} */ (f.readdirSync(root))); } catch { continue; }
        for (const n of names.slice(0, 64)) add(n, `${root}/${n}`);
      }
      return { found };
    },
  };
}

/**
 * The scanners a device uses by default, in the order that lets the folder scanners reuse what mDNS found.
 * @param {{ run?: typeof run, fs?: any, extraNfsHosts?: () => string[] }} [o]
 */
export function realScanners(o = {}) {
  /** @type {Found[]} */ let seen = [];
  const mdns = mdnsScanner(o);
  return [
    { name: "mdns", async scan(/** @type {any} */ a) { const r = await mdns.scan(); seen = r.found; return r; } },
    smbScanner({ ...o, hosts: () => seen }),
    nfsScanner({ ...o, hosts: () => seen, extra: o.extraNfsHosts }),
    localDiskScanner(o),
  ];
}

/**
 * The cached, rate-limited discovery used by wink.storage.discover.
 * @param {{ scanners: { name: string, scan(a: { from: string }): Promise<{ found: Found[], note?: string }> }[], from: () => string, fromDevice?: () => string | undefined, now?: () => number, gapMs?: number }} o
 * `fromDevice` is the id of the device the scan runs on, kept beside the label `from` (the home needs the id to call that device).
 */
export function createDiscovery({ scanners, from, fromDevice = () => undefined, now = Date.now, gapMs = MIN_SCAN_GAP_MS }) {
  /** @type {{ at: number, candidates: any[], notes: string[], from: string } | null} */
  let last = null;
  let running = /** @type {Promise<any> | null} */ (null);
  const gap = Math.max(gapMs, MIN_SCAN_GAP_MS);
  const shape = (/** @type {any} */ r, /** @type {boolean} */ cached) => ({ candidates: r.candidates, notes: r.notes, seenFrom: r.from, at: r.at, cached, nextScanAfter: r.at + gap });
  return {
    async discover() {
      if (running) return running;
      if (last && now() - last.at < gap) return shape(last, true);
      running = (async () => {
        const where = from(), whereId = fromDevice();
        /** @type {any[]} */ const candidates = [];
        /** @type {string[]} */ const notes = [];
        const seen = new Set();
        for (const s of scanners) {
          try {
            const r = await s.scan({ from: where });
            for (const f of r.found || []) {
              if (!f || !KINDS.has(f.kind)) continue;
              const id = candidateId(f);
              if (seen.has(id)) continue;
              seen.add(id);
              candidates.push({ id, name: String(f.name).slice(0, 80), kind: f.kind, ...(f.host ? { host: f.host } : {}), ...(f.share ? { share: f.share } : {}), ...(f.path ? { path: f.path } : {}), ...(Number.isFinite(f.size) ? { size: f.size } : {}), seenFrom: where, ...(whereId ? { seenFromDevice: whereId } : {}) });
            }
            if (r.note) notes.push(r.note);
          } catch (err) { notes.push(`${s.name} could not look: ${String(/** @type {Error} */ (err).message).slice(0, 120)}`); }
        }
        last = { at: now(), candidates, notes, from: where };
        return shape(last, false);
      })();
      try { return await running; } finally { running = null; }
    },
    /** A candidate from the last scan, by id. @param {string} id */
    candidate(id) { return (last && last.candidates.find(c => c.id === id)) || null; },
    last: () => (last ? shape(last, true) : null),
  };
}
