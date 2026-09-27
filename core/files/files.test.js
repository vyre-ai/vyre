// @ts-check
// The files module inside a real Registry: search on the box, the safety guard from every
// direction a path can arrive, preview, chunked fetch, and the Mac's federated search and pull
// across a fake link to a second, box-role registry in the same process.

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
import { seams, merge } from "./index.js";
import { guard } from "./safety.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIB = 1024 * 1024;
// The smallest valid PNG: one transparent pixel.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A temp folder, removed after the test. Never the user's own files or ~/.vyre. */
function tmp(t, prefix = "vyre-files-") {
  const dir = fs.mkdtempSync(path.join(SCRATCH, prefix));
  assert.notEqual(path.resolve(dir), path.join(os.homedir(), ".vyre"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

/**
 * A workspace with ordinary files, things that must never be shown, and a VYRE_HOME inside it
 * (under a plain name, so only the deny rule keeps it out). Every forbidden file mentions the
 * search word, so a leak would show up in results.
 */
function workspace(t) {
  const base = tmp(t);
  const work = path.join(base, "work");
  const outside = path.join(base, "outside");
  put(path.join(work, "notes", "budget-plan.md"), "# Plan\nthe quarterly numbers\n");
  put(path.join(work, "src", "app.js"), "// works out the BUDGET for the month\n");
  put(path.join(work, ".github", "budget.yml"), "name: budget\n");
  put(path.join(work, ".env"), "BUDGET_KEY=1\n");
  put(path.join(work, ".env.local"), "BUDGET_KEY=2\n");
  put(path.join(work, ".private", "budget.txt"), "budget\n");
  put(path.join(work, "keys", "id_rsa"), "budget\n");
  put(path.join(work, "keys", "budget.pem"), "budget\n");
  put(path.join(work, "service-account-budget.json"), "{\"budget\":1}\n");
  put(path.join(work, "node_modules", "budget", "index.js"), "budget\n");
  put(path.join(work, "vh", "budget-memo.txt"), "budget\n");
  put(path.join(work, "README"), "plain text with no extension\n");
  put(path.join(outside, "budget-outside.txt"), "budget\n");
  fs.symlinkSync(path.join(outside, "budget-outside.txt"), path.join(work, "budget-link.txt"));
  fs.symlinkSync(path.join(work, "notes", "budget-plan.md"), path.join(outside, "in-link.md"));
  return { base, work, outside, vyreHome: path.join(work, "vh") };
}

/** A content search that sees everything, dot and secret files included, so the guard must filter. */
function fakeRg(args) {
  const q = args[args.indexOf("--") + 1].toLowerCase();
  const roots = args.slice(args.indexOf("--") + 2);
  const out = [];
  const visit = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile() && fs.readFileSync(p, "utf8").toLowerCase().includes(q)) out.push(p);
    }
  };
  roots.forEach(visit);
  return Promise.resolve(out);
}

/**
 * A Registry with the files module (and optionally a fake link) running, the way vyred would
 * start it, but without the rest of vyred.
 */
async function registry(t, { role, files, home, seam = undefined, link = undefined }) {
  const root = home || tmp(t, "vyre-test-");
  const p = config.ensure(root);
  if (seam) { seams.set(root, seam); t.after(() => seams.delete(root)); }
  const found = discover([CORE]).filter(f => f.manifest && f.manifest.name === "files");
  if (link) {
    const mods = tmp(t, "vyre-mods-");
    globalThis.__filesLinks = globalThis.__filesLinks || new Map();
    globalThis.__filesLinks.set(root, link);
    t.after(() => globalThis.__filesLinks.delete(root));
    writeModule(mods, "link", { roles: ["local"], does: { tools: ["link.remote"] } },
      `export default { async start(ctx) {
        ctx.tool("link.remote", { run: async ({ tool, input }) => ({ result: await globalThis.__filesLinks.get(ctx.paths.root)(tool, input) }) });
        return { async stop() {} };
      } };`);
    found.push(...discover([mods]));
  }
  const db = open(p.db);
  const reg = new Registry({ db, events: new Events(db), config: { role, files }, paths: p, log: () => {} });
  await reg.start(found, { role });
  t.after(async () => { await reg.stop(); db.close(); });
  assert.equal(reg.modules.get("files").state, "running", reg.modules.get("files").error);
  return reg;
}

const call = async (reg, tool, input) => {
  const r = await reg.call(tool, input, "cli");
  if (r.error) throw new Error(r.error.message);
  return r.data;
};
const refused = async (reg, tool, input, msg = /not available/) => {
  const r = await reg.call(tool, input, "cli");
  assert.ok(r.error, `${tool} ${JSON.stringify(input)} should have been refused`);
  assert.match(r.error.message, msg);
};

test("files: the manifest loads and offers its four tools to every caller", async t => {
  const { work, vyreHome } = workspace(t);
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome, seam: { rg: fakeRg } });
  // Taildrive's tools (files.drive.*) have their own tests in drive.test.js.
  const names = reg.listTools("mcp").map(x => x.name).filter(n => !n.startsWith("files.drive.")).sort();
  assert.deepEqual(names, ["files.dirs", "files.fetch", "files.preview", "files.recent", "files.search", "files.stat"]);
});

test("files: box search finds by name and by content, and never returns what the guard refuses", async t => {
  const { work, vyreHome } = workspace(t);
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome, seam: { rg: fakeRg } });
  const r = await call(reg, "files.search", { q: "budget", where: "all" });
  const names = r.results.map(x => x.name).sort();
  // budget-plan.md by name, app.js by content, .github is an allowed dot folder.
  assert.deepEqual(names, ["app.js", "budget-plan.md", "budget.yml"]);
  assert.ok(r.results.every(x => x.source === "box"));
  assert.deepEqual(r.sources.map(s => [s.source, s.ok, s.count]), [["box", true, 3]]);
  const app = r.results.find(x => x.name === "app.js");
  assert.equal(app.kind, "code");
  assert.equal(typeof app.size, "number");
  assert.ok(!Number.isNaN(Date.parse(app.mtime)));
  // Kinds filter and limit.
  assert.deepEqual((await call(reg, "files.search", { q: "budget", kinds: ["text"] })).results.map(x => x.name), ["budget-plan.md"]);
  assert.equal((await call(reg, "files.search", { q: "budget", limit: 1 })).results.length, 1);
  // The folder name matches too.
  assert.ok((await call(reg, "files.search", { q: "note" })).results.some(x => x.kind === "folder" && x.name === "notes"));
});

test("files: without ripgrep the box matches names only and says so", async t => {
  const { work, vyreHome } = workspace(t);
  const rg = () => Promise.reject(Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" }));
  const reg = await registry(t, { role: "box", files: { roots: [work, path.join(work, "missing")] }, home: vyreHome, seam: { rg } });
  const r = await call(reg, "files.search", { q: "budget" });
  assert.deepEqual(r.results.map(x => x.name).sort(), ["budget-plan.md", "budget.yml"]);
  assert.match(r.sources[0].note, /ripgrep is not installed/);
  assert.match(r.sources[0].note, /do not exist/);
  assert.equal(r.sources[0].ok, true);
});

test("files: stat, preview and fetch refuse secrets, dotfiles, Vyre's home, symlinks out, traversal and relative paths", async t => {
  const { work, outside, vyreHome } = workspace(t);
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome, seam: { rg: fakeRg } });
  const bad = [
    path.join(work, ".env"), path.join(work, ".env.local"), path.join(work, ".private", "budget.txt"),
    path.join(work, "keys", "id_rsa"), path.join(work, "keys", "budget.pem"), path.join(work, "service-account-budget.json"),
    path.join(vyreHome, "budget-memo.txt"), path.join(vyreHome, "vyre.db"), vyreHome,
    path.join(work, "budget-link.txt"), // inside the root, pointing outside
    path.join(outside, "in-link.md"), // outside the root, pointing in
    path.join(outside, "budget-outside.txt"),
    work + "/notes/../../outside/budget-outside.txt",
    work + "/notes/../notes/budget-plan.md",
    path.join(work, "notes", "missing.md"),
    path.join(work, "notes", "budget-plan.md\0.txt"),
    "/etc/hosts",
  ];
  for (const p of bad) {
    await refused(reg, "files.stat", { path: p });
    await refused(reg, "files.preview", { path: p });
    await refused(reg, "files.fetch", { path: p });
  }
  await refused(reg, "files.stat", { path: "notes/budget-plan.md" }, /must be absolute/);
  await refused(reg, "files.fetch", { path: "./notes/budget-plan.md" }, /must be absolute/);
  // The error says the same thing for a refused real file and for nothing at all.
  const a = await reg.call("files.stat", { path: path.join(work, ".env") }, "cli");
  const b = await reg.call("files.stat", { path: path.join(work, "nothing-here") }, "cli");
  assert.equal(a.error.message, b.error.message);
  // The allowed ones work.
  const st = await call(reg, "files.stat", { path: path.join(work, ".github", "budget.yml") });
  assert.equal(st.dir, false);
  assert.equal(st.source, "box");
  assert.equal((await call(reg, "files.stat", { path: work })).dir, true);
  await refused(reg, "files.stat", { path: path.join(work, "notes", "budget-plan.md"), source: "mac" }, /cannot reach files on the Mac/);
});

test("files: allowDot opens a dot name, but never .env", async t => {
  const { work, vyreHome } = workspace(t);
  put(path.join(work, ".storybook", "main.js"), "x\n");
  const reg = await registry(t, { role: "box", files: { roots: [work], allowDot: [".storybook", ".env", ".private"] }, home: vyreHome });
  assert.equal((await call(reg, "files.stat", { path: path.join(work, ".storybook", "main.js") })).kind, "code");
  assert.equal((await call(reg, "files.stat", { path: path.join(work, ".private", "budget.txt") })).kind, "text");
  await refused(reg, "files.stat", { path: path.join(work, ".env") });
  await refused(reg, "files.stat", { path: path.join(work, ".env.local") });
});

test("files: the deny list holds even when a root is inside it", () => {
  const base = fs.mkdtempSync(path.join(SCRATCH, "vyre-files-"));
  try {
    const home = path.join(base, "home");
    for (const f of [".ssh/config", ".config/gcloud/creds", ".aws/config", ".claude/settings.json", "Library/Keychains/login.db", "work/ok.txt"]) put(path.join(home, f), "x");
    const g = guard({ roots: [path.join(home, ".ssh"), path.join(home, ".config"), path.join(home, ".aws"), path.join(home, ".claude"), path.join(home, "Library"), path.join(home, "work")],
      home, vyreHome: path.join(base, "vyre") });
    assert.equal(g.allowed(path.join(home, "work", "ok.txt")), true);
    for (const f of [".ssh/config", ".config/gcloud/creds", ".aws/config", ".claude/settings.json", "Library/Keychains/login.db"]) {
      assert.equal(g.allowed(path.join(home, f)), false, f);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("files: preview shows the head of text, truncates, clamps, and turns away binary", async t => {
  const { work, vyreHome } = workspace(t);
  put(path.join(work, "long.txt"), "a".repeat(100 * 1024));
  put(path.join(work, "huge.txt"), "b".repeat(300 * 1024));
  put(path.join(work, "fake.txt"), Buffer.from([0x68, 0x69, 0x00, 0x01]));
  put(path.join(work, "report.pdf"), "%PDF-1.4");
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome });
  const p = await call(reg, "files.preview", { path: path.join(work, "long.txt") });
  assert.deepEqual([p.kind, p.text.length, p.truncated, p.size, p.source], ["text", 64 * 1024, true, 100 * 1024, "box"]);
  const s = await call(reg, "files.preview", { path: path.join(work, "long.txt"), max: 10 });
  assert.equal(s.text, "a".repeat(10));
  assert.equal((await call(reg, "files.preview", { path: path.join(work, "huge.txt"), max: 10 ** 9 })).text.length, 256 * 1024);
  const full = await call(reg, "files.preview", { path: path.join(work, "src", "app.js") });
  assert.deepEqual([full.kind, full.truncated, full.mime], ["code", false, "text/javascript"]);
  assert.match(full.text, /BUDGET/);
  const readme = await call(reg, "files.preview", { path: path.join(work, "README") });
  assert.equal(readme.kind, "text");
  const bin = await call(reg, "files.preview", { path: path.join(work, "fake.txt") });
  assert.deepEqual([bin.kind, bin.preview, bin.text], ["other", null, undefined]);
  const pdf = await call(reg, "files.preview", { path: path.join(work, "report.pdf") });
  assert.deepEqual([pdf.kind, pdf.preview], ["pdf", null]);
});

test("files: image preview gives a picture, and says so when one is too large", async t => {
  const { work, vyreHome } = workspace(t);
  put(path.join(work, "dot.png"), Buffer.from(PIXEL, "base64"));
  put(path.join(work, "photo.jpg"), Buffer.alloc(600 * 1024, 7));
  // The real thumbnailer (sips or ImageMagick) where there is one; the small original otherwise.
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome });
  const img = await call(reg, "files.preview", { path: path.join(work, "dot.png") });
  assert.equal(img.kind, "image");
  assert.ok(img.base64 && img.base64.length > 0);
  // With no thumbnailer, a large image is not sent whole.
  const home2 = path.join(work, "vh2");
  const reg2 = await registry(t, { role: "box", files: { roots: [work] }, home: home2, seam: { thumbnail: async () => null } });
  const big = await call(reg2, "files.preview", { path: path.join(work, "photo.jpg") });
  assert.deepEqual([big.kind, big.base64, big.note], ["image", null, "too large to preview"]);
  const small = await call(reg2, "files.preview", { path: path.join(work, "dot.png") });
  assert.deepEqual([small.base64, small.thumbnail], [PIXEL, false]);
});

test("files: fetch on the holder returns 1 MiB chunks with a done flag", async t => {
  const { work, vyreHome } = workspace(t);
  const data = Buffer.alloc(2.5 * MIB);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  put(path.join(work, "big.bin"), data);
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome });
  const file = path.join(work, "big.bin");
  const parts = [];
  let offset = 0;
  for (;;) {
    const c = await call(reg, "files.fetch", { path: file, offset });
    parts.push(c);
    offset += c.length;
    if (c.done) break;
  }
  assert.deepEqual(parts.map(c => [c.offset, c.length, c.done]), [[0, MIB, false], [MIB, MIB, false], [2 * MIB, MIB / 2, true]]);
  assert.ok(parts.every(c => c.size === data.length && c.mtime === parts[0].mtime && c.source === "box"));
  assert.ok(Buffer.concat(parts.map(c => Buffer.from(c.base64, "base64"))).equals(data));
  // The length is capped at 1 MiB, and a smaller one is honoured.
  assert.equal((await call(reg, "files.fetch", { path: file, length: 10 * MIB })).length, MIB);
  assert.equal((await call(reg, "files.fetch", { path: file, offset: 5, length: 3 })).base64, data.subarray(5, 8).toString("base64"));
  await refused(reg, "files.fetch", { path: file, offset: 3 * MIB }, /past the end/);
  await refused(reg, "files.fetch", { path: path.join(work, "notes") }, /folder cannot be fetched/);
});

test("merge: interleaves the two machines and stops at the limit", () => {
  assert.deepEqual(merge([1, 2, 3], ["a"], 10), [1, "a", 2, 3]);
  assert.deepEqual(merge([1, 2, 3], ["a", "b", "c"], 4), [1, "a", 2, "b"]);
  assert.deepEqual(merge([], ["a", "b"], 5), ["a", "b"]);
  assert.deepEqual(merge([1], [], 0), []);
});

/** A Mac folder, a box workspace, and a box registry the Mac's fake link talks to. */
async function pair(t, { macFiles = {}, link = undefined, seam = {} } = {}) {
  const ws = workspace(t);
  const box = await registry(t, { role: "box", files: { roots: [ws.work] }, home: ws.vyreHome, seam: { rg: fakeRg } });
  const mac = path.join(ws.base, "mac");
  put(path.join(mac, "budget-mac.txt"), "budget on the mac\n");
  put(path.join(mac, "other-budget.md"), "budget\n");
  put(path.join(mac, ".env"), "BUDGET=1\n");
  // Spotlight would find these; some must be filtered: a dotfile, a path outside the roots, one that does not exist.
  const mdfind = async args => {
    assert.equal(args[0], "-onlyin");
    return [path.join(mac, "budget-mac.txt"), path.join(mac, ".env"), path.join(ws.outside, "budget-outside.txt"), path.join(mac, "gone.txt"), path.join(mac, "other-budget.md")];
  };
  const forward = link || ((tool, input) => box.call(tool, input, "module:link"));
  const local = await registry(t, { role: "local", files: { roots: [mac], ...macFiles }, seam: { platform: "darwin", mdfind, ...seam }, link: forward });
  return { ...ws, mac, box, local };
}

test("files: the Mac's search covers both machines, interleaved and tagged", async t => {
  const { local } = await pair(t);
  const r = await call(local, "files.search", { q: "budget" });
  assert.deepEqual(r.results.map(x => [x.source, x.name]), [
    ["mac", "budget-mac.txt"], ["box", r.results[1].name], ["mac", "other-budget.md"], ["box", r.results[3].name], ["box", r.results[4].name]]);
  assert.deepEqual(r.results.filter(x => x.source === "box").map(x => x.name).sort(), ["app.js", "budget-plan.md", "budget.yml"]);
  assert.deepEqual(r.sources.map(s => [s.source, s.ok, s.count]), [["mac", true, 2], ["box", true, 3]]);
  const here = await call(local, "files.search", { q: "budget", where: "here" });
  assert.deepEqual(here.sources.map(s => s.source), ["mac"]);
  assert.ok(here.results.every(x => x.source === "mac"));
  const box = await call(local, "files.search", { q: "budget", where: "box", limit: 2 });
  assert.deepEqual(box.sources.map(s => s.source), ["box"]);
  assert.equal(box.results.length, 2);
  assert.ok(box.results.every(x => x.source === "box"));
});

test("files: with no link, the Mac's search gives its own results and marks the box down", async t => {
  const base = tmp(t);
  const mac = path.join(base, "mac");
  put(path.join(mac, "budget.txt"), "x");
  const mdfind = async () => [path.join(mac, "budget.txt")];
  const local = await registry(t, { role: "local", files: { roots: [mac] }, seam: { platform: "darwin", mdfind } });
  const r = await call(local, "files.search", { q: "budget" });
  assert.deepEqual(r.results.map(x => [x.source, x.name]), [["mac", "budget.txt"]]);
  assert.deepEqual(r.sources[1], { source: "box", ok: false, count: 0, error: "no_link" });
  await refused(local, "files.stat", { path: "/work/x", source: "box" }, /not reachable \(no_link\)/);
});

test("files: a slow box does not hold up the Mac's results", async t => {
  const slow = () => new Promise(resolve => setTimeout(() => resolve({ data: { results: [], sources: [] } }), 2000));
  const { local } = await pair(t, { link: slow, seam: { remoteTimeout: 100 } });
  const t0 = Date.now();
  const r = await call(local, "files.search", { q: "budget" });
  assert.ok(Date.now() - t0 < 1500, "waited for the box");
  assert.equal(r.results.length, 2);
  assert.deepEqual(r.sources[1], { source: "box", ok: false, count: 0, error: "timeout" });
});

test("files: the Mac forwards stat and preview to the box and refuses what the box refuses", async t => {
  const { local, work } = await pair(t);
  const st = await call(local, "files.stat", { path: path.join(work, "src", "app.js"), source: "box" });
  assert.deepEqual([st.source, st.name, st.kind, st.dir], ["box", "app.js", "code", false]);
  const pv = await call(local, "files.preview", { path: path.join(work, "src", "app.js"), source: "box", max: 5 });
  assert.deepEqual([pv.source, pv.text, pv.truncated], ["box", "// wo", true]);
  await refused(local, "files.stat", { path: path.join(work, ".env"), source: "box" });
  await refused(local, "files.preview", { path: path.join(work, "keys", "id_rsa"), source: "box" });
});

test("files: the Mac pulls a file from the box in chunks into VYRE_HOME", async t => {
  const { local, work } = await pair(t);
  const data = Buffer.alloc(2.5 * MIB);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256;
  const file = path.join(work, "big.bin");
  put(file, data);
  const r = await call(local, "files.fetch", { path: file, source: "box" });
  assert.equal(r.source, "box");
  assert.equal(r.size, data.length);
  assert.ok(fs.readFileSync(r.local).equals(data));
  const root = local.deps.paths.root;
  assert.ok(r.local.startsWith(path.join(root, "files", "fetched") + path.sep));
  assert.equal(path.basename(r.local), "big.bin");
  assert.equal(fs.statSync(r.local).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(r.local)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(r.local)), ["big.bin"], "the .part file was left behind");
  await refused(local, "files.fetch", { path: path.join(work, ".env"), source: "box" });
  await refused(local, "files.fetch", { path: path.join(work, "notes", "budget-plan.md"), source: "mac" }, /already on this Mac/);
});

test("files: a pull stops when the file changes underneath it, or is over the limit", async t => {
  let calls = 0;
  /** @type {any} */
  let box = null;
  const changing = async (tool, input) => {
    const r = await box.call(tool, input, "module:link");
    if (++calls === 1) { fs.appendFileSync(input.path, "more"); fs.utimesSync(input.path, new Date(), new Date(Date.now() + 5000)); }
    return r;
  };
  const p = await pair(t, { link: (tool, input) => changing(tool, input) });
  box = p.box;
  const file = path.join(p.work, "grow.bin");
  put(file, Buffer.alloc(2 * MIB, 1));
  await refused(p.local, "files.fetch", { path: file, source: "box" }, /changed while fetching/);
  const dir = path.join(p.local.deps.paths.root, "files", "fetched");
  const left = fs.readdirSync(dir).flatMap(d => fs.readdirSync(path.join(dir, d)));
  assert.deepEqual(left, [], "a failed pull left a file behind");

  const q = await pair(t, { macFiles: { maxFetch: 1000 } });
  assert.equal((await call(q.local, "files.fetch", { path: path.join(q.work, "notes", "budget-plan.md"), source: "box" })).size, Buffer.byteLength("# Plan\nthe quarterly numbers\n"));
  const big = path.join(q.work, "big.txt");
  put(big, "x".repeat(2000));
  await refused(q.local, "files.fetch", { path: big, source: "box" }, /more than the 1000 byte limit/);
});

test("files: a Keynote package named *.key is reachable; key files are refused by name or by content", async t => {
  const { work, vyreHome } = workspace(t);
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome, seam: { rg: fakeRg } });
  // Keynote saves a document as a folder named *.key.
  put(path.join(work, "talks", "Budget.key", "Index.zip"), "zip");
  put(path.join(work, "talks", "Budget.key", "preview.jpg"), "jpg");
  const pkg = await reg.call("files.stat", { path: path.join(work, "talks", "Budget.key") });
  assert.equal(pkg.data.dir, true);
  assert.ok(!(await reg.call("files.stat", { path: path.join(work, "talks", "Budget.key", "Index.zip") })).error);
  // A private key is a key whatever it is called.
  put(path.join(work, "notes", "server.key"), "budget\n");
  // Put together at run time, so the source itself never looks like it carries a key.
  const pk = kind => `-----BEGIN ${kind} ${"PRIVATE"} KEY-----`;
  put(path.join(work, "notes", "budget-deploy.txt"), `${pk("OPENSSH")}\nnot a real key\n`);
  put(path.join(work, "notes", "budget-tls"), `${pk("EC")}\nnot a real key\n`);
  for (const p of ["server.key", "budget-deploy.txt", "budget-tls"]) {
    await refused(reg, "files.stat", { path: path.join(work, "notes", p) });
    await refused(reg, "files.preview", { path: path.join(work, "notes", p) });
    await refused(reg, "files.fetch", { path: path.join(work, "notes", p) });
  }
  const found = (await reg.call("files.search", { q: "budget" })).data.results.map(r => r.name);
  assert.ok(found.includes("Budget.key"));
  assert.ok(!found.some(n => ["server.key", "budget-deploy.txt", "budget-tls"].includes(n)), found.join());
});

test("files: a browser's cookies and saved logins, and a secrets folder, are never served", async t => {
  const { work, vyreHome } = workspace(t);
  const reg = await registry(t, { role: "box", files: { roots: [work] }, home: vyreHome, seam: { rg: fakeRg } });
  const profile = path.join(work, "chrome", "Default");
  for (const f of ["Cookies", "Login Data", "Web Data", "Bookmarks"]) put(path.join(profile, f), "budget\n");
  put(path.join(work, "secrets", "budget.txt"), "budget\n");
  for (const f of [path.join(profile, "Cookies"), path.join(profile, "Login Data"), path.join(profile, "Web Data"), path.join(work, "secrets", "budget.txt")]) {
    await refused(reg, "files.stat", { path: f });
    await refused(reg, "files.fetch", { path: f });
  }
  assert.ok(!(await reg.call("files.stat", { path: path.join(profile, "Bookmarks") })).error);
  const found = (await reg.call("files.search", { q: "budget" })).data.results.map(r => r.path);
  assert.ok(!found.some(p => /Cookies|Login Data|Web Data|secrets/.test(p)), found.join());
});
