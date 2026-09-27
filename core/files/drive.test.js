// @ts-check
// VyreDrive (Taildrive underneath) inside a real Registry, against a fake tailscale: the box's
// status with and without the drive:share attribute, share and unshare and who may do them, the
// files guard on a share's folder, the audit of who else the policy lets in, and the Mac's URL,
// mount, open and path mapping through seams, so nothing is ever mounted or opened.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { HUMAN_ONLY, PERSON_ONLY } from "../presence/index.js";
import { seams, parseDriveList, driveCap, driveUrl, shareMap, shareSpecs, mountStep, gitConfigCredential } from "./drive.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAC_ID = "nMAC1CNTRL", PHONE_ID = "nPHONE1CNTRL", BOX_ID = "nBOX1CNTRL";

function tmp(t, prefix = "vyre-drive-") {
  const dir = fs.mkdtempSync(path.join(SCRATCH, prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Status JSON in the shape tailscale 1.102 prints, for the box or the Mac. */
function statusJson({ selfCaps = {}, self = "vyre" } = {}) {
  const peer = (id, name, ip, user, online = true) => ({ ID: id, HostName: name + "-os", DNSName: `${name}.tail0000.ts.net.`, TailscaleIPs: [ip], Online: online, UserID: user });
  return {
    BackendState: "Running", MagicDNSSuffix: "tail0000.ts.net", CurrentTailnet: { Name: "example.com", MagicDNSSuffix: "tail0000.ts.net" },
    Self: { ID: self === "vyre" ? BOX_ID : MAC_ID, HostName: self, DNSName: `${self}.tail0000.ts.net.`, TailscaleIPs: ["100.64.0.5"], CapMap: selfCaps, UserID: 1 },
    User: { 1: { LoginName: "alex@example.com" } },
    Peer: {
      a: peer(self === "vyre" ? MAC_ID : BOX_ID, self === "vyre" ? "alex-mac" : "vyre", "100.64.0.7", 1),
      b: peer(PHONE_ID, "alex-phone", "100.64.0.8", 1),
      c: peer("nOFF1CNTRL", "old-laptop", "100.64.0.9", 1, false),
    },
  };
}

const whoisJson = (id, name, caps) => ({ Node: { StableID: id, Name: `${name}.tail0000.ts.net.` }, UserProfile: { LoginName: "alex@example.com" }, CapMap: caps });
const DRIVE_RW = { "tailscale.com/cap/drive": [{ shares: ["*"], access: "rw" }] };

const LIST = "name        path     as\n--------    -----    ----\nprojects    /work    vyre\n";

/**
 * A fake tailscale in a temp home: answers from state.json beside it and logs every call to
 * calls.log. It never runs the real binary.
 */
function fakeTailscale(t, state) {
  const dir = tempHome(t);
  const bin = path.join(dir, "tailscale");
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = __dirname, args = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(args) + "\\n");
if (args[0] === "status") { process.stdout.write(JSON.stringify(st.status)); process.exit(0); }
if (args[0] === "whois") { const w = (st.whois || {})[args[2]]; if (!w) { process.stderr.write("no such peer"); process.exit(1); } process.stdout.write(JSON.stringify(w)); process.exit(0); }
if (args[0] === "drive" && args[1] === "list") { process.stdout.write(st.list || ""); process.exit(0); }
if (args[0] === "drive") { if (st.driveFail) { process.stderr.write(st.driveFail); process.exit(1); } process.exit(0); }
process.stderr.write("unexpected"); process.exit(2);
`, { mode: 0o755 });
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = bin;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });
  const calls = () => { try { return fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const set = patch => fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ ...state, ...patch }));
  return { calls, set };
}

/** A registry with the files module, and on the Mac a fake link module (status and remote). */
async function registry(t, { role, cfg = {}, link = undefined, seam = undefined, peers = [], presence = undefined }) {
  const root = tmp(t, "vyre-home-");
  const p = config.ensure(root);
  if (seam) { seams.set(root, seam); t.after(() => seams.delete(root)); }
  const found = discover([CORE]).filter(f => f.manifest && f.manifest.name === "files");
  if (link) {
    const mods = tmp(t, "vyre-mods-");
    globalThis.__driveLinks = globalThis.__driveLinks || new Map();
    globalThis.__driveLinks.set(root, link);
    t.after(() => globalThis.__driveLinks.delete(root));
    writeModule(mods, "link", { roles: ["local"], does: { tools: ["link.remote", "link.status"] } },
      `export default { async start(ctx) {
        const l = () => globalThis.__driveLinks.get(ctx.paths.root);
        ctx.tool("link.remote", { run: async ({ tool, input }) => ({ result: await l().remote(tool, input) }) });
        ctx.tool("link.status", { run: async () => l().status });
        return { async stop() {} };
      } };`);
    found.push(...discover([mods]));
  }
  const db = open(p.db);
  // The link module's table on the box, with the paired Macs; files reads it, never writes it.
  if (role === "box") {
    db.exec("CREATE TABLE IF NOT EXISTS link_peers (id TEXT PRIMARY KEY, name TEXT NOT NULL, login TEXT, node TEXT, stable_id TEXT, key_hash TEXT NOT NULL UNIQUE, paired_at INTEGER NOT NULL, last_seen INTEGER)");
    for (const [i, id] of peers.entries()) db.prepare("INSERT INTO link_peers VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(`p${i}`, "alex-mac", "alex@example.com", "alex-mac.tail0000.ts.net", id, `k${i}`, 1);
  }
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role, ...cfg }, paths: p, log: () => {}, ...(presence ? { presence } : {}) });
  await reg.start(found, { role });
  t.after(async () => { await reg.stop(); db.close(); });
  assert.equal(reg.modules.get("files").state, "running", reg.modules.get("files").error);
  return { reg, events, root };
}

const ok = async (reg, tool, input = {}, caller = "cli", meta = {}) => {
  const r = await reg.call(tool, input, caller, meta);
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return r.data;
};
const no = async (reg, tool, input, caller, code, meta = {}) => {
  const r = await reg.call(tool, input, caller, meta);
  assert.ok(r.error, `${tool} by ${caller} should have been refused`);
  assert.equal(r.error.code, code, r.error.message);
  return r.error;
};

/** A box with a files root, the folders a share may and may not name, and Vyre's home outside it. */
function boxWorld(t) {
  const base = tmp(t);
  const work = path.join(base, "work");
  for (const d of ["projects", "glass", ".private", "holder/vh"]) fs.mkdirSync(path.join(work, d), { recursive: true });
  fs.writeFileSync(path.join(work, "notes.md"), "hi\n");
  return { work, real: fs.realpathSync(work) };
}

// ---- pure --------------------------------------------------------------------------------

test("drive: drive list parses by the dash row's columns, paths with spaces included", () => {
  assert.deepEqual(parseDriveList(LIST), [{ name: "projects", path: "/work", as: "vyre" }]);
  const wide = "name           path                    as\n-----------    --------------------    ----\nglass-files    /work/Harlow Legal      vyre\n";
  assert.deepEqual(parseDriveList(wide), [{ name: "glass-files", path: "/work/Harlow Legal", as: "vyre" }]);
  assert.deepEqual(parseDriveList(""), []);
  assert.deepEqual(parseDriveList("no shares"), []);
});

test("drive: whois drive capability, strongest access wins", () => {
  assert.equal(driveCap({ CapMap: {} }), null);
  assert.equal(driveCap({}), null);
  assert.deepEqual(driveCap(whoisJson("x", "x", DRIVE_RW)), { shares: ["*"], access: "rw" });
  assert.deepEqual(driveCap({ CapMap: { "tailscale.com/cap/drive": [{ shares: ["projects"], access: "ro" }, { shares: ["glass-files"] }] } }),
    { shares: ["projects", "glass-files"], access: "ro" });
});

test("drive: the WebDAV URL uses the tailnet name, then the box's MagicDNS label", () => {
  const st = statusJson({ self: "alex-mac" });
  assert.deepEqual(driveUrl(st, "vyre.tail0000.ts.net", "projects"),
    { url: "http://100.100.100.100:8080/example.com/vyre/projects", tailnet: "example.com", machine: "vyre", share: "projects" });
  // No CurrentTailnet: MagicDNSSuffix. The DNS label, not HostName ("vyre-os"), names the machine.
  const bare = { ...st, CurrentTailnet: undefined };
  assert.equal(driveUrl(bare, "vyre.tail0000.ts.net.", "glass-files").url, "http://100.100.100.100:8080/tail0000.ts.net/vyre/glass-files");
  // A peer this status does not list: the node's own first label.
  assert.equal(driveUrl(st, "studio.tail0000.ts.net", "projects").machine, "studio");
  assert.throws(() => driveUrl({}, "vyre.tail0000.ts.net", "projects"), /which tailnet/);
});

test("drive: default shares come from projectsDir, the files roots and glass.roots", () => {
  assert.deepEqual(shareMap({ projectsDir: "/work/projects", glass: { roots: ["/work/glass"] } }, ["/work"]),
    { projects: "/work/projects", "glass-files": "/work/glass" });
  // projectsDir outside every files root (the box's default, under the home volume): the first root.
  assert.deepEqual(shareMap({ projectsDir: "/home/vyre/Vyre/projects" }, ["/work"]), { projects: "/work" });
  // Config adds, overrides and removes; a name Tailscale would change is dropped.
  assert.deepEqual(shareMap({ projectsDir: "/work", glass: { roots: ["/work/glass"] },
    files: { drive: { shares: { "glass-files": null, notes: "/work/notes", "Bad Name": "/x" } } } }, ["/work"]),
  { projects: "/work", notes: "/work/notes" });
});

test("drive: a share is a path or { path, access }; a path alone is read-only, as configs before per-share access say", () => {
  const cfg = { projectsDir: "/work/projects", glass: { roots: ["/work/glass"] },
    files: { drive: { shares: { notes: "/work/notes", site: { path: "/work/site", access: "rw" }, "glass-files": { access: "rw" }, odd: { path: "/work/odd", access: "yes" }, empty: {} } } } };
  assert.deepEqual(shareSpecs(cfg, ["/work"]), {
    projects: { path: "/work/projects", access: "ro" },
    "glass-files": { path: "/work/glass", access: "rw" },
    notes: { path: "/work/notes", access: "ro" },
    site: { path: "/work/site", access: "rw" },
    odd: { path: "/work/odd", access: "ro" },
  });
  assert.deepEqual(shareMap(cfg, ["/work"]), { projects: "/work/projects", "glass-files": "/work/glass", notes: "/work/notes", site: "/work/site", odd: "/work/odd" });
  // The old global files.drive.access is the default for a share that does not say.
  assert.deepEqual(shareSpecs({ files: { drive: { access: "rw", shares: { notes: "/work/notes", site: { path: "/work/site", access: "ro" } } } } }, ["/work"]),
    { projects: { path: "/work", access: "rw" }, notes: { path: "/work/notes", access: "rw" }, site: { path: "/work/site", access: "ro" } });
});

// ---- the box -----------------------------------------------------------------------------

test("drive: without drive:share the box says why and how to fix it, and never runs drive list", async t => {
  const ts = fakeTailscale(t, { status: statusJson(), list: LIST });
  const { work } = boxWorld(t);
  const { reg } = await registry(t, { role: "box", cfg: { projectsDir: path.join(work, "projects"), files: { roots: [work] } } });
  const s = await ok(reg, "files.drive.status");
  assert.equal(s.enabled, false);
  assert.match(s.why, /drive:share/);
  assert.match(s.fix, /drive:share.*drive:access.*tailscale\.com\/cap\/drive/);
  assert.equal(s.access, "ro");
  assert.deepEqual(s.shares, [{ name: "projects", path: path.join(work, "projects"), access: "ro", shared: false }]);
  assert.ok(!ts.calls().some(c => c[0] === "drive"));
  const e = await no(reg, "files.drive.share", { name: "projects" }, "cli", "drive_off");
  assert.match(e.detail.fix, /drive:share/);
});

test("drive: with drive:share, status lists what is shared; share runs drive share on the real folder and audits", async t => {
  const ts = fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: LIST,
    whois: { "100.64.0.7": whoisJson(MAC_ID, "alex-mac", DRIVE_RW), "100.64.0.8": whoisJson(PHONE_ID, "alex-phone", {}) } });
  const { work, real } = boxWorld(t);
  const { reg, events } = await registry(t, { role: "box", peers: [MAC_ID],
    cfg: { projectsDir: path.join(work, "projects"), glass: { roots: [path.join(work, "glass")] }, files: { roots: [work], drive: { shares: { all: "/work" } } } } });
  const s = await ok(reg, "files.drive.status");
  assert.equal(s.enabled, true);
  assert.deepEqual(s.list, [{ name: "projects", path: "/work", as: "vyre" }]);
  assert.deepEqual(s.shares.map(x => [x.name, x.shared]), [["projects", true], ["glass-files", false], ["all", false]]);

  const r = await ok(reg, "files.drive.share", { name: "glass-files" });
  assert.equal(r.path, path.join(real, "glass"));
  assert.deepEqual(ts.calls().find(c => c[0] === "drive" && c[1] === "share"), ["drive", "share", "glass-files", path.join(real, "glass")]);
  // The paired Mac holds the capability and is not a finding; the phone holds none; the offline laptop is not asked.
  assert.deepEqual(r.audit, { ok: true, findings: [], unsafe: [], checked: 2 });
  assert.ok(!ts.calls().some(c => c[0] === "whois" && c[2] === "100.64.0.9"));
  assert.equal(events.since(0, { type: "drive.exposed" }).length, 0);

  assert.deepEqual(await ok(reg, "files.drive.unshare", { name: "glass-files" }), { unshared: "glass-files" });
  assert.deepEqual(ts.calls().at(-1), ["drive", "unshare", "glass-files"]);
});

test("drive: the audit reports every node with the drive capability that is not a paired Mac, and emits drive.exposed", async t => {
  fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: "",
    whois: { "100.64.0.7": whoisJson(MAC_ID, "alex-mac", DRIVE_RW), "100.64.0.8": whoisJson(PHONE_ID, "alex-phone", { "tailscale.com/cap/drive": [{ shares: ["projects"], access: "ro" }] }) } });
  const { work } = boxWorld(t);
  // No paired Mac at all: both holders are findings.
  const { reg, events } = await registry(t, { role: "box", cfg: { files: { roots: [work] } } });
  const a = await ok(reg, "files.drive.audit", {}, "mcp");
  assert.equal(a.ok, false);
  assert.deepEqual(a.findings, [
    { node: "alex-mac.tail0000.ts.net", login: "alex@example.com", access: { shares: ["*"], access: "rw" } },
    { node: "alex-phone.tail0000.ts.net", login: "alex@example.com", access: { shares: ["projects"], access: "ro" } },
  ]);
  const ev = events.since(0, { type: "drive.exposed" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.findings.length, 2);
});

test("drive: only the owner shares; agents, Claude and unpaired tailnet nodes are refused", async t => {
  const ts = fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: "", whois: {} });
  const { work } = boxWorld(t);
  const { reg } = await registry(t, { role: "box", peers: [MAC_ID], cfg: { projectsDir: path.join(work, "projects"), files: { roots: [work] } } });
  const before = ts.calls().length;
  for (const caller of ["mcp:agent:kit", "harness:agent:kit", "mcp", "module:watchers"]) await no(reg, "files.drive.share", { name: "projects" }, caller, "denied");
  await no(reg, "files.drive.share", { name: "projects" }, "local", "denied", { agent: "kit" });
  await no(reg, "files.drive.unshare", { name: "projects" }, "mcp:agent:kit", "denied");
  await no(reg, "files.drive.share", { name: "projects" }, "tailnet:alex@example.com", "denied", { person: PERSON, peer: { stableId: PHONE_ID } });
  await no(reg, "files.drive.share", { name: "projects" }, "tailnet:alex@example.com", "denied");
  assert.equal(ts.calls().length, before, "a refused caller never reaches tailscale");
  // The paired Mac, by the node the listener established, and the Capsule on the box.
  assert.equal((await ok(reg, "files.drive.share", { name: "projects" }, "tailnet:alex@example.com", { person: PERSON, peer: { stableId: MAC_ID } })).shared, "projects");
  assert.equal((await ok(reg, "files.drive.unshare", { name: "projects" }, "capsule")).unshared, "projects");
});

test("drive: unknown share names and folders the guard refuses are never shared", async t => {
  const ts = fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: "", whois: {} });
  const { work } = boxWorld(t);
  const cfg = { files: { roots: [work], drive: { shares: {
    dot: path.join(work, ".private"), outside: path.dirname(work), file: path.join(work, "notes.md"),
    holder: path.join(work, "holder"), missing: path.join(work, "nope"), secret: path.join(work, "secrets") } } } };
  const { reg } = await registry(t, { role: "box", cfg });
  await no(reg, "files.drive.share", { name: "nothing" }, "cli", "unknown_share");
  await no(reg, "files.drive.share", { name: "../etc" }, "cli", "unknown_share");
  await no(reg, "files.drive.unshare", { name: "nothing" }, "cli", "unknown_share");
  for (const name of ["dot", "outside", "missing", "secret"]) await no(reg, "files.drive.share", { name }, "cli", "not_available");
  await no(reg, "files.drive.share", { name: "file" }, "cli", "bad_input");
  assert.ok(!ts.calls().some(c => c[0] === "drive" && c[1] === "share"));
});

test("drive: a folder holding Vyre's own home is never shared", async t => {
  fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: "", whois: {} });
  const { work } = boxWorld(t);
  const cfg = { files: { roots: [work] } };
  // VYRE_HOME inside the files root, under a plain name: sharing its parent would serve the vault.
  const home = path.join(work, "holder", "vh");
  const p = config.ensure(home);
  const found = discover([CORE]).filter(f => f.manifest && f.manifest.name === "files");
  const db = open(p.db);
  const reg = new Registry({ db, events: new Events(db), config: { role: "box", ...cfg, files: { roots: [work], drive: { shares: { holder: path.join(work, "holder"), top: work } } } }, paths: p, log: () => {} });
  await reg.start(found, { role: "box" });
  t.after(async () => { await reg.stop(); db.close(); });
  await no(reg, "files.drive.share", { name: "holder" }, "cli", "not_available");
  await no(reg, "files.drive.share", { name: "top" }, "cli", "not_available");
});

test("drive: status gives each share its access, and the top-level access is rw when any share is", async t => {
  fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: LIST, whois: {} });
  const { work, real } = boxWorld(t);
  const { reg } = await registry(t, { role: "box",
    cfg: { projectsDir: path.join(work, "projects"), files: { roots: [work], drive: { shares: { site: { path: path.join(work, "glass"), access: "rw" } } } } } });
  const s = await ok(reg, "files.drive.status");
  assert.equal(s.access, "rw");
  assert.deepEqual(s.shares.map(x => [x.name, x.access]), [["projects", "ro"], ["site", "rw"]]);
  assert.equal((await ok(reg, "files.drive.share", { name: "site" })).access, "rw");
  const p = await ok(reg, "files.drive.share", { name: "projects" });
  assert.equal(p.access, "ro");
  assert.equal(p.path, path.join(real, "projects"));
});

// The owner signed in on that device (ADR 0032): the person gate passes, and drive decides.
const PERSON = { id: "s1", kind: "cookie" };

test("drive: files.drive.access is the owner's, saves the share's access, and says when the mount must change", async t => {
  fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: "", whois: {} });
  const { work } = boxWorld(t);
  const prev = process.env.VYRE_DRIVE_ACCESS;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_DRIVE_ACCESS; else process.env.VYRE_DRIVE_ACCESS = prev; });
  const { reg, root } = await registry(t, { role: "box", peers: [MAC_ID],
    cfg: { projectsDir: path.join(work, "projects"), files: { roots: [work], drive: { shares: { notes: path.join(work, "glass") } } } } });
  for (const caller of ["mcp:agent:kit", "harness:agent:kit", "mcp"]) await no(reg, "files.drive.access", { name: "projects", mode: "rw" }, caller, "denied");
  await no(reg, "files.drive.access", { name: "projects", mode: "rw" }, "local", "denied", { agent: "kit" });
  await no(reg, "files.drive.access", { name: "projects", mode: "rw" }, "tailnet:alex@example.com", "denied", { person: PERSON, peer: { stableId: PHONE_ID } });
  await no(reg, "files.drive.access", { name: "nothing", mode: "rw" }, "cli", "unknown_share");
  assert.equal((await ok(reg, "files.drive.status")).access, "ro");

  // The mount is read-only and a share turns rw: the step to rw.
  process.env.VYRE_DRIVE_ACCESS = "ro";
  const a = await ok(reg, "files.drive.access", { name: "projects", mode: "rw" });
  assert.deepEqual(a, { name: "projects", access: "rw", mount: { want: "rw", now: "ro", change: true, step: mountStep("rw") } });
  assert.equal(a.mount.step, "Set VYRE_DRIVE_ACCESS=rw in /srv/vyre/.env, then run docker compose up -d");
  // A default share keeps its default path: only the access is written.
  assert.deepEqual(config.load(root).files.drive.shares, { notes: path.join(work, "glass"), projects: { access: "rw" } });
  assert.deepEqual((await ok(reg, "files.drive.status")).shares.map(x => [x.name, x.access]), [["projects", "rw"], ["notes", "ro"]]);

  // A string share becomes { path, access }, from the paired Mac this time; the mount already allows rw.
  process.env.VYRE_DRIVE_ACCESS = "rw";
  const b = await ok(reg, "files.drive.access", { name: "notes", mode: "rw" }, "tailnet:alex@example.com", { person: PERSON, peer: { stableId: MAC_ID } });
  assert.deepEqual(b.mount, { want: "rw", now: "rw", change: false });
  assert.deepEqual(config.load(root).files.drive.shares.notes, { path: path.join(work, "glass"), access: "rw" });

  // No share rw any more while the mount is rw: the step back to ro.
  await ok(reg, "files.drive.access", { name: "notes", mode: "ro" }, "capsule");
  const c = await ok(reg, "files.drive.access", { name: "projects", mode: "ro" });
  assert.deepEqual(c.mount, { want: "ro", now: "rw", change: true, step: "Set VYRE_DRIVE_ACCESS=ro in /srv/vyre/.env, then run docker compose up -d" });
  // vyred cannot see the mount: it says so and still gives the step.
  delete process.env.VYRE_DRIVE_ACCESS;
  assert.deepEqual((await ok(reg, "files.drive.access", { name: "projects", mode: "ro" })).mount, { want: "ro", now: "unknown", change: true, step: mountStep("ro") });
});

test("drive: files.drive.access is the owner's own action: no proof, while share still asks for one; agents and guests are refused", async t => {
  fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: "", whois: {} });
  const { work } = boxWorld(t);
  assert.ok(PERSON_ONLY.has("files.drive.access") && !HUMAN_ONLY.has("files.drive.access"));
  assert.ok(HUMAN_ONLY.has("files.drive.share") && HUMAN_ONLY.has("files.drive.unshare"));
  // A verifier that asks on every floor tool and never passes: whatever succeeds needed no proof.
  const presence = /** @type {any} */ ({
    required: (tool, def) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence),
    verify: async () => ({ ok: false, message: "needs a person", methods: ["test"] }),
    challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  });
  const { reg } = await registry(t, { role: "box", peers: [MAC_ID], presence, cfg: { projectsDir: path.join(work, "projects"), files: { roots: [work] } } });
  assert.equal((await ok(reg, "files.drive.access", { name: "projects", mode: "rw" })).access, "rw");
  assert.equal((await ok(reg, "files.drive.access", { name: "projects", mode: "ro" }, "tailnet:alex@example.com", { person: PERSON, peer: { stableId: MAC_ID } })).access, "ro");
  await no(reg, "files.drive.share", { name: "projects" }, "cli", "presence_required");
  for (const caller of ["mcp:agent:kit", "harness:agent:kit", "mcp", "tailnet-guest:sam@harlow.example"]) await no(reg, "files.drive.access", { name: "projects", mode: "rw" }, caller, "denied");
});

test("drive: a folder with a .env or a key anywhere inside is never shared, and says what it found", async t => {
  const ts = fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: "", whois: {} });
  const { work } = boxWorld(t);
  const env = path.join(work, "harlow"), key = path.join(work, "northwind"), fine = path.join(work, "kit");
  fs.mkdirSync(path.join(env, "app", "config"), { recursive: true });
  fs.writeFileSync(path.join(env, "app", "config", ".env.local"), "TOKEN=x\n");
  fs.writeFileSync(path.join(env, "README.md"), "hi\n");
  // A key by its first line, whatever it is called, and one by its name.
  fs.mkdirSync(path.join(key, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(key, "deploy", "juno"), `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----\nabc\n`);
  fs.writeFileSync(path.join(key, "server.pem"), "x\n");
  // A git checkout is not a secret: .git is hidden from Vyre's tools, not refused as a share.
  fs.mkdirSync(path.join(fine, ".git", "objects"), { recursive: true });
  fs.writeFileSync(path.join(fine, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(fine, "index.js"), "1\n");
  const { reg } = await registry(t, { role: "box", cfg: { files: { roots: [work], drive: { shares: { harlow: env, northwind: key, kit: fine } } } } });
  const e = await no(reg, "files.drive.share", { name: "harlow" }, "cli", "unsafe_share");
  assert.deepEqual(e.detail.found, [path.join("app", "config", ".env.local")]);
  const k = await no(reg, "files.drive.share", { name: "northwind" }, "cli", "unsafe_share");
  assert.deepEqual(k.detail.found, [path.join("deploy", "juno"), "server.pem"]);
  assert.ok(!ts.calls().some(c => c[0] === "drive" && c[1] === "share"));
  assert.equal((await ok(reg, "files.drive.share", { name: "kit" })).shared, "kit");
});

test("drive: the scan lists at most 10 findings, and refuses a tree too big to check", async t => {
  fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: "", whois: {} });
  const { work } = boxWorld(t);
  const many = path.join(work, "many"), big = path.join(work, "big");
  for (let i = 0; i < 12; i++) { fs.mkdirSync(path.join(many, `p${String(i).padStart(2, "0")}`), { recursive: true }); fs.writeFileSync(path.join(many, `p${String(i).padStart(2, "0")}`, ".env"), "x\n"); }
  fs.mkdirSync(big);
  for (let i = 0; i < 20_001; i++) fs.writeFileSync(path.join(big, `f${i}`), "");
  const { reg } = await registry(t, { role: "box", cfg: { files: { roots: [work], drive: { shares: { many, big } } } } });
  const m = await no(reg, "files.drive.share", { name: "many" }, "cli", "unsafe_share");
  assert.equal(m.detail.found.length, 10);
  const b = await no(reg, "files.drive.share", { name: "big" }, "cli", "unsafe_share");
  assert.equal(b.detail.tooBig, true);
  assert.match(b.message, /too many to check/);
});

test("drive: the scan skips dependency and build folders and .git/objects, and reads .git/config for a credential", async t => {
  fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: "", whois: {} });
  const { work } = boxWorld(t);
  const site = path.join(work, "site"), clean = path.join(work, "clean"), linked = path.join(work, "linked");
  // Secrets inside skipped folders are not looked at; one in src is.
  for (const d of ["node_modules/pkg", "dist", ".next", "target", "venv", ".venv", "src", ".git/objects/ab", ".git/hooks"]) fs.mkdirSync(path.join(site, d), { recursive: true });
  for (const d of ["node_modules/pkg", "dist", ".next", "target", "venv", ".venv", ".git/objects/ab"]) fs.writeFileSync(path.join(site, d, ".env"), "TOKEN=x\n");
  fs.writeFileSync(path.join(site, "src", ".env"), "TOKEN=x\n");
  fs.writeFileSync(path.join(site, ".git", "hooks", ".env"), "TOKEN=x\n");
  fs.writeFileSync(path.join(site, ".git", "config"), '[remote "origin"]\n\turl = https://x-access-token:abc@github.com/northwind/site\n');
  // A clean checkout: no findings, and a folder named objects outside .git is walked.
  for (const d of [".git/objects/ab", "objects", "node_modules/pkg"]) fs.mkdirSync(path.join(clean, d), { recursive: true });
  fs.writeFileSync(path.join(clean, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/northwind/site\n[remote "box"]\n\turl = ssh://git@github.com/northwind/site\n');
  fs.writeFileSync(path.join(clean, ".git", "objects", "ab", "cd"), "x\n");
  fs.writeFileSync(path.join(clean, "node_modules", "pkg", "index.js"), "1\n");
  fs.writeFileSync(path.join(clean, "index.js"), "1\n");
  // A link named node_modules is not skipped: it is checked as a link, here to an .ssh folder.
  fs.mkdirSync(path.join(linked, "src"), { recursive: true });
  const ssh = path.join(path.dirname(work), "juno", ".ssh");
  fs.mkdirSync(ssh, { recursive: true });
  fs.writeFileSync(path.join(ssh, "id_ed25519"), "x\n");
  fs.symlinkSync(ssh, path.join(linked, "node_modules"));
  const { reg } = await registry(t, { role: "box", cfg: { files: { roots: [work], drive: { shares: { site, clean, linked } } } } });
  const e = await no(reg, "files.drive.share", { name: "site" }, "cli", "unsafe_share");
  assert.deepEqual(e.detail.found, [path.join(".git", "config"), path.join(".git", "hooks", ".env"), path.join("src", ".env")]);
  assert.equal((await ok(reg, "files.drive.share", { name: "clean" })).shared, "clean");
  const l = await no(reg, "files.drive.share", { name: "linked" }, "cli", "unsafe_share");
  assert.deepEqual(l.detail.found, ["node_modules"]);
  // An extraheader with Authorization is a credential too.
  fs.appendFileSync(path.join(clean, ".git", "config"), '[http]\n\textraheader = AUTHORIZATION: basic eHg=\n');
  assert.deepEqual((await no(reg, "files.drive.share", { name: "clean" }, "cli", "unsafe_share")).detail.found, [path.join(".git", "config")]);
});

test("drive: gitConfigCredential finds a user or token before the host, and an Authorization extraheader", () => {
  for (const c of ["url = https://x-access-token:abc@github.com/northwind/site", "url = https://abc@github.com/northwind/site",
    "url = ssh://kit:pw@example.com/x", "\textraheader = Authorization: Bearer abc"]) assert.equal(gitConfigCredential(c), true, c);
  for (const c of ["url = https://github.com/northwind/site", "url = ssh://git@github.com/northwind/site", "url = git@github.com:northwind/site.git",
    "[user]\n\temail = alex@example.com", "\textraheader = X-Trace: 1"]) assert.equal(gitConfigCredential(c), false, c);
});

test("drive: the audit scans every shared folder again and reports one with a secret in it", async t => {
  const ts = fakeTailscale(t, { status: statusJson({ selfCaps: { "drive:share": null } }), list: "", whois: { "100.64.0.7": whoisJson(MAC_ID, "alex-mac", DRIVE_RW) } });
  const { work, real } = boxWorld(t);
  const site = path.join(work, "site");
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, "index.html"), "hi\n");
  const { reg, events } = await registry(t, { role: "box", peers: [MAC_ID], cfg: { files: { roots: [work], drive: { shares: { site, notes: path.join(work, "glass") } } } } });
  assert.equal((await ok(reg, "files.drive.share", { name: "site" })).audit.ok, true);
  // A secret lands in the folder after it was shared. notes is offered but not shared: not scanned.
  fs.writeFileSync(path.join(site, ".env"), "TOKEN=x\n");
  fs.writeFileSync(path.join(work, "glass", ".env"), "TOKEN=x\n");
  ts.set({ list: `name    path${" ".repeat(real.length)}    as\n----    ${"-".repeat(real.length + 4)}    ----\nsite    ${path.join(real, "site")}    vyre\n` });
  const a = await ok(reg, "files.drive.audit", {}, "mcp");
  assert.equal(a.ok, false);
  assert.deepEqual(a.findings, []);
  assert.deepEqual(a.unsafe, [{ share: "site", found: [".env"] }]);
  const ev = events.since(0, { type: "drive.exposed" });
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload.unsafe, [{ share: "site", found: [".env"] }]);
});

// ---- the Mac -----------------------------------------------------------------------------

/** The Mac, with a fake link to a box that shares projects, and seams that record instead of mounting. */
async function mac(t, { boxShares = [{ name: "projects", path: "/work", shared: true }, { name: "glass-files", path: "/work/glass", shared: false }], selfCaps = { "drive:access": null }, access = "ro" } = {}) {
  fakeTailscale(t, { status: statusJson({ self: "alex-mac", selfCaps }) });
  const home = tmp(t, "vyre-machome-");
  const did = [];
  let mounted = [];
  const seam = {
    home,
    mounts: async () => mounted,
    mount: async (url, dir, opts) => { did.push(["mount", url, dir, opts]); mounted.push(dir); },
    unmount: async dir => { did.push(["unmount", dir]); mounted = mounted.filter(d => d !== dir); },
    open: async target => { did.push(["open", target]); },
  };
  const remote = [];
  const link = {
    status: { role: "local", linked: true, box: { address: "https://alex.vyre.run", name: "vyre", node: "vyre.tail0000.ts.net" }, reachable: true },
    remote: async (tool, input) => {
      remote.push([tool, input]);
      if (tool === "files.drive.status") return { data: { enabled: true, access, shares: boxShares, list: [] } };
      if (tool === "files.drive.share") return { data: { shared: input.name } };
      if (tool === "files.drive.access") return { data: { name: input.name, access: input.mode } };
      return { error: { code: "no_such_tool", message: tool } };
    },
  };
  const { reg } = await registry(t, { role: "local", link, seam, cfg: { files: { roots: [tmp(t, "vyre-macroot-")] } } });
  return { reg, did, remote, home };
}

test("drive: the Mac builds the share's URL and says when its own policy is missing", async t => {
  const m = await mac(t);
  assert.deepEqual(await ok(m.reg, "files.drive.url", { share: "projects" }),
    { url: "http://100.100.100.100:8080/example.com/vyre/projects", tailnet: "example.com", machine: "vyre", share: "projects", ready: true });
  await no(m.reg, "files.drive.url", { share: "../x" }, "cli", "bad_input");
  const off = await mac(t, { selfCaps: {} });
  const u = await ok(off.reg, "files.drive.url", { share: "projects" });
  assert.equal(u.ready, false);
  assert.match(u.fix, /drive:access/);
  await no(off.reg, "files.drive.mount", { share: "projects" }, "cli", "drive_off");
  assert.deepEqual(off.did, []);
});

test("drive: mount goes through the seam with the URL and ~/Vyre/Box/<share>, then box paths open where they are", async t => {
  const m = await mac(t);
  const dir = path.join(m.home, "Vyre", "Box", "projects");
  // Not mounted yet: a box file has no local copy, and open refuses.
  assert.deepEqual(await ok(m.reg, "files.drive.local", { path: "/work/notes.md" }), { local: null });
  await no(m.reg, "files.drive.open", { share: "projects" }, "cli", "not_mounted");

  const r = await ok(m.reg, "files.drive.mount", { share: "projects" });
  assert.deepEqual(r, { share: "projects", dir, url: "http://100.100.100.100:8080/example.com/vyre/projects", readonly: true });
  assert.deepEqual(m.did, [["mount", "http://100.100.100.100:8080/example.com/vyre/projects", dir, { readonly: true, name: "projects" }]]);
  // Mounting again is a no-op.
  await ok(m.reg, "files.drive.mount", { share: "projects" });
  assert.equal(m.did.length, 1);

  assert.deepEqual(await ok(m.reg, "files.drive.local", { path: "/work/src/app.js" }), { local: path.join(dir, "src", "app.js"), share: "projects" });
  assert.deepEqual(await ok(m.reg, "files.drive.local", { path: "/work/../etc/passwd" }), { local: null });
  assert.deepEqual(await ok(m.reg, "files.drive.local", { path: "/srv/else.txt" }), { local: null });

  const s = await ok(m.reg, "files.drive.status");
  assert.deepEqual(s.shares.map(x => [x.name, x.mounted]), [["projects", true], ["glass-files", false]]);

  await ok(m.reg, "files.drive.open", { share: "projects", path: "src/app.js" });
  await ok(m.reg, "files.drive.open", { share: "projects" });
  assert.deepEqual(m.did.slice(1), [["open", path.join(dir, "src", "app.js")], ["open", dir]]);
  for (const bad of ["../../etc", "/etc/passwd", "a/../../b"]) await no(m.reg, "files.drive.open", { share: "projects", path: bad }, "cli", "bad_input");

  // A share the box offers but is not sharing, or does not offer, is not mounted.
  await no(m.reg, "files.drive.mount", { share: "glass-files" }, "cli", "not_shared");
  await no(m.reg, "files.drive.mount", { share: "other" }, "cli", "unknown_share");

  assert.deepEqual(await ok(m.reg, "files.drive.unmount", { share: "projects" }), { share: "projects", unmounted: true });
  assert.deepEqual(m.did.at(-1), ["unmount", dir]);
  assert.deepEqual(await ok(m.reg, "files.drive.local", { path: "/work/src/app.js" }), { local: null });
});

test("drive: a read-write box mounts read-write; mount, open and share are refused to agents on the Mac", async t => {
  const m = await mac(t, { access: "rw" });
  assert.equal((await ok(m.reg, "files.drive.mount", { share: "projects" }, "capsule")).readonly, false);
  for (const tool of ["files.drive.mount", "files.drive.unmount", "files.drive.open", "files.drive.share", "files.drive.unshare"]) {
    await no(m.reg, tool, { share: "projects", name: "projects" }, "mcp:agent:kit", "denied");
    await no(m.reg, tool, { share: "projects", name: "projects" }, "mcp", "denied");
  }
  assert.ok(!m.remote.some(([tool]) => tool === "files.drive.share"));
  assert.deepEqual(await ok(m.reg, "files.drive.share", { name: "projects" }), { shared: "projects" });
});

test("drive: the Mac mounts each share by its own access, and a box without per-share access by the top-level one", async t => {
  const m = await mac(t, { access: "rw", boxShares: [{ name: "projects", path: "/work", access: "ro", shared: true }, { name: "site", path: "/work/site", access: "rw", shared: true }] });
  assert.equal((await ok(m.reg, "files.drive.mount", { share: "projects" })).readonly, true);
  assert.equal((await ok(m.reg, "files.drive.mount", { share: "site" })).readonly, false);
  assert.deepEqual(m.did.map(d => [path.basename(d[2]), d[3].readonly]), [["projects", true], ["site", false]]);
  const old = await mac(t, { access: "ro" });
  assert.equal((await ok(old.reg, "files.drive.mount", { share: "projects" })).readonly, true);
  // files.drive.access on the Mac forwards to the box, and never for an agent.
  await no(m.reg, "files.drive.access", { name: "site", mode: "ro" }, "mcp:agent:kit", "denied");
  assert.deepEqual(await ok(m.reg, "files.drive.access", { name: "site", mode: "ro" }), { name: "site", access: "ro" });
  assert.deepEqual(m.remote.filter(([tool]) => tool === "files.drive.access"), [["files.drive.access", { name: "site", mode: "ro" }]]);
});

test("drive: without a seam, mount and open refuse under tests instead of touching the Mac", async t => {
  fakeTailscale(t, { status: statusJson({ self: "alex-mac", selfCaps: { "drive:access": null } }) });
  const home = tmp(t, "vyre-machome-");
  const link = { status: { box: { node: "vyre.tail0000.ts.net" } },
    remote: async () => ({ data: { access: "ro", shares: [{ name: "projects", path: "/work", shared: true }] } }) };
  // Only home and mounts are faked: mount itself is the real one, which must refuse.
  const { reg } = await registry(t, { role: "local", link, seam: { home, mounts: async () => [] }, cfg: { files: { roots: [home] } } });
  await no(reg, "files.drive.mount", { share: "projects" }, "cli", "off_in_tests");
});
