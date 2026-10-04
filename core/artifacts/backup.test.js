// AR8: artifacts, their versions, tags and files go out in `vyre backup`, come back on restore, and go
// with the data on an uninstall. One round trip through the real backup and restore, then a fresh
// registry on the restored home reads everything the old one held.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { backup, restore, INCLUDE, DATA_PARTS, checkEntries } from "../names/backup.js";
import { uninstallPlan } from "../names/system.js";
import { SCRATCH } from "../../test/scratch.mjs";

const PASSPHRASE = "correct horse battery staple";
const FAST = { sealParams: { N: 1024, r: 8, p: 1 }, chunk: 4096 };
const dead = () => false;

const THREADS = `
  const T = { t1: { project: "harlow-legal", agent: "juno", provider: "codex" } };
  export default { async start(ctx) { ctx.tool("threads.get", { run: async ({ thread }) => ({ thread: { id: thread, ...(T[thread] || { project: null }) } }) }); return {}; } };`;
const AGENTS = `export default { async start(ctx) { ctx.tool("agents.list", { run: async () => [{ name: "juno", kind: "agent" }] }); return {}; } };`;

/** A registry with the artifacts module on `home`, stopped by the caller. */
async function bootOn(home) {
  const root = path.join(home, "mods");
  writeModule(root, "threads", { does: { tools: [{ name: "threads.get", reach: "modules" }] } }, THREADS);
  writeModule(root, "agents", { does: { tools: [{ name: "agents.list", reach: "modules" }] } }, AGENTS);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "box" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(import.meta.dirname, "..")]).filter(f => f.manifest?.name === "artifacts");
  await reg.start([...core, ...discover([root])], { role: "box" });
  const call = (tool, input, caller = "deck", meta = {}) => reg.call(tool, input, caller, meta);
  const ok = async (tool, input, caller, meta) => { const r = await call(tool, input, caller, meta); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const asVyre = (tool, input, who = "sessions") => reg.tools.get(tool).run(input, { caller: `module:${who}`, firstParty: true });
  const close = async () => { await reg.stop?.(); db.close(); };
  return { reg, call, ok, asVyre, close };
}

test("AR8: artifacts, versions, tags and files survive backup and restore, and the share server's own state does not", async t => {
  const a = tempHome(t), b = tempHome(t, "restored");
  const old = await bootOn(a);
  const report = await old.ok("artifacts.create", { project: "harlow-legal", kind: "report", title: "Intake report", content: "# Intake report\n\nNew matters: 41." });
  await old.ok("artifacts.update", { id: report.id, content: "# Intake report\n\nNew matters: 46.", message: "fix the count" });
  await old.ok("artifacts.update", { id: report.id, content: "# Intake report\n\nNew matters: 52." });
  const dash = await old.ok("artifacts.create", { project: "other", kind: "dashboard", title: "Referrals", content: JSON.stringify({ type: "line", x: "m", series: ["v"] }), data: [{ m: "a", v: 1 }, { m: "b", v: 3 }] });
  const deck = await old.ok("artifacts.create", { kind: "deck", title: "Review", content: `# Q3\n\n---\n\n![logo](data:image/png;base64,iVBORw0KGgo=)` });
  const gone = await old.ok("artifacts.create", { project: "other", kind: "doc", title: "Scratch", content: "# Scratch\n\nx" });
  await old.ok("artifacts.delete", { id: gone.id });
  const parked = await old.ok("artifacts.create", { project: "other", kind: "doc", title: "Parked", content: "# Parked\n\ny" });
  await old.ok("artifacts.archive", { id: parked.id, archived: true });
  // A # tag: thread t1 (harlow-legal) may read the dashboard in another project.
  await old.asVyre("artifacts.mention.resolve", { id: dash.id, thread: "t1" });
  assert.equal((await old.call("artifacts.get", { id: dash.id }, "mcp:agent:juno", { thread: "t1" })).error, undefined);
  // The share server's state file belongs to a running process, not to the person.
  fs.mkdirSync(path.join(a, "data", "other-module"), { recursive: true });
  fs.writeFileSync(path.join(a, "data", "other-module", "x.txt"), "not carried");
  fs.mkdirSync(path.join(b, "data", "other-module"), { recursive: true });
  fs.writeFileSync(path.join(b, "data", "other-module", "kept.txt"), "left alone on restore");
  const pub = path.join(a, "data", "artifacts", "public");
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, ".server.json"), JSON.stringify({ pid: 4242, uid: 1, port: 7311 }));
  // A generated image rides along: its bytes, its hash and its provenance.
  const capDir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "bk-")));
  t.after(() => fs.rmSync(capDir, { recursive: true, force: true }));
  await old.asVyre("artifacts.capture.register", { thread: "t1", dir: capDir });
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("image body ".repeat(500))]);
  fs.writeFileSync(path.join(capDir, "harbour.png"), PNG);
  const img = await old.asVyre("artifacts.media.register", { thread: "t1", name: "harbour.png", provider: "grok", model: "grok-imagine", prompt: "a harbour at dusk" });
  const before = {
    list: (await old.ok("artifacts.list", { archived: false })).map(x => x.id).sort(),
    versions: (await old.ok("artifacts.versions", { id: report.id })).map(v => v.version),
  };
  await old.close();

  const file = path.join(a, "box.vyre");
  const r = await backup({ root: a, file, passphrase: PASSPHRASE, ...FAST });
  assert.ok(r.included.includes("data"), "the data folder is in the backup: " + r.included.join(","));
  assert.ok(INCLUDE.includes("data"));
  await restore({ root: b, file, passphrase: PASSPHRASE, alive: dead });

  assert.ok(fs.existsSync(path.join(b, "data", "artifacts", "store", "harlow-legal", report.id, ".git")), "its own git history came back");
  assert.ok(!fs.existsSync(path.join(b, "data", "artifacts", "public", ".server.json")), "the share server's pid and port stay behind");
  assert.ok(!fs.existsSync(path.join(b, "data", "other-module", "x.txt")), "a module's data not named in the backup is not carried");
  assert.equal(fs.readFileSync(path.join(b, "data", "other-module", "kept.txt"), "utf8"), "left alone on restore", "and a restore leaves it alone");

  const nu = await bootOn(b);
  t.after(() => nu.close());
  assert.deepEqual((await nu.ok("artifacts.list", { archived: false })).map(x => x.id).sort(), before.list);
  assert.deepEqual((await nu.ok("artifacts.versions", { id: report.id })).map(v => v.version), before.versions);
  assert.equal((await nu.ok("artifacts.get", { id: report.id })).files["index.md"], "# Intake report\n\nNew matters: 52.");
  assert.equal((await nu.ok("artifacts.get", { id: report.id, version: 1 })).files["index.md"], "# Intake report\n\nNew matters: 41.");
  const d = await nu.ok("artifacts.diff", { id: report.id, from: 1, to: 2 });
  assert.match(d.diff, /^\+New matters: 46\.$/m, "the diff works across the restore");
  const gd = await nu.ok("artifacts.get", { id: dash.id });
  const gi = await nu.ok("artifacts.get", { id: img.id });
  assert.deepEqual([gi.media.provider, gi.media.model, gi.media.prompt, gi.media.sha256], ["grok", "grok-imagine", "a harbour at dusk", img.media.sha256], "a generated image's provenance came back");
  const chunk = await nu.asVyre("artifacts.media.read", { id: img.id, offset: 0 });
  assert.ok(Buffer.from(chunk.bytes_b64, "base64").equals(PNG), "and its bytes");
  assert.deepEqual(JSON.parse(gd.files["data.json"]), [{ m: "a", v: 1 }, { m: "b", v: 3 }], "a dashboard's data file came back");
  assert.match((await nu.ok("artifacts.get", { id: deck.id })).files["slides.md"], /data:image\/png;base64,iVBORw0KGgo=/, "a deck's image came back");
  assert.equal((await nu.ok("artifacts.list", { archived: true })).some(x => x.id === parked.id), true, "archived stays archived");
  assert.equal((await nu.call("artifacts.get", { id: gone.id })).error?.code, "not_found", "a deleted artifact stays deleted");
  await nu.ok("artifacts.undelete", { id: gone.id });
  assert.match((await nu.ok("artifacts.get", { id: gone.id })).files["index.md"], /Scratch/, "and its 30 days to undo came with it");
  assert.equal((await nu.call("artifacts.get", { id: dash.id }, "mcp:agent:juno", { thread: "t1" })).error, undefined, "the # tag still grants its thread the read");
  // A new version on the restored box carries on from where the old one stopped.
  assert.equal((await nu.ok("artifacts.update", { id: report.id, content: "# Intake report\n\nNew matters: 60." })).version, 4);
});

test("AR8: a backup entry under data is accepted, and an artifact's store sits inside what an uninstall with data removes", async t => {
  assert.doesNotThrow(() => checkEntries("data/\ndata/artifacts/store/p/a_1/.git/HEAD\n"));
  assert.throws(() => checkEntries("data/\ndata/another-module/x\n"), /unsafe/, "only the named parts of data are carried");
  assert.deepEqual(DATA_PARTS, ["artifacts"]);
  assert.throws(() => checkEntries("../data/x\n"), /unsafe/);
  const a = tempHome(t);
  const m = await bootOn(a);
  t.after(() => m.close());
  const made = await m.ok("artifacts.create", { project: "harlow-legal", kind: "doc", title: "Memo", content: "# Memo\n\nx" });
  const store = path.join(a, "data", "artifacts", "store", "harlow-legal", made.id);
  assert.ok(fs.existsSync(store));
  assert.ok(!path.relative(a, store).startsWith(".."), "the store is inside the Vyre home, which a purge deletes whole and a box's vyre-home volume holds");
  const plan = uninstallPlan({ purge: true, home: "/home/alex", etc: "/etc/systemd/system" });
  assert.ok(plan.some(s => s.do === "remove" && s.path === "/home/alex/.vyre"), "a purge removes the whole home, artifacts included");
  assert.ok(!uninstallPlan({ purge: false, home: "/home/alex" }).some(s => s.do === "remove" && /\.vyre$/.test(s.path)), "without purge the data stays");
  const box = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "box", "vyre"), "utf8");
  assert.match(box, /vyre-home\) echo "[^"]*artifacts[^"]*"/, "the uninstall prompt names artifacts among what the volume holds");
});

test("AR8: a restore that cannot swap in the artifacts leaves the ones already on the box", async t => {
  const a = tempHome(t), b = tempHome(t, "target");
  const src = await bootOn(a);
  const one = await src.ok("artifacts.create", { project: "harlow-legal", kind: "doc", title: "From the backup", content: "# From the backup\n\nx" });
  await src.close();
  const file = path.join(a, "box.vyre");
  await backup({ root: a, file, passphrase: PASSPHRASE, ...FAST });
  // A box that already has artifacts, and a restore whose final rename is made to fail.
  const keep = path.join(b, "data", "artifacts", "store", "harlow-legal", "a_existing");
  fs.mkdirSync(keep, { recursive: true });
  fs.writeFileSync(path.join(keep, "index.md"), "mine");
  const real = fs.renameSync;
  let armed = false;
  fs.renameSync = (from, to) => { if (armed && String(to).endsWith(path.join("data", "artifacts"))) { armed = false; throw new Error("disk full"); } return real(from, to); };
  t.after(() => { fs.renameSync = real; });
  armed = true;
  await assert.rejects(restore({ root: b, file, passphrase: PASSPHRASE, force: true, alive: dead }), /disk full/);
  fs.renameSync = real;
  assert.equal(fs.readFileSync(path.join(keep, "index.md"), "utf8"), "mine", "the artifacts already there are still there");
  assert.ok(!fs.readdirSync(path.join(b, "data")).some(n => n.includes(".old-")), "nothing left aside");
  void one;
});
