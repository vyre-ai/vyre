// @ts-check
// The box's shares inside a real Registry: which folders are offered (config files.drive.shares, the project and Glass defaults), what status says, the name search across shares,
// browsing and reading a file in one (files.drive.list and files.drive.read), the # tag for a file, and the project's Generated folder, each scoped to a named agent's own granted projects.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import * as config from "../config/index.js";
import { tempHome, writeModule, removeHome } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { installFakeReach, clearFakeReach } from "../../test/fixtures/fake-reach.js";
import { shareMap, shareSpecs } from "./drive.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


/**
 * The registries a test started, stopped once, in order, BEFORE any temp dir is removed. After-hooks run in the order they
 * were added, and a test builds its temp dirs
 * before the registry: a removal that ran first raced that late write (ENOTEMPTY on a busy runner, 30 Sep).
 * @type {WeakMap<object, { stop: () => Promise<void>, items: { reg: any, db: any }[], hooked: boolean }>}
 */
const running = new WeakMap();
function stoppers(t) {
  let r = running.get(t);
  if (!r) {
    r = { items: [], hooked: false, async stop() { const all = r.items.splice(0); for (const { reg, db } of all) { try { await reg.stop(); } catch {} try { db.close(); } catch {} } } };
    running.set(t, r);
  }
  if (!r.hooked) { r.hooked = true; t.after(() => r.stop()); }
  return r;
}

function tmp(t, prefix = "vyre-drive-") {
  stoppers(t);
  const dir = fs.mkdtempSync(path.join(SCRATCH, prefix));
  t.after(() => removeHome(dir));
  return dir;
}


/** A registry with the files module, and on the Mac a fake link module (status and remote). */
async function registry(t, { role, cfg = {}, presence = undefined, agents = undefined, projects = undefined, access = undefined, media = undefined }) {
  /** @type {any} */ let reg = null, db = null;
  const root = tmp(t, "vyre-home-");
  const p = config.ensure(root);
  const found = discover([CORE]).filter(f => f.manifest && f.manifest.name === "files");
  {
    // Always installed (not just when a test cares about agent scoping): access.js's reach() now
    // asks projects.reach even to decide who the OWNER is, so without this a plain "cli" caller
    // in a test that never mentioned an agent would be refused too.
    const mods = tmp(t, "vyre-fake-agents-");
    installFakeReach(mods, root, { agents: agents || [], projects: projects || [], access: access || {} });
    t.after(() => clearFakeReach(root));
    found.push(...discover([mods]));
  }
  if (media) {
    // A stand-in for the artifacts module: the generated media of each project, and their bytes.
    const mods = tmp(t, "vyre-artifacts-");
    globalThis.__driveMedia = globalThis.__driveMedia || new Map();
    globalThis.__driveMedia.set(root, media);
    t.after(() => globalThis.__driveMedia.delete(root));
    writeModule(mods, "artifacts", { roles: ["box"], does: { tools: [{ name: "artifacts.list", reach: "anyone", effect: "read", projectArg: "project" }, { name: "artifacts.media.read", reach: "modules" }] } },
      `export default { async start(ctx) {
        const m = () => globalThis.__driveMedia.get(ctx.paths.root);
        ctx.tool("artifacts.list", { run: async ({ kind, project }) => ({ artifacts: m().filter(a => a.kind === kind && a.project === project).map(({ bytes_b64, ...a }) => a) }) });
        ctx.tool("artifacts.media.read", { run: async ({ id, offset = 0, length = 1048576 }) => {
          const a = m().find(x => x.id === id);
          if (!a) throw Object.assign(new Error("no such artifact"), { code: "not_found" });
          const all = Buffer.from(a.bytes_b64, "base64");
          const part = all.subarray(offset, offset + length);
          return { mime: a.mime, size: all.length, offset, length: part.length, eof: offset + part.length >= all.length, bytes_b64: part.toString("base64") };
        } });
        return { async stop() {} };
      } };`);
    found.push(...discover([mods]));
  }
  db = open(p.db);
  const events = new Events(db);
  reg = new Registry({ db, events, config: { role, ...cfg }, paths: p, log: () => {}, ...(presence ? { presence } : {}) });
  stoppers(t).items.push({ reg, db });
  await reg.start(found, { role });
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
  // An agent's call to a tool the agent-reach table says asks first is held at the Gate and, with no Gate wired, answers `held_unavailable`: nothing ran, which is the refusal.
  const heldAgent = code === "denied" && /(^|[:\s])agent:/.test(caller) && r.error.code === "held_unavailable";
  // A claimed person with no proven session is refused by the person-session gate before the tool runs: `person_session_required` is the same refusal.
  const noSession = code === "denied" && r.error.code === "person_session_required";
  assert.equal(heldAgent || noSession ? code : r.error.code, code, r.error.message);
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


test("drive: default shares come from projectsDir, the files roots and glass.roots", () => {
  assert.deepEqual(shareMap({ projectsDir: "/work/projects", glass: { roots: ["/work/glass"] } }, ["/work"]),
    { projects: "/work/projects", "glass-files": "/work/glass" });
  // projectsDir outside every files root (the box's default, under the home volume): the first root.
  assert.deepEqual(shareMap({ projectsDir: "/home/vyre/Vyre/projects" }, ["/work"]), { projects: "/work" });
  // Config adds, overrides and removes; a name outside lowercase letters, digits, dash and underscore is dropped.
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

test("drive: files.drive.status gives each share its access, and shows a named agent only the shares inside its own granted project", async t => {
  const { work } = boxWorld(t);
  const harlow = path.join(work, "harlow-site"), northwind = path.join(work, "northwind");
  fs.mkdirSync(harlow, { recursive: true }); fs.mkdirSync(northwind, { recursive: true });
  const { reg } = await registry(t, { role: "box", cfg: { files: { roots: [work], drive: { shares: { harlow, northwind } } } },
    agents: [{ name: "kit", kind: "agent", projects: ["harlow"] }],
    projects: [{ slug: "harlow", name: "Harlow Legal", home: harlow, workspaces: [] }, { slug: "northwind", name: "Northwind", home: northwind, workspaces: [] }],
    access: { "harlow:kit": true } }); // northwind left out: deny by default

  const full = await ok(reg, "files.drive.status"); // the owner's own surface: unrestricted
  assert.deepEqual(full.shares.map(s => s.name).sort(), ["harlow", "northwind", "projects"]);

  const scoped = await ok(reg, "files.drive.status", {}, "mcp:agent:kit");
  assert.deepEqual(scoped.shares.map(s => s.name), ["harlow"]);
});

// ---- Vyre Drive step: files.drive.search, the backend behind Capsule find-a-file and the
// Windows panel's "search my box" (no local index of its own) -----------------------------

test("drive: files.drive.search finds a name across every offered share, by default", async t => {
  const { work } = boxWorld(t);
  const harlow = path.join(work, "harlow-site"), northwind = path.join(work, "northwind");
  fs.mkdirSync(harlow, { recursive: true }); fs.mkdirSync(northwind, { recursive: true });
  fs.writeFileSync(path.join(harlow, "intake-brief.md"), "hello\n");
  fs.writeFileSync(path.join(northwind, "site-brief.md"), "hello\n");
  fs.writeFileSync(path.join(northwind, "notes.txt"), "unrelated\n");
  const { reg } = await registry(t, { role: "box", cfg: { files: { roots: [work], drive: { shares: { projects: null, harlow, northwind } } } } });
  const r = await ok(reg, "files.drive.search", { q: "brief" });
  assert.deepEqual(r.results.map(x => [x.share, x.name]).sort(), [["harlow", "intake-brief.md"], ["northwind", "site-brief.md"]]);
  assert.equal((await ok(reg, "files.drive.search", { q: "brief", share: "harlow" })).results.length, 1);
  await no(reg, "files.drive.search", { q: "brief", share: "nope" }, "cli", "unknown_share");
  await no(reg, "files.drive.search", { q: "  " }, "cli", "bad_input");
  const kinded = await ok(reg, "files.drive.search", { q: "e", kinds: ["text"] });
  assert.ok(kinded.results.every(x => x.kind === "text"));
});

test("drive: files.drive.search never crosses into a share a secret-scan would refuse, nor outside the guard", async t => {
  const { work } = boxWorld(t);
  const site = path.join(work, "site");
  fs.mkdirSync(path.join(site, "src"), { recursive: true });
  fs.writeFileSync(path.join(site, "src", "brief.md"), "x\n");
  fs.writeFileSync(path.join(site, ".env"), "TOKEN=x\n"); // a secret elsewhere in the same folder
  const { reg } = await registry(t, { role: "box", cfg: { files: { roots: [work], drive: { shares: { projects: null, site } } } } });
  // A secret next to it does not stop the rest of the folder from being searched or found...
  const r = await ok(reg, "files.drive.search", { q: "brief" });
  assert.deepEqual(r.results.map(x => x.name), ["brief.md"]);
  // ...but the secret itself is never a result, whatever it is asked for.
  assert.deepEqual((await ok(reg, "files.drive.search", { q: "env" })).results, []);
});

test("drive: files.drive.search narrows a named agent to the shares its own granted projects reach", async t => {
  const { work } = boxWorld(t);
  const harlow = path.join(work, "harlow-site"), northwind = path.join(work, "northwind");
  fs.mkdirSync(harlow, { recursive: true }); fs.mkdirSync(northwind, { recursive: true });
  fs.writeFileSync(path.join(harlow, "brief.md"), "hello\n");
  fs.writeFileSync(path.join(northwind, "brief.md"), "hello\n");
  const { reg } = await registry(t, { role: "box", cfg: { files: { roots: [work], drive: { shares: { projects: null, harlow, northwind } } } },
    agents: [{ name: "kit", kind: "agent", projects: ["harlow"] }],
    projects: [{ slug: "harlow", name: "Harlow Legal", home: harlow, workspaces: [] }, { slug: "northwind", name: "Northwind", home: northwind, workspaces: [] }],
    access: { "harlow:kit": true } });
  const full = await ok(reg, "files.drive.search", { q: "brief" });
  assert.deepEqual(full.results.map(x => x.share).sort(), ["harlow", "northwind"]);
  const scoped = await ok(reg, "files.drive.search", { q: "brief" }, "mcp:agent:kit");
  assert.deepEqual(scoped.results.map(x => x.share), ["harlow"]);
  // Asking by name for a share it has no grant on: empty, not a refusal (same shape as a search
  // that simply finds nothing, so an ungranted share's existence is never confirmed either way).
  assert.deepEqual((await ok(reg, "files.drive.search", { q: "brief", share: "northwind" }, "mcp:agent:kit")).results, []);
});

test("drive: files.drive.search narrows to the granted subfolder when the share is broader than the grant (reviewer H1)", async t => {
  const { work } = boxWorld(t); // boxWorld's own "work" root doubles as the one broad share
  const a = path.join(work, "a"), b = path.join(work, "b");
  fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, "brief.md"), "hello\n");
  fs.writeFileSync(path.join(b, "brief.md"), "hello\n"); // a sibling project under the same share
  const { reg } = await registry(t, { role: "box", cfg: { files: { roots: [work], drive: { shares: { projects: null, whole: work } } } },
    agents: [{ name: "kit", kind: "agent", projects: ["proja"] }],
    projects: [{ slug: "proja", name: "A", home: a, workspaces: [] }],
    access: { "proja:kit": true } });
  const full = await ok(reg, "files.drive.search", { q: "brief" });
  assert.deepEqual(full.results.map(x => x.name).sort(), ["brief.md", "brief.md"]); // the owner sees the whole share
  const scoped = await ok(reg, "files.drive.search", { q: "brief" }, "mcp:agent:kit");
  assert.equal(scoped.results.length, 1);
  assert.equal(scoped.results[0].path, path.join(fs.realpathSync(a), "brief.md")); // never b/brief.md
  // A query that only b's file would match (its own name) finds nothing for kit either.
  fs.writeFileSync(path.join(b, "only-in-b.md"), "x\n");
  assert.deepEqual((await ok(reg, "files.drive.search", { q: "only-in-b" }, "mcp:agent:kit")).results, []);
  assert.equal((await ok(reg, "files.drive.search", { q: "only-in-b" })).results.length, 1);
});

test("drive: files.drive.search's unknown_share never lists the box's other shares to a named agent (reviewer M1)", async t => {
  const { work } = boxWorld(t);
  const harlow = path.join(work, "harlow-site");
  fs.mkdirSync(harlow, { recursive: true });
  const { reg } = await registry(t, { role: "box", cfg: { files: { roots: [work], drive: { shares: { harlow } } } },
    agents: [{ name: "kit", kind: "agent", projects: ["harlow"] }],
    projects: [{ slug: "harlow", name: "Harlow Legal", home: harlow, workspaces: [] }],
    access: { "harlow:kit": true } });
  const owner = await no(reg, "files.drive.search", { q: "x", share: "nope" }, "cli", "unknown_share");
  assert.match(owner.message, /the box offers/);
  const agent = await no(reg, "files.drive.search", { q: "x", share: "nope" }, "mcp:agent:kit", "unknown_share");
  assert.doesNotMatch(agent.message, /the box offers/);
  assert.doesNotMatch(agent.message, /projects|glass-files/);
});

// ---- the Mac -----------------------------------------------------------------------------

// ---- browsing a share from a phone -------------------------------------------------------

test("drive browse: list shows a share's entries, folders first, and hides what the guard hides; read gives chunks", async t => {
  const { work } = boxWorld(t);
  const site = path.join(work, "site"), outside = path.join(work, "outside");
  fs.mkdirSync(path.join(site, "docs"), { recursive: true }); fs.mkdirSync(path.join(site, ".git"), { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(site, "b.txt"), "hello world");
  fs.writeFileSync(path.join(site, "a.md"), "# a\n");
  fs.writeFileSync(path.join(site, ".env"), "TOKEN=x\n");
  fs.writeFileSync(path.join(site, "id_rsa"), "x\n");
  fs.writeFileSync(path.join(site, "docs", "c.txt"), "c");
  fs.writeFileSync(path.join(outside, "secret.txt"), "no");
  fs.symlinkSync(outside, path.join(site, "leak"));
  const { reg } = await registry(t, { role: "box", cfg: { files: { roots: [work], drive: { shares: { site } } } } });
  const l = await ok(reg, "files.drive.list", { share: "site" });
  assert.deepEqual(l.entries.map(e => [e.name, e.dir]), [["docs", true], ["a.md", false], ["b.txt", false]]);
  assert.equal(l.total, 3);
  const sub = await ok(reg, "files.drive.list", { share: "site", path: "docs" });
  assert.deepEqual(sub.entries.map(e => e.name), ["c.txt"]);
  assert.equal(sub.path, "/docs");
  const p1 = await ok(reg, "files.drive.list", { share: "site", limit: 2 });
  assert.equal(p1.entries.length, 2);
  assert.equal(p1.next, 2);
  assert.deepEqual((await ok(reg, "files.drive.list", { share: "site", limit: 2, offset: 2 })).entries.map(e => e.name), ["b.txt"]);

  const r = await ok(reg, "files.drive.read", { share: "site", path: "b.txt", offset: 0, length: 5 });
  assert.deepEqual([Buffer.from(r.base64, "base64").toString(), r.size, r.done, r.length], ["hello", 11, false, 5]);
  const r2 = await ok(reg, "files.drive.read", { share: "site", path: "/b.txt", offset: 5 });
  assert.deepEqual([Buffer.from(r2.base64, "base64").toString(), r2.done], [" world", true]);

  for (const bad of [".env", "id_rsa", "leak/secret.txt", "leak", ".git"]) await no(reg, "files.drive.read", { share: "site", path: bad }, "cli", "not_available");
  await no(reg, "files.drive.list", { share: "site", path: "leak" }, "cli", "not_available");
  await no(reg, "files.drive.list", { share: "site", path: "../outside" }, "cli", "bad_input");
  await no(reg, "files.drive.read", { share: "site", path: "docs" }, "cli", "bad_input");
  await no(reg, "files.drive.list", { share: "site", path: "b.txt" }, "cli", "bad_input");
  await no(reg, "files.drive.list", { share: "nope" }, "cli", "not_available");
});

test("drive browse: a named agent lists and reads only inside its own granted folder of a broader share", async t => {
  const { work } = boxWorld(t);
  const a = path.join(work, "a"), b = path.join(work, "b");
  for (const d of [a, b]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(a, "one.txt"), "1"); fs.writeFileSync(path.join(b, "two.txt"), "2");
  const { reg } = await registry(t, { role: "box",
    agents: [{ name: "kit", kind: "agent", projects: ["a"] }],
    projects: [{ slug: "a", name: "A", home: a, workspaces: [] }, { slug: "b", name: "B", home: b, workspaces: [] }], access: { "a:kit": true },
    cfg: { files: { roots: [work], drive: { shares: { work } } } } });
  assert.deepEqual((await ok(reg, "files.drive.list", { share: "work", path: "a" }, "mcp:agent:kit")).entries.map(e => e.name), ["one.txt"]);
  assert.equal(Buffer.from((await ok(reg, "files.drive.read", { share: "work", path: "a/one.txt" }, "mcp:agent:kit")).base64, "base64").toString(), "1");
  await no(reg, "files.drive.list", { share: "work", path: "b" }, "mcp:agent:kit", "not_available");
  await no(reg, "files.drive.read", { share: "work", path: "b/two.txt" }, "mcp:agent:kit", "not_available");
  await no(reg, "files.drive.list", { share: "work" }, "mcp:agent:kit", "not_available"); // the share's top is not the grant
  assert.deepEqual((await ok(reg, "files.drive.list", { share: "work", path: "b" })).entries.map(e => e.name), ["two.txt"]);
});

test("drive browse: a link inside a granted folder to another project is not a way in (reviewer M1)", async t => {
  const { work } = boxWorld(t);
  const a = path.join(work, "a"), b = path.join(work, "b");
  for (const d of [a, b]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(a, "one.txt"), "1"); fs.writeFileSync(path.join(b, "two.txt"), "2");
  fs.symlinkSync("../b", path.join(a, "link"));
  const { reg } = await registry(t, { role: "box",
    agents: [{ name: "kit", kind: "agent", projects: ["a"] }],
    projects: [{ slug: "a", name: "A", home: a, workspaces: [] }, { slug: "b", name: "B", home: b, workspaces: [] }], access: { "a:kit": true },
    cfg: { files: { roots: [work], drive: { shares: { work } } } } });
  assert.deepEqual((await ok(reg, "files.drive.list", { share: "work", path: "a" }, "mcp:agent:kit")).entries.map(e => e.name), ["one.txt"]);
  await no(reg, "files.drive.list", { share: "work", path: "a/link" }, "mcp:agent:kit", "not_available");
  await no(reg, "files.drive.read", { share: "work", path: "a/link/two.txt" }, "mcp:agent:kit", "not_available");
  assert.equal((await ok(reg, "files.drive.measure", { path: path.join(a, "link") }, "mcp:agent:kit")).why, "not available");
});

// ---- files as a # tag --------------------------------------------------------------------

test("drive mentions: search finds files by name; resolve, for the chat only, lets that thread read that one file", async t => {
  const { work } = boxWorld(t);
  const a = path.join(work, "a"), b = path.join(work, "b");
  for (const d of [a, b]) fs.mkdirSync(path.join(d, "docs"), { recursive: true });
  fs.writeFileSync(path.join(a, "docs", "report.md"), "quarterly"); fs.writeFileSync(path.join(a, "other.md"), "x"); fs.writeFileSync(path.join(b, "report-b.md"), "b");
  const { reg, events } = await registry(t, { role: "box",
    agents: [{ name: "kit", kind: "agent", projects: [] }],
    projects: [{ slug: "a", name: "A", home: a, workspaces: [] }, { slug: "b", name: "B", home: b, workspaces: [] }], access: {},
    cfg: { files: { roots: [work], drive: { shares: { projects: null, work } } } } });
  const s = await ok(reg, "files.mentions.search", { q: "report" }, "deck");
  assert.deepEqual(s.items.map(i => [i.id, i.name, i.hint, i.icon]).sort(), [["work:a/docs/report.md", "report.md", "work/a/docs", "file"], ["work:b/report-b.md", "report-b.md", "work/b", "file"]]);
  assert.deepEqual((await ok(reg, "files.mentions.search", { q: "" }, "deck")).items, []);

  // Before the tag the agent has no way in.
  await no(reg, "files.drive.read", { share: "work", path: "a/docs/report.md" }, "mcp:agent:kit", "not_available", { thread: "t1" });
  // Only the sessions module (or the assistant) resolves a tag.
  {
    const r = await reg.call("files.mentions.resolve", { id: "work:a/docs/report.md", thread: "t1" }, "deck");
    assert.ok(r.error && ["denied", "no_such_tool"].includes(r.error.code), "a person's surface cannot resolve a tag: " + JSON.stringify(r.error));
  }
  await no(reg, "files.mentions.resolve", { id: "work:a/docs/nope.md", thread: "t1" }, "module:sessions", "not_found");
  await no(reg, "files.mentions.resolve", { id: "work:a/docs", thread: "t1" }, "module:sessions", "not_found");
  const r = await ok(reg, "files.mentions.resolve", { id: "work:a/docs/report.md", thread: "t1", said: "s1" }, "module:sessions");
  assert.equal(r.name, "report.md");
  assert.match(r.note, /files\.drive\.read/);
  assert.deepEqual(r.grant, { read: "work:a/docs/report.md" });
  // That thread reads that file, and nothing beside it, and no other thread reads it.
  assert.equal(Buffer.from((await ok(reg, "files.drive.read", { share: "work", path: "a/docs/report.md" }, "mcp:agent:kit", { thread: "t1" })).base64, "base64").toString(), "quarterly");
  await no(reg, "files.drive.read", { share: "work", path: "a/other.md" }, "mcp:agent:kit", "not_available", { thread: "t1" });
  await no(reg, "files.drive.read", { share: "work", path: "a/docs/report.md" }, "mcp:agent:kit", "not_available", { thread: "t2" });
  await no(reg, "files.drive.list", { share: "work", path: "a/docs" }, "mcp:agent:kit", "not_available", { thread: "t1" });
  // Swap the file for a link to another project: the grant was for that file, not that name.
  fs.unlinkSync(path.join(a, "docs", "report.md"));
  fs.symlinkSync(path.join(b, "report-b.md"), path.join(a, "docs", "report.md"));
  await no(reg, "files.drive.read", { share: "work", path: "a/docs/report.md" }, "mcp:agent:kit", "not_available", { thread: "t1" });
  // The chat is deleted: its grant goes with it.
  await ok(reg, "files.mentions.resolve", { id: "work:a/other.md", thread: "t3" }, "module:sessions");
  await ok(reg, "files.drive.read", { share: "work", path: "a/other.md" }, "mcp:agent:kit", { thread: "t3" });
  events.emit("sessions", "thread.deleted", { thread: "t3" }, { thread: "t3" });
  await no(reg, "files.drive.read", { share: "work", path: "a/other.md" }, "mcp:agent:kit", "not_available", { thread: "t3" });
  // Archiving keeps the grant: an archived chat can come back.
  await ok(reg, "files.mentions.resolve", { id: "work:a/other.md", thread: "t4" }, "module:sessions");
  events.emit("sessions", "thread.archived", { thread: "t4" }, { thread: "t4" });
  await ok(reg, "files.drive.read", { share: "work", path: "a/other.md" }, "mcp:agent:kit", { thread: "t4" });
});

// ---- Generated: the media models made, inside the project's folder ----------------------------

test("drive generated: a project's folder shows a Generated folder with its images and video, read through artifacts and scoped like the project", async t => {
  const { work } = boxWorld(t);
  const a = path.join(work, "a"), b = path.join(work, "b");
  for (const d of [a, b]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(a, "notes.md"), "n");
  const png = Buffer.from("PNGDATA-0123456789");
  const media = [
    { id: "art-aaaaaaaa1", kind: "image", format: "png", mime: "image/png", bytes: png.length, title: "Harbour: dawn/1", created_at: "2026-10-01T10:00:00Z", project: "a", bytes_b64: png.toString("base64") },
    { id: "art-bbbbbbbb2", kind: "image", format: "png", mime: "image/png", bytes: 3, title: "Harbour: dawn/1", created_at: "2026-10-01T09:00:00Z", project: "a", bytes_b64: Buffer.from("xyz").toString("base64") },
    { id: "art-cccccccc3", kind: "video", format: "mp4", mime: "video/mp4", bytes: 4, title: "Clip", created_at: "2026-10-01T08:00:00Z", project: "a", bytes_b64: Buffer.from("MP4!").toString("base64") },
    { id: "art-dddddddd4", kind: "image", format: "jpeg", mime: "image/jpeg", bytes: 2, title: "Other project", created_at: "2026-10-01T07:00:00Z", project: "b", bytes_b64: Buffer.from("zz").toString("base64") },
  ];
  const { reg } = await registry(t, { role: "box", media,
    agents: [{ name: "kit", kind: "agent", projects: ["a"] }],
    projects: [{ slug: "a", name: "A", home: a, workspaces: [] }, { slug: "b", name: "B", home: b, workspaces: [] }], access: { "a:kit": true },
    cfg: { files: { roots: [work], drive: { shares: { projects: null, work } } } } });
  // The project's folder: the real files, and a Generated folder because it has media. A folder with none shows no such entry.
  const top = await ok(reg, "files.drive.list", { share: "work", path: "a" });
  assert.deepEqual(top.entries.map(e => [e.name, e.dir, e.virtual === true]), [["Generated", true, true], ["notes.md", false, false]]);
  assert.deepEqual((await ok(reg, "files.drive.list", { share: "work", path: "b" })).entries.map(e => e.name), ["Generated"]);
  const g = await ok(reg, "files.drive.list", { share: "work", path: "a/Generated" });
  assert.deepEqual(g.entries.map(e => [e.name, e.kind, e.mime, e.size, e.artifact]), [
    ["Clip.mp4", "video", "video/mp4", 4, "art-cccccccc3"],
    ["Harbour- dawn-1 (art-bb).png", "image", "image/png", 3, "art-bbbbbbbb2"],
    ["Harbour- dawn-1.png", "image", "image/png", 18, "art-aaaaaaaa1"]]);
  // Reading goes through artifacts.media.read, in chunks.
  const r1 = await ok(reg, "files.drive.read", { share: "work", path: "a/Generated/Harbour- dawn-1.png", offset: 0, length: 6 });
  assert.deepEqual([Buffer.from(r1.base64, "base64").toString(), r1.size, r1.done, r1.virtual], ["PNGDAT", 18, false, true]);
  const r2 = await ok(reg, "files.drive.read", { share: "work", path: "a/Generated/Harbour- dawn-1.png", offset: 6 });
  assert.deepEqual([Buffer.from(r2.base64, "base64").toString(), r2.done], ["A-0123456789", true]);
  await no(reg, "files.drive.read", { share: "work", path: "a/Generated/nope.png" }, "cli", "not_available");
  await no(reg, "files.drive.list", { share: "work", path: "a/Generated/Clip.mp4" }, "cli", "bad_input");
  // An agent granted project a sees a's media, never b's, and cannot get at b's folder.
  assert.deepEqual((await ok(reg, "files.drive.list", { share: "work", path: "a/Generated" }, "mcp:agent:kit")).entries.length, 3);
  assert.equal(Buffer.from((await ok(reg, "files.drive.read", { share: "work", path: "a/Generated/Clip.mp4" }, "mcp:agent:kit")).base64, "base64").toString(), "MP4!");
  await no(reg, "files.drive.list", { share: "work", path: "b/Generated" }, "mcp:agent:kit", "not_available");
  await no(reg, "files.drive.read", { share: "work", path: "b/Generated/Other project.jpg" }, "mcp:agent:kit", "not_available");
});

test("drive generated: a real Generated folder is shown together with the media, and a folder that is no project's gets no virtual one", async t => {
  const { work } = boxWorld(t);
  const a = path.join(work, "a"), plain = path.join(work, "plain");
  fs.mkdirSync(path.join(a, "Generated"), { recursive: true }); fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(a, "Generated", "mine.png"), "real");
  fs.mkdirSync(path.join(a, "Generated", "sub")); fs.writeFileSync(path.join(a, "Generated", "sub", "inner.txt"), "in"); fs.writeFileSync(path.join(a, "Generated", "notes.txt"), "plain");
  const media = [{ id: "art-eeeeeeee5", kind: "image", format: "png", mime: "image/png", bytes: 2, title: "mine", created_at: "2026-10-01T10:00:00Z", project: "a", bytes_b64: Buffer.from("ai").toString("base64") }];
  const { reg } = await registry(t, { role: "box", media, projects: [{ slug: "a", name: "A", home: a, workspaces: [] }], cfg: { files: { roots: [work], drive: { shares: { projects: null, work } } } } });
  const top = await ok(reg, "files.drive.list", { share: "work", path: "a" });
  assert.deepEqual(top.entries.filter(e => e.name === "Generated").map(e => e.virtual === true), [false], "the real folder is the one listed, not a second");
  const g = await ok(reg, "files.drive.list", { share: "work", path: "a/Generated" });
  assert.deepEqual(g.entries.map(e => [e.name, e.virtual === true]).sort(), [["mine (art-ee).png", true], ["mine.png", false], ["notes.txt", false], ["sub", false]]);
  // A media item whose name is a real file's: the real file keeps its name and the item is shown, and read, with its short id.
  assert.equal(Buffer.from((await ok(reg, "files.drive.read", { share: "work", path: "a/Generated/mine.png" })).base64, "base64").toString(), "real");
  assert.equal(Buffer.from((await ok(reg, "files.drive.read", { share: "work", path: "a/Generated/mine (art-ee).png" })).base64, "base64").toString(), "ai");
  // The project's own real files inside Generated are read and listed as ordinary files.
  assert.equal(Buffer.from((await ok(reg, "files.drive.read", { share: "work", path: "a/Generated/notes.txt" })).base64, "base64").toString(), "plain");
  assert.deepEqual((await ok(reg, "files.drive.list", { share: "work", path: "a/Generated/sub" })).entries.map(e => e.name), ["inner.txt"]);
  assert.deepEqual((await ok(reg, "files.drive.list", { share: "work", path: "plain" })).entries, []);
  await no(reg, "files.drive.list", { share: "work", path: "plain/Generated" }, "cli", "not_available");
});

test("drive: files.drive.status lists each offered share with its access and nothing else", async t => {
  const { work } = boxWorld(t);
  const { reg } = await registry(t, { role: "box",
    cfg: { projectsDir: path.join(work, "projects"), files: { roots: [work], drive: { shares: { site: { path: path.join(work, "glass"), access: "rw" } } } } } });
  const s = await ok(reg, "files.drive.status");
  assert.deepEqual(s.shares.map(x => [x.name, x.access]), [["projects", "ro"], ["site", "rw"]]);
  assert.deepEqual(Object.keys(s).sort(), ["shares", "space"], "shares and the Space's own Drive, and nothing about a network or a mount");
  for (const gone of ["files.drive.share", "files.drive.unshare", "files.drive.access", "files.drive.audit", "files.drive.address", "files.drive.url", "files.drive.mount", "files.drive.unmount", "files.drive.open", "files.drive.local", "files.drive.offer", "files.drive.candidates", "files.drive.measure"]) {
    assert.equal(reg.tools.has(gone), false, `${gone} is not a tool any more`);
  }
});
