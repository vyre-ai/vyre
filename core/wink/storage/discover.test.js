// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAvahi, parseDnsSd, parseSmbShares, parseExports, mdnsScanner, smbScanner, nfsScanner, localDiskScanner, createDiscovery, candidateId } from "./discover.js";

const AVAHI = [
  "+;eth0;IPv4;Office\\032NAS;_smb._tcp;local",
  "=;eth0;IPv4;Office\\032NAS;_smb._tcp;local;nas.local;192.168.1.20;445;",
  "=;eth0;IPv4;Studio;_smb._tcp;local;studio.local;192.168.1.30;445;",
].join("\n");

test("parsers read avahi, dns-sd, smbclient and showmount output", () => {
  const a = parseAvahi(AVAHI, "smb");
  assert.deepEqual(a.map(x => [x.name, x.host]), [["Office NAS", "nas.local"], ["Studio", "studio.local"]]);
  assert.deepEqual(parseDnsSd("Timestamp A/R Flags if Domain Service Type Instance Name\n12:00:00.1 Add 2 4 local. _smb._tcp. Office NAS\n", "smb").map(x => x.name), ["Office NAS"]);
  assert.deepEqual(parseSmbShares("Disk|Files|\nDisk|IPC$|\nPrinter|lp|\nDisk|Backup|x", "nas.local").map(x => x.share), ["Files", "Backup"]);
  assert.deepEqual(parseExports("Export list for nas:\n/volume1/backup 192.168.1.0/24\n/volume1/media *\n", "nas").map(x => x.path), ["/volume1/backup", "/volume1/media"]);
});

/** A fake shell: answers by program, records calls. */
function shell(table) {
  const calls = [];
  const sh = async (cmd, args) => { calls.push([cmd, ...args]); const r = table[cmd]; return typeof r === "function" ? r(args) : r || { ok: false, missing: true, out: "" }; };
  return { sh, calls };
}

test("mdns uses avahi-browse, falls back to dns-sd, and says plainly when it has neither", async () => {
  const a = shell({ "avahi-browse": args => ({ ok: true, out: args.includes("_smb._tcp") ? AVAHI : "" }) });
  const r = await mdnsScanner({ run: a.sh }).scan();
  assert.equal(r.found.length, 2);
  assert.equal(r.note, undefined);
  const b = shell({ "dns-sd": { ok: true, out: "12:00 Add 2 4 local. _smb._tcp. Office NAS\n" } });
  assert.equal((await mdnsScanner({ run: b.sh }).scan()).found[0].name, "Office NAS");
  const none = await mdnsScanner({ run: shell({}).sh }).scan();
  assert.deepEqual(none.found, []);
  assert.match(/** @type {string} */ (none.note), /neither avahi-browse nor dns-sd/);
});

test("smb and nfs scanners list shares and exports, and name the missing tool", async () => {
  const hosts = () => [{ name: "NAS", kind: "smb", host: "nas.local" }, { name: "N", kind: "nfs", host: "nfs.local" }];
  const s = shell({ smbclient: { ok: true, out: "Disk|Files|\n" }, showmount: { ok: true, out: "/export/b *\n" } });
  assert.deepEqual((await smbScanner({ run: s.sh, hosts }).scan()).found.map(x => x.share), ["Files"]);
  assert.deepEqual((await nfsScanner({ run: s.sh, hosts }).scan()).found.map(x => x.path), ["/export/b"]);
  const m = shell({});
  assert.match(/** @type {string} */ ((await smbScanner({ run: m.sh, hosts }).scan()).note), /smbclient is not installed/);
  assert.match(/** @type {string} */ ((await nfsScanner({ run: m.sh, hosts }).scan()).note), /showmount is not installed/);
  assert.deepEqual((await smbScanner({ run: m.sh }).scan()).found, []);
});

test("local disks: mounted directories with a size, nothing else", async () => {
  const fsFake = {
    readdirSync: root => (root === "/Volumes" ? ["Macintosh HD", "Backup2TB", "file.txt"] : (() => { throw new Error("ENOENT"); })()),
    statSync: p => ({ isDirectory: () => !p.endsWith(".txt") }),
    statfsSync: p => (p.includes("Backup") ? { blocks: 488_000_000, bsize: 4096 } : { blocks: 0, bsize: 4096 }),
  };
  const r = await localDiskScanner({ fs: /** @type {any} */ (fsFake), roots: ["/Volumes", "/mnt"] }).scan();
  assert.deepEqual(r.found.map(x => [x.name, x.kind, x.path]), [["Backup2TB", "usb-disk", "/Volumes/Backup2TB"]]);
  assert.ok(/** @type {number} */ (r.found[0].size) > 1.9e12);
});

test("discovery: scans on demand, caches for a minute at least, dedupes, survives a failing scanner", async () => {
  let t = 1_000_000, scans = 0;
  const scanners = [
    { name: "a", scan: async () => { scans++; return { found: [{ name: "Office drive", kind: "smb", host: "nas.local", share: "Files", size: 2e12 }] }; } },
    { name: "b", scan: async () => ({ found: [{ name: "Office drive", kind: "smb", host: "nas.local", share: "Files" }, { name: "x", kind: "bogus" }] }) },
    { name: "c", scan: async () => { throw new Error("boom"); } },
  ];
  const d = createDiscovery({ scanners: /** @type {any} */ (scanners), from: () => "Alex's Mac mini", now: () => t, gapMs: 1000 });
  const r1 = await d.discover();
  assert.equal(r1.cached, false);
  assert.equal(r1.candidates.length, 1);
  assert.equal(r1.candidates[0].seenFrom, "Alex's Mac mini");
  assert.equal(r1.candidates[0].id, candidateId({ name: "x", kind: "smb", host: "nas.local", share: "Files" }));
  assert.match(r1.notes[0], /c could not look: boom/);
  t += 59_000; // gapMs 1000 is raised to the 60 s floor
  assert.equal((await d.discover()).cached, true);
  assert.equal(scans, 1);
  t += 2_000;
  assert.equal((await d.discover()).cached, false);
  assert.equal(scans, 2);
  assert.ok(d.candidate(r1.candidates[0].id));
  assert.equal(d.candidate("cand_nope"), null);
});

test("discovery: two asks at once share one scan", async () => {
  let scans = 0;
  const d = createDiscovery({ scanners: [{ name: "slow", scan: async () => { scans++; await new Promise(r => setTimeout(r, 30)); return { found: [] }; } }], from: () => "x" });
  await Promise.all([d.discover(), d.discover()]);
  assert.equal(scans, 1);
});
