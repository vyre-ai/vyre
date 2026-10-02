// Generated media in Drive, against the REAL artifacts module (core/artifacts), not a stand-in: a provider's image is
// kept by artifacts.media.register, and the project's folder in files.drive.list then shows it under Generated and
// reads its bytes through artifacts.media.read. The call shapes are artifacts' own.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { installFakeReach, clearFakeReach } from "../../test/fixtures/fake-reach.js";

const CORE = path.join(import.meta.dirname, "..");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake png body ".repeat(40))]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(4), Buffer.alloc(3000, 7)]);
const tmpd = t => { const d = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "gen-real-"))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

async function boot(t) {
  const home = tempHome(t);
  const work = tmpd(t);
  const harlow = path.join(work, "harlow-legal"), other = path.join(work, "northwind");
  fs.mkdirSync(harlow, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(harlow, "brief.md"), "hi");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ role: "box", files: { roots: [work], drive: { shares: { projects: null, work } } } }));
  const mods = path.join(home, "mods");
  // The threads module artifacts asks which project and agent a thread belongs to; agents and projects come from the shared fixture.
  writeModule(mods, "threads", { does: { tools: ["threads.get"] } }, `
    const T = { t1: { project: "harlow-legal", agent: "juno", provider: "grok" }, t3: { project: "northwind", agent: "nia", provider: "codex" } };
    export default { async start(ctx) { ctx.tool("threads.get", { run: async ({ thread }) => ({ thread: { id: thread, ...(T[thread] || { project: null }) } }) }); return {}; } };`);
  installFakeReach(mods, home, { agents: [{ name: "juno", kind: "agent", projects: ["harlow-legal"] }, { name: "kit", kind: "agent", projects: ["harlow-legal"] }, { name: "nia", kind: "agent", projects: ["northwind"] }],
    projects: [{ slug: "harlow-legal", name: "Harlow", home: harlow, workspaces: [] }, { slug: "northwind", name: "Northwind", home: other, workspaces: [] }], access: { "harlow-legal:kit": true, "harlow-legal:juno": true, "northwind:nia": true } });
  t.after(() => clearFakeReach(home));
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box", files: { roots: [work], drive: { shares: { projects: null, work } } } }, paths: { root: home }, log: () => {} });
  const found = discover([CORE]).filter(f => f.manifest && ["artifacts", "files"].includes(f.manifest.name));
  // Until the artifacts module's media calls are on this branch there is nothing real to run against.
  if (!found.some(f => f.manifest.name === "artifacts" && JSON.stringify(f.manifest).includes("artifacts.media.usage"))) return null;
  await reg.start([...found, ...discover([mods])], { role: "box" });
  for (const n of ["artifacts", "files"]) assert.equal(reg.modules.get(n)?.state, "running", `${n}: ${reg.modules.get(n)?.error}`);
  t.after(async () => { await reg.stop?.(); db.close(); });
  const asVyre = (tool, input, who = "sessions") => reg.tools.get(tool).run(input, { caller: `module:${who}`, firstParty: true });
  const ok = async (tool, input, caller = "cli", meta = {}) => { const r = await reg.call(tool, input, caller, meta); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const no = async (tool, input, caller, meta = {}) => { const r = await reg.call(tool, input, caller, meta); assert.ok(r.error, `${tool} should have been refused`); return r.error; };
  const capture = async (thread, name, bytes) => {
    const dir = tmpd(t);
    await asVyre("artifacts.capture.register", { thread, dir });
    fs.writeFileSync(path.join(dir, name), bytes);
    return asVyre("artifacts.media.register", { thread, name, title: name.replace(/\.\w+$/, ""), provider: "grok", model: "grok-imagine", prompt: "a harbour" });
  };
  return { reg, ok, no, capture, work };
}

test("drive generated, real artifacts: an image and a video a provider made show under Generated in the project's folder and read back byte for byte", async t => {
  const b = await boot(t);
  if (!b) return t.skip("core/artifacts has no artifacts.media.usage on this branch yet");
  const { ok, no, capture } = b;
  const img = await capture("t1", "harbour.png", PNG);
  const vid = await capture("t1", "clip.mp4", MP4);
  await capture("t3", "secret.png", PNG);
  assert.equal(img.project, "harlow-legal");

  const top = await ok("files.drive.list", { share: "work", path: "harlow-legal" });
  assert.deepEqual(top.entries.map(e => [e.name, e.virtual === true]), [["Generated", true], ["brief.md", false]]);
  const g = await ok("files.drive.list", { share: "work", path: "harlow-legal/Generated" });
  const byName = Object.fromEntries(g.entries.map(e => [e.name, e]));
  assert.deepEqual(Object.keys(byName).sort(), ["clip.mp4", "harbour.png"]);
  assert.deepEqual([byName["harbour.png"].kind, byName["harbour.png"].mime, byName["harbour.png"].size, byName["harbour.png"].artifact], ["image", "image/png", PNG.length, img.id]);
  assert.deepEqual([byName["clip.mp4"].kind, byName["clip.mp4"].mime, byName["clip.mp4"].artifact], ["video", "video/mp4", vid.id]);

  // The file's own header gave the picture its size (the png here is not a decodable image, so only a real one would), and the usage line comes from artifacts.
  assert.equal(typeof g.quota.used, "number");
  assert.ok(g.quota.limit > 0 && g.quota.total_limit > 0 && g.quota.items === 2, JSON.stringify(g.quota));
  // Chunked read through artifacts.media.read: the whole file, in pieces, equals what was made.
  let got = Buffer.alloc(0), offset = 0;
  for (;;) {
    const r = await ok("files.drive.read", { share: "work", path: "harlow-legal/Generated/harbour.png", offset, length: 200 });
    got = Buffer.concat([got, Buffer.from(r.base64, "base64")]);
    offset += r.length;
    if (r.done) break;
    assert.ok(r.length > 0);
  }
  assert.ok(got.equals(PNG), "the bytes read back are the bytes the provider made");

  // Another project's folder lists nothing of this project's, and its own media stays its own.
  const nw = await ok("files.drive.list", { share: "work", path: "northwind/Generated" });
  assert.deepEqual(nw.entries.map(e => e.name), ["secret.png"]);

  // A named agent granted harlow-legal sees its media; it is refused northwind's folder and so its media.
  assert.equal((await ok("files.drive.list", { share: "work", path: "harlow-legal/Generated" }, "mcp:agent:kit")).entries.length, 2);
  assert.ok(Buffer.from((await ok("files.drive.read", { share: "work", path: "harlow-legal/Generated/clip.mp4" }, "mcp:agent:kit")).base64, "base64").equals(MP4.subarray(0, 1024 * 1024)));
  assert.equal((await no("files.drive.list", { share: "work", path: "northwind/Generated" }, "mcp:agent:kit")).code, "not_available");
  assert.equal((await no("files.drive.read", { share: "work", path: "northwind/Generated/secret.png" }, "mcp:agent:kit")).code, "not_available");
});
