// @ts-check
// files.dirs and files.recent inside a real Registry, with fake projects, recall and threads
// modules: listing, refusals, hidden folders, symlinks out, a bounded name search, recent
// folders filtered through the guard, and the Mac forwarding both to the box.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { writeModule } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { LIMITS } from "./dirs.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmp(t, prefix = "vyre-dirs-") {
  const dir = fs.mkdtempSync(path.join(SCRATCH, prefix));
  assert.notEqual(path.resolve(dir), path.join(os.homedir(), ".vyre"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const mkdir = p => fs.mkdirSync(p, { recursive: true });
const put = (file, body = "x") => { mkdir(path.dirname(file)); fs.writeFileSync(file, body); };

/** A box workspace: ordinary folders, a git repo, a project home, and folders that must never show. */
function workspace(t) {
  const base = tmp(t);
  const work = path.join(base, "work");
  const outside = path.join(base, "outside");
  mkdir(path.join(work, "harlow-legal", ".git"));
  put(path.join(work, "harlow-legal", "README.md"));
  mkdir(path.join(work, "northwind-bakery", "site", "src"));
  mkdir(path.join(work, "Archive"));
  mkdir(path.join(work, ".hidden-bakery"));
  mkdir(path.join(work, ".github"));
  mkdir(path.join(work, "secrets"));
  mkdir(path.join(work, "node_modules", "bakery"));
  mkdir(path.join(work, "vh"));
  put(path.join(work, "notes.md"));
  mkdir(path.join(outside, "bakery-outside"));
  fs.symlinkSync(path.join(outside, "bakery-outside"), path.join(work, "bakery-link"));
  return { base, work, outside, vyreHome: path.join(work, "vh") };
}

/**
 * The files module, plus a fake module standing in for projects, recall and the switchboard, and
 * optionally a fake link to another registry.
 */
async function registry(t, { role, files, home, fakes = {}, link = undefined, vault = undefined }) {
  const root = home || tmp(t, "vyre-test-");
  const p = { ...config.ensure(root), ...(vault ? { vault } : {}) };
  const found = discover([CORE]).filter(f => f.manifest && f.manifest.name === "files");
  const mods = tmp(t, "vyre-mods-");
  const key = `${root}`;
  globalThis.__dirsFakes = globalThis.__dirsFakes || new Map();
  globalThis.__dirsFakes.set(key, { ...fakes, link });
  t.after(() => globalThis.__dirsFakes.delete(key));
  const fake = (name, tool, body) => writeModule(mods, name, { roles: ["box", "local"], does: { tools: [tool] } },
    `export default { async start(ctx) {
      const f = () => globalThis.__dirsFakes.get(ctx.paths.root);
      ctx.tool("${tool}", { run: async ({ ...i }) => { ${body} } });
      return { async stop() {} };
    } };`);
  fake("projects", "projects.list", "return { projects: f().projects || [], problems: [] };");
  fake("recall", "recall.sessions", "f().recallInput = i; return f().sessions || [];");
  fake("threads", "threads.list", "f().threadsInput = i; return f().threads || [];");
  fake("link", "link.remote", `if (!f().link) throw Object.assign(new Error("no link"), { code: "no_link" });
        return { result: await f().link(i.tool, i.input) };`);
  // The fakes stand in for Vyre's own projects, recall, threads and link, so they load as first
  // party (ADR 0047: an added module reaches only tools with a declared reach).
  found.push(...discover([mods], { firstPartyRoots: [mods] }));
  const db = open(p.db);
  const reg = new Registry({ db, events: new Events(db), config: { role, files }, paths: p, log: () => {}, firstPartyRoots: [mods] });
  await reg.start(found, { role });
  t.after(async () => { await reg.stop(); db.close(); });
  assert.equal(reg.modules.get("files").state, "running", reg.modules.get("files").error);
  return reg;
}

const call = async (reg, tool, input) => {
  const r = await reg.call(tool, input, "deck");
  if (r.error) throw new Error(r.error.message);
  return r.data;
};
const refused = async (reg, tool, input, msg = /not available/) => {
  const r = await reg.call(tool, input, "deck");
  assert.ok(r.error, `${tool} ${JSON.stringify(input)} should have been refused`);
  assert.match(r.error.message, msg);
};

test("files.dirs: lists the folders inside the roots, sorted, with git and project badges", async t => {
  const { work, vyreHome } = workspace(t);
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome,
    fakes: { projects: [{ slug: "northwind", name: "Northwind Bakery", home: path.join(work, "northwind-bakery"), workspaces: [] }] } });
  const r = await call(reg, "files.dirs", {});
  assert.equal(r.path, null);
  assert.equal(r.parent, null);
  assert.deepEqual(r.roots, [{ path: work, name: "work" }]);
  // No dot folders (not even .github), no secrets folder, no node_modules, no Vyre home, no link out.
  assert.deepEqual(r.dirs.map(d => d.name), ["Archive", "harlow-legal", "northwind-bakery"]);
  const harlow = r.dirs.find(d => d.name === "harlow-legal");
  assert.equal(harlow.git, true);
  assert.equal(harlow.path, path.join(work, "harlow-legal"));
  assert.match(harlow.mtime, /^\d{4}-\d\d-\d\dT/);
  assert.equal(harlow.project, undefined);
  const nw = r.dirs.find(d => d.name === "northwind-bakery");
  assert.deepEqual([nw.git, nw.project], [false, "northwind"]);
});

test("files.dirs: drills into a folder, with its parent inside the root and none at the root", async t => {
  const { work, vyreHome } = workspace(t);
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome });
  const r = await call(reg, "files.dirs", { path: path.join(work, "northwind-bakery") });
  assert.equal(r.path, path.join(work, "northwind-bakery"));
  assert.equal(r.parent, work);
  assert.deepEqual(r.dirs.map(d => d.name), ["site"]);
  const deeper = await call(reg, "files.dirs", { path: path.join(work, "northwind-bakery", "site") });
  assert.equal(deeper.parent, path.join(work, "northwind-bakery"));
  const top = await call(reg, "files.dirs", { path: work });
  assert.equal(top.parent, null);
  await refused(reg, "files.dirs", { path: path.join(work, "notes.md") }, /not a folder/);
});

test("files.dirs: refuses outside the roots, the vault, Vyre's home, dot and secret folders, and a symlink out", async t => {
  const { work, outside, vyreHome, base } = workspace(t);
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome });
  for (const p of [outside, base, "/", "/etc", path.join(work, ".hidden-bakery"), path.join(work, ".github"), path.join(work, "secrets"),
    vyreHome, path.join(work, "bakery-link"), path.join(work, "..", "outside")]) {
    await refused(reg, "files.dirs", { path: p });
  }
  await refused(reg, "files.dirs", { path: "work" }, /absolute/);
  await refused(reg, "files.dirs", { path: path.join(os.homedir(), ".ssh") });
  const r = await call(reg, "files.dirs", {});
  assert.ok(!r.dirs.some(d => d.path.startsWith(outside)));
});

test("files.dirs: the vault is never listed or searched, even inside a root", async t => {
  const { work, vyreHome } = workspace(t);
  const vault = path.join(work, "kit-vault");
  mkdir(path.join(vault, "kit-inner"));
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome, vault });
  const r = await call(reg, "files.dirs", {});
  assert.ok(!r.dirs.some(d => d.path.startsWith(vault)), r.dirs.map(d => d.path).join());
  assert.deepEqual((await call(reg, "files.dirs", { q: "kit" })).dirs, []);
  await refused(reg, "files.dirs", { path: vault });
  await refused(reg, "files.dirs", { path: path.join(vault, "kit-inner") });
});

test("files.dirs: q finds folders by name under the roots, never hidden ones or ones through a link", async t => {
  const { work, vyreHome } = workspace(t);
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome });
  const r = await call(reg, "files.dirs", { q: "BAKERY" });
  assert.deepEqual(r.dirs.map(d => d.name), ["northwind-bakery"]);
  const src = await call(reg, "files.dirs", { q: "src" });
  assert.deepEqual(src.dirs.map(d => d.path), [path.join(work, "northwind-bakery", "site", "src")]);
  const under = await call(reg, "files.dirs", { q: "s", path: path.join(work, "northwind-bakery") });
  assert.deepEqual(under.dirs.map(d => d.name), ["site", "src"]);
});

test("files.dirs: the q walk is bounded by depth, entries and results", async t => {
  const base = tmp(t);
  const work = path.join(base, "work");
  // Deeper than the depth limit: a match at depth 5 is not found, one at depth 4 is.
  mkdir(path.join(work, "a", "b", "c", "match-four", "match-five"));
  const reg = await registry(t, { role: "box", files: { roots: [work] } });
  const deep = await call(reg, "files.dirs", { q: "match" });
  assert.deepEqual(deep.dirs.map(d => d.name), ["match-four"]);
  assert.equal(LIMITS.depth, 4);
  // More matches than the result cap.
  for (let i = 0; i < 260; i++) mkdir(path.join(work, "many", `kit-${i}`));
  const many = await call(reg, "files.dirs", { q: "kit" });
  assert.equal(many.dirs.length, 200);
  assert.equal((await call(reg, "files.dirs", { q: "kit", limit: 5 })).dirs.length, 5);
  // More entries than the walk may read: a match past 2,000 entries is not reached.
  const wide = path.join(base, "wide");
  for (let i = 0; i < 2100; i++) mkdir(path.join(wide, "a" + String(i).padStart(5, "0")));
  mkdir(path.join(wide, "zz", "juno-late"));
  const reg2 = await registry(t, { role: "box", files: { roots: [wide] } });
  const late = await call(reg2, "files.dirs", { q: "juno" });
  assert.deepEqual(late.dirs, []);
});

test("files.recent: session and thread folders, newest first, counted, through the guard", async t => {
  const { work, outside, vyreHome } = workspace(t);
  const harlow = path.join(work, "harlow-legal"), nw = path.join(work, "northwind-bakery");
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome, fakes: {
    sessions: [
      { id: "s1", cwd: harlow, ended: 1000 },
      { id: "s2", cwd: harlow, ended: 3000 },
      { id: "s3", cwd: nw, ended: 2000 },
      { id: "s4", cwd: path.join(outside, "bakery-outside"), ended: 9000 },
      { id: "s5", cwd: path.join(work, ".hidden-bakery"), ended: 9000 },
      { id: "s6", cwd: path.join(work, "gone"), ended: 9000 },
      { id: "s7", cwd: vyreHome, ended: 9000 },
      { id: "s8", cwd: path.join(work, "bakery-link"), ended: 9000 },
      { id: "s9", cwd: null, ended: 9000 },
    ],
    threads: [{ id: "s3", cwd: nw, last: 5000 }, { id: "t1", cwd: nw, last: 4000 }],
  } });
  const r = await call(reg, "files.recent", {});
  assert.deepEqual(r, [{ path: nw, last: 5000, sessions: 2 }, { path: harlow, last: 3000, sessions: 2 }]);
  assert.equal((await call(reg, "files.recent", { limit: 1 })).length, 1);
});

test("files: the Mac forwards dirs and recent to the box", async t => {
  const { work, vyreHome } = workspace(t);
  const box = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome,
    fakes: { sessions: [{ id: "s1", cwd: path.join(work, "harlow-legal"), ended: 10 }] } });
  const mac = path.join(work, "..", "mac");
  mkdir(path.join(mac, "alex-notes"));
  const local = await registry(t, { role: "local", files: { roots: [mac] }, link: (tool, input) => box.call(tool, input, "module:link") });
  const here = await call(local, "files.dirs", {});
  assert.deepEqual(here.dirs.map(d => d.name), ["alex-notes"]);
  const there = await call(local, "files.dirs", { source: "box" });
  assert.equal(there.source, "box");
  assert.deepEqual(there.dirs.map(d => d.name), ["Archive", "harlow-legal", "northwind-bakery"]);
  assert.deepEqual((await call(local, "files.dirs", { source: "box", q: "bakery" })).dirs.map(d => d.name), ["northwind-bakery"]);
  assert.deepEqual(await call(local, "files.recent", { source: "box" }), [{ path: path.join(work, "harlow-legal"), last: 10, sessions: 1 }]);
  await refused(local, "files.dirs", { source: "box", path: path.join(work, ".github") });
  await refused(box, "files.dirs", { source: "mac" }, /cannot reach/);
});
