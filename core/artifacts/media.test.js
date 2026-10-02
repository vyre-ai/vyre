// Generated media: an image, a video or a sound a provider made is kept as an artifact with its provider,
// model, prompt and session, reached through the same project permission as any artifact, served with its
// own type and Range, handed to another model by copy, and never mistaken for a page.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import http from "node:http";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { MEDIA, mediaFormatOf, parseRange, MAX_MEDIA } from "./media.js";
import { _test } from "./index.js";

const THREADS = `
  const T = { t1: { project: "harlow-legal", agent: "juno", provider: "grok" }, t2: { project: "harlow-legal", agent: "kit", provider: "codex" }, t3: { project: "northwind", agent: "nia", provider: "codex" } };
  export default { async start(ctx) { ctx.tool("threads.get", { run: async ({ thread }) => ({ thread: { id: thread, ...(T[thread] || { project: null }) } }) }); return {}; } };`;
const AGENTS = `export default { async start(ctx) { ctx.tool("agents.list", { run: async () => [{ name: "juno", kind: "agent" }, { name: "kit", kind: "agent" }, { name: "nia", kind: "agent" }] }); return {}; } };`;

// Real enough bytes for each format's magic check.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake png body ".repeat(50))]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(4), Buffer.alloc(100000, 7)]);

const settle = () => new Promise(r => setTimeout(r, 400));
const folder = t => { const d = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "media-"))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

async function boot(t) {
  const was = { debounce: _test.mediaDebounce, caps: _test.mediaCaps };
  _test.mediaDebounce = 20;
  t.after(() => { _test.mediaDebounce = was.debounce; _test.mediaCaps = was.caps; });
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "threads", { does: { tools: ["threads.get"] } }, THREADS);
  writeModule(root, "agents", { does: { tools: ["agents.list"] } }, AGENTS);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(import.meta.dirname, "..")]).filter(f => f.manifest?.name === "artifacts");
  await reg.start([...core, ...discover([root])], { role: "box" });
  t.after(async () => { await reg.stop?.(); db.close(); });
  const call = (tool, input, caller = "deck", meta = {}) => reg.call(tool, input, caller, meta);
  const ok = async (tool, input, caller, meta) => { const r = await call(tool, input, caller, meta); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const asVyre = (tool, input, who = "sessions") => reg.tools.get(tool).run(input, { caller: `module:${who}`, firstParty: true });
  return { home, reg, events, call, ok, asVyre };
}

/** Serve one artifact through the private content route, collecting the bytes. */
async function serve(reg, id, { range, method = "GET", caller = "deck", query = "" } = {}) {
  const route = reg.routes.get("/v1/artifacts/content");
  const chunks = [];
  const res = Object.assign(new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }), { status: 0, headers: /** @type {any} */ ({}), writeHead(s, h) { this.status = s; this.headers = h; } });
  const done = new Promise(r => { res.on("finish", r); setTimeout(r, 3000); });
  await route({ method, headers: range ? { range } : {} }, res, { caller, url: new URL(`http://x/v1/artifacts/content?id=${id}${query}`) });
  await done;
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks) };
}

test("media: the formats, their types, the magic check and the byte ranges", () => {
  assert.equal(mediaFormatOf("Sunset.PNG"), "png");
  assert.equal(mediaFormatOf("a.jpg"), "jpeg");
  assert.equal(mediaFormatOf("clip.mp4"), "mp4");
  assert.equal(mediaFormatOf("notes.md"), null);
  assert.equal(mediaFormatOf("logo.svg"), null, "an SVG is a diagram, drawn through the cleaner, never served as media");
  assert.ok(MEDIA.png.magic(PNG) && !MEDIA.png.magic(Buffer.from("<html><script>")));
  assert.ok(MEDIA.mp4.magic(MP4) && !MEDIA.mp4.magic(PNG));
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=0-999", 100), { start: 0, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "bad");
  assert.equal(parseRange("bytes=5-2", 100), "bad");
  assert.equal(parseRange("items=1-2", 100), "bad");
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(MAX_MEDIA, 100 * 1024 * 1024);
});

test("media: a provider's image is kept with its provider, model, prompt and session, and shows in the project's artifacts", async t => {
  const { ok, asVyre, call, events } = await boot(t);
  const dir = folder(t);
  await asVyre("artifacts.capture.register", { thread: "t1", dir });
  fs.writeFileSync(path.join(dir, "harbour.png"), PNG);
  const made = await asVyre("artifacts.media.register", { thread: "t1", name: "harbour.png", title: "Harbour at dusk", provider: "grok", model: "grok-imagine", prompt: "a harbour at dusk, oil painting", source: "content-block" });
  assert.deepEqual([made.kind, made.format, made.project, made.version, made.untrusted], ["image", "png", "harlow-legal", 1, true]);
  assert.deepEqual([made.media.mime, made.media.bytes, made.media.provider, made.media.model, made.media.prompt, made.media.session, made.media.source], ["image/png", PNG.length, "grok", "grok-imagine", "a harbour at dusk, oil painting", "t1", "content-block"]);
  assert.match(made.media.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([made.made_by.provider, made.made_by.name, made.made_by.thread], ["grok", "juno", "t1"]);
  assert.ok(events.since(0).some(e => e.type === "thread.artifact" && e.thread === "t1" && e.payload.artifact === made.id && e.payload.mime === "image/png"), "the chat card's event names the media type");
  // Listed with the others, filtered by kind, found by what it was made from.
  assert.deepEqual((await ok("artifacts.list", { kind: "image" })).map(x => x.id), [made.id]);
  assert.deepEqual((await ok("artifacts.search", { q: "oil painting" })).map(x => x.id), [made.id], "the prompt is searchable");
  // get answers with metadata and a note, never the bytes.
  const got = await ok("artifacts.get", { id: made.id });
  assert.deepEqual(got.files, {});
  assert.match(got.note, /artifacts_media_copy/);
  assert.equal(got.media.prompt, "a harbour at dusk, oil painting");
  // Only Vyre's session and assistant modules register; nobody else, and not a model.
  assert.notEqual((await call("artifacts.media.register", { thread: "t1", name: "harbour.png" }, "mcp:agent:juno", { thread: "t1" })).error, undefined);
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", name: "harbour.png" }, "bakery"), /only Vyre's own session modules register media/);
});

test("media: a file the folder watcher sees is kept once, and a later register fills in the prompt instead of making a second", async t => {
  const { ok, asVyre, events } = await boot(t);
  const dir = folder(t);
  await asVyre("artifacts.capture.register", { thread: "t2", dir });
  fs.writeFileSync(path.join(dir, "cat.png"), PNG);
  events.emit("sessions", "floor.wrote", { thread: "t2", path: path.join(dir, "cat.png"), bytes: PNG.length });
  await settle();
  let list = await ok("artifacts.list", { kind: "image" });
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].media.provider, list[0].media.prompt, list[0].media.source], ["codex", null, "file"], "the watcher knows the provider from the thread, not the prompt");
  const again = await asVyre("artifacts.media.register", { thread: "t2", name: "cat.png", prompt: "a cat on a keyboard", model: "gpt-image", source: "tool-result" });
  assert.equal(again.id, list[0].id, "the same bytes are the same artifact");
  assert.deepEqual([again.media.prompt, again.media.model, again.media.source], ["a cat on a keyboard", "gpt-image", "tool-result"]);
  assert.equal((await ok("artifacts.list", { kind: "image" })).length, 1);
  assert.deepEqual((await ok("artifacts.search", { q: "keyboard" })).map(x => x.id), [again.id]);
  // Different bytes under the same name are a new artifact (media has one version).
  fs.writeFileSync(path.join(dir, "cat.png"), Buffer.concat([PNG, Buffer.from("more")]));
  await asVyre("artifacts.media.register", { thread: "t2", name: "cat.png", prompt: "the cat again" });
  assert.equal((await ok("artifacts.list", { kind: "image" })).length, 2);
});

test("media: the bytes are checked: a page renamed .png, a symlink, a folder outside the thread's, and a file too large are all refused", async t => {
  const { asVyre } = await boot(t);
  const dir = folder(t), other = folder(t);
  await asVyre("artifacts.capture.register", { thread: "t1", dir });
  fs.writeFileSync(path.join(dir, "evil.png"), "<html><script>alert(1)</script></html>");
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", name: "evil.png" }), /not a png file/);
  fs.writeFileSync(path.join(other, "secret.png"), PNG);
  fs.symlinkSync(path.join(other, "secret.png"), path.join(dir, "link.png"));
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", name: "link.png" }), /can't be read/, "a symlink is never followed");
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", name: "../x.png" }), /name the file as it is/);
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", name: "notes.md" }), /not an image, a video or a sound/);
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t9", name: "a.png" }), /no artifacts folder/);
  const big = path.join(dir, "big.mp4");
  fs.writeFileSync(big, MP4);
  fs.truncateSync(big, MAX_MEDIA + 1);
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", name: "big.mp4" }), /at most 100 MB/);
});

test("media: the content route serves the bytes with their type, Range, nosniff and a sandbox, to the person only", async t => {
  const { reg, asVyre } = await boot(t);
  const dir = folder(t);
  await asVyre("artifacts.capture.register", { thread: "t1", dir });
  fs.writeFileSync(path.join(dir, "clip.mp4"), MP4);
  const v = await asVyre("artifacts.media.register", { thread: "t1", name: "clip.mp4", title: "Harbour flyover", provider: "grok", prompt: "a drone shot" });
  const full = await serve(reg, v.id);
  assert.equal(full.status, 200);
  assert.equal(full.headers["content-type"], "video/mp4");
  assert.equal(full.headers["x-content-type-options"], "nosniff");
  assert.match(full.headers["content-security-policy"], /^sandbox;/);
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.match(full.headers["content-disposition"], /^inline; filename="Harbour-flyover\.mp4"/);
  assert.ok(full.body.equals(MP4), "the bytes are the file");
  const part = await serve(reg, v.id, { range: "bytes=4-11" });
  assert.equal(part.status, 206);
  assert.equal(part.headers["content-range"], `bytes 4-11/${MP4.length}`);
  assert.equal(part.body.toString("latin1"), "ftypmp42");
  assert.equal((await serve(reg, v.id, { range: "bytes=999999999-" })).status, 416);
  assert.equal((await serve(reg, v.id, { method: "HEAD" })).body.length, 0);
  assert.match((await serve(reg, v.id, { query: "&download=1" })).headers["content-disposition"], /^attachment/);
  assert.equal((await serve(reg, v.id, { caller: "mcp:agent:juno" })).status, 404, "a model never gets the route");
});

test("media: the same project permission as every artifact, a # tag grants one item, and a model is handed a file by copy", async t => {
  const { ok, call, asVyre } = await boot(t);
  const d1 = folder(t), d2 = folder(t), d3 = folder(t);
  for (const [thread, dir] of [["t1", d1], ["t2", d2], ["t3", d3]]) await asVyre("artifacts.capture.register", { thread, dir });
  fs.writeFileSync(path.join(d1, "harbour.png"), PNG);
  const made = await asVyre("artifacts.media.register", { thread: "t1", name: "harbour.png", provider: "grok", prompt: "a harbour" });
  const as = (tool, input, thread) => call(tool, input, `mcp:agent:${thread === "t2" ? "kit" : "nia"}`, { thread });
  // kit (Codex, same project) reaches it and copies it into its own folder: "Codex, use the image Grok made".
  assert.equal((await as("artifacts.get", { id: made.id }, "t2")).error, undefined);
  const copy = (await as("artifacts.media.copy", { id: made.id }, "t2")).data;
  assert.equal(copy.path, path.join(d2, "from-artifacts", `${made.id}.png`));
  assert.ok(fs.readFileSync(copy.path).equals(PNG), "the copy is the file");
  assert.deepEqual([copy.provider, copy.prompt], ["grok", "a harbour"]);
  assert.equal(((await as("artifacts.media.copy", { id: made.id }, "t2")).data || {}).path, copy.path, "copying twice is harmless");
  // nia is in another project: not found, until the person tags it into her thread.
  assert.equal((await as("artifacts.media.copy", { id: made.id }, "t3")).error.code, "not_found");
  await asVyre("artifacts.mention.resolve", { id: made.id, thread: "t3" });
  assert.ok(fs.readFileSync((await as("artifacts.media.copy", { id: made.id }, "t3")).data.path).equals(PNG), "a # tag grants exactly this item");
  // A model cannot read the bytes through a tool, nor change the media, nor share it publicly.
  assert.equal((await as("artifacts.media.read", { id: made.id }, "t2")).error.code, "denied");
  assert.match((await as("artifacts.update", { id: made.id, content: "x" }, "t2")).error.message, /one file/);
  assert.match((await call("artifacts.share", { id: made.id })).error.message, /public links are off/, "a media share follows the same switch as any other");
  assert.match((await ok("artifacts.mention.search", { q: "" }))[0].hint, /image \(image\/png\), made by grok/);
  // The person's surfaces and Vyre's own modules read the bytes in chunks (Drive previews).
  const chunk = await ok("artifacts.media.read", { id: made.id, offset: 0, length: 10 });
  assert.deepEqual([chunk.mime, chunk.size, chunk.eof, Buffer.from(chunk.bytes_b64, "base64").length], ["image/png", PNG.length, false, 10]);
  const rest = await asVyre("artifacts.media.read", { id: made.id, offset: 10 });
  assert.equal(rest.eof, true);
  assert.ok(Buffer.concat([Buffer.from(chunk.bytes_b64, "base64"), Buffer.from(rest.bytes_b64, "base64")]).equals(PNG));
  // A title can change; archive and delete work as for any artifact.
  assert.equal((await ok("artifacts.update", { id: made.id, title: "Harbour, final" })).title, "Harbour, final");
  await ok("artifacts.delete", { id: made.id });
  assert.equal((await call("artifacts.get", { id: made.id })).error.code, "not_found");
  await ok("artifacts.undelete", { id: made.id });
  assert.equal((await ok("artifacts.get", { id: made.id })).media.provider, "grok");
  // Writing an image as text is not how it is made.
  assert.match((await call("artifacts.create", { kind: "image", content: "x" })).error.message, /saved as a file/);
});

test("media: the copy-out never follows what an agent planted: a link at the file's name or at the folder's, and Vyre's own folder is the only one it writes in", async t => {
  const { call, asVyre } = await boot(t);
  const d1 = folder(t), d2 = folder(t), victim = folder(t);
  await asVyre("artifacts.capture.register", { thread: "t1", dir: d1 });
  await asVyre("artifacts.capture.register", { thread: "t2", dir: d2 });
  fs.writeFileSync(path.join(d1, "harbour.png"), PNG);
  const made = await asVyre("artifacts.media.register", { thread: "t1", name: "harbour.png" });
  const secret = path.join(victim, "config.json");
  fs.writeFileSync(secret, '{"keep":"me"}');
  const kit = (tool, input) => call(tool, input, "mcp:agent:kit", { thread: "t2" });
  // 1. a link planted at the file's own name inside from-artifacts
  fs.mkdirSync(path.join(d2, "from-artifacts"), { mode: 0o755 });
  fs.symlinkSync(secret, path.join(d2, "from-artifacts", `${made.id}.png`));
  const r1 = await kit("artifacts.media.copy", { id: made.id });
  assert.equal(r1.error?.code, "denied", JSON.stringify(r1));
  assert.equal(fs.readFileSync(secret, "utf8"), '{"keep":"me"}', "the target is untouched");
  // 2. the folder itself is a link to somewhere the agent wants overwritten
  fs.rmSync(path.join(d2, "from-artifacts"), { recursive: true });
  const elsewhere = path.join(victim, "dir");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(d2, "from-artifacts"));
  const r2 = await kit("artifacts.media.copy", { id: made.id });
  assert.equal(r2.error?.code, "denied", JSON.stringify(r2));
  assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing was written through the link");
  // 3. a plain file where the folder should be
  fs.rmSync(path.join(d2, "from-artifacts"));
  fs.writeFileSync(path.join(d2, "from-artifacts"), "not a folder");
  assert.ok((await kit("artifacts.media.copy", { id: made.id })).error, "refused");
  fs.rmSync(path.join(d2, "from-artifacts"));
  // Cleared, it works, and the folder is Vyre's (0755), the file 0644.
  const done = (await kit("artifacts.media.copy", { id: made.id })).data;
  assert.ok(fs.readFileSync(done.path).equals(PNG));
  assert.equal(fs.statSync(path.join(d2, "from-artifacts")).mode & 0o777, 0o755);
  assert.equal(fs.statSync(done.path).mode & 0o777, 0o644);
});

test("media: a project and a thread each have a cap, with a plain refusal; and a file is settled before it is read, once", async t => {
  const { ok, asVyre, events } = await boot(t);
  const dir = folder(t), dir2 = folder(t);
  await asVyre("artifacts.capture.register", { thread: "t1", dir });
  await asVyre("artifacts.capture.register", { thread: "t2", dir: dir2 });
  _test.mediaCaps = { project: PNG.length * 2 + 10, thread: PNG.length + 10 };
  fs.writeFileSync(path.join(dir, "a.png"), PNG);
  await asVyre("artifacts.media.register", { thread: "t1", name: "a.png" });
  fs.writeFileSync(path.join(dir, "b.png"), Buffer.concat([PNG, Buffer.from("b")]));
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", name: "b.png" }), /this conversation's generated media is at its limit/);
  // The other thread of the same project still has room under the thread cap, then the project cap bites.
  fs.writeFileSync(path.join(dir2, "c.png"), Buffer.concat([PNG, Buffer.from("c")]));
  await asVyre("artifacts.media.register", { thread: "t2", name: "c.png" });
  fs.writeFileSync(path.join(dir2, "d.png"), Buffer.concat([PNG, Buffer.from("dd")]));
  _test.mediaCaps = { project: PNG.length * 2 + 10, thread: 1e9 };
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t2", name: "d.png" }), /this project's generated media is at its limit \(0\.0 GB\)|this project's generated media is at its limit/);
  assert.equal((await ok("artifacts.list", { kind: "image" })).length, 2, "nothing half-kept after a refusal");
  // A burst of folder events for one file is one artifact, read once it has settled.
  _test.mediaCaps = { project: 1e9, thread: 1e9 };
  fs.writeFileSync(path.join(dir, "burst.png"), PNG);
  for (let i = 0; i < 12; i++) events.emit("sessions", "floor.wrote", { thread: "t1", path: path.join(dir, "burst.png"), bytes: PNG.length });
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await ok("artifacts.list", { kind: "image" })).filter(x => x.media.session === "t1" && x.title === "burst").length, 1);
});

test("media: a big file is read without holding the thread, and a deleted item is not kept by the browser", async t => {
  const { reg, asVyre } = await boot(t);
  const dir = folder(t);
  await asVyre("artifacts.capture.register", { thread: "t1", dir });
  const big = Buffer.alloc(24 * 1024 * 1024, 5);
  MP4.copy(big);
  fs.writeFileSync(path.join(dir, "long.mp4"), big);
  let worst = 0, last = Date.now();
  const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
  const made = await asVyre("artifacts.media.register", { thread: "t1", name: "long.mp4" });
  clearInterval(tick);
  assert.equal(made.media.bytes, big.length);
  assert.ok(worst < 400, `the event loop was held for ${worst} ms while a 24 MB file was kept`);
  const first = await serve(reg, made.id, { range: "bytes=0-3" });
  assert.equal(first.headers["cache-control"], "private, no-cache", "revalidated each time, so a deleted item is not served from the cache");
  assert.equal(first.headers.etag, `"${made.media.sha256}"`);
  const route = reg.routes.get("/v1/artifacts/content");
  const res = { status: 0, writeHead(s) { this.status = s; }, end() {} };
  await route({ method: "GET", headers: { "if-none-match": `"${made.media.sha256}"` } }, res, { caller: "deck", url: new URL(`http://x/v1/artifacts/content?id=${made.id}`) });
  assert.equal(res.status, 304);
});

test("media: bytes handed over directly (a provider's content block) are kept without any file in an agent's folder, and are checked the same", async t => {
  const { ok, call, asVyre } = await boot(t);
  const b64 = PNG.toString("base64");
  // No artifacts folder is registered for t1 at all: nothing here touches an agent's folder.
  const made = await asVyre("artifacts.media.register", { thread: "t1", mime: "image/png", data_b64: b64, provider: "codex", prompt: "Revised prompt: a lighthouse at dawn", source: "content-block", title: "Lighthouse", privacy: "zdr" });
  assert.equal(made.media.privacy, "zdr", "the account's privacy mode is kept with the item");
  assert.deepEqual([made.kind, made.format, made.media.provider, made.media.source, made.media.bytes], ["image", "png", "codex", "content-block", PNG.length]);
  assert.match(made.media.sha256, /^[0-9a-f]{64}$/);
  const chunk = await asVyre("artifacts.media.read", { id: made.id });
  assert.ok(Buffer.from(chunk.bytes_b64, "base64").equals(PNG), "the bytes are what was handed over");
  assert.deepEqual((await ok("artifacts.search", { q: "lighthouse" })).map(x => x.id), [made.id], "the prompt is searchable");
  // The same bytes again for the thread are the same artifact, with what is now known filled in.
  const again = await asVyre("artifacts.media.register", { thread: "t1", name: "x.png", data_b64: b64, model: "gpt-image" }, "threads");
  assert.equal(again.id, made.id);
  assert.equal(again.media.model, "gpt-image");
  assert.equal(again.media.privacy, "zdr");
  assert.equal((await asVyre("artifacts.media.register", { thread: "t1", mime: "image/png", data_b64: PNG.toString("base64") + "", privacy: "anything" })).media.privacy, "zdr", "an unknown privacy value is ignored, the known one stays");
  assert.equal((await ok("artifacts.list", { kind: "image" })).length, 1);
  // Checked as a file is: magic bytes, a type it knows, a size, a registrar.
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", mime: "image/png", data_b64: Buffer.from("<html><script>").toString("base64") }), /not a png file/);
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", data_b64: b64 }), /say what it is/);
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", mime: "image/png", data_b64: "A".repeat(30 * 1024 * 1024) }), /20 MB/);
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", mime: "image/png", data_b64: "" }), /empty/);
  assert.notEqual((await call("artifacts.media.register", { thread: "t1", mime: "image/png", data_b64: b64 }, "mcp:agent:juno", { thread: "t1" })).error, undefined, "a model never registers");
});

test("media: the thread's own folder swapped for a link at the last moment is still refused, and nothing is created in the link's target", async t => {
  const { call, asVyre } = await boot(t);
  const d1 = folder(t), d2 = folder(t), victim = folder(t);
  await asVyre("artifacts.capture.register", { thread: "t1", dir: d1 });
  await asVyre("artifacts.capture.register", { thread: "t2", dir: d2 });
  fs.writeFileSync(path.join(d1, "harbour.png"), PNG);
  const made = await asVyre("artifacts.media.register", { thread: "t1", name: "harbour.png" });
  // After the identity check and before the open, the agent replaces its folder with a link to a folder Vyre can write.
  _test.beforeCopyOut = () => { _test.beforeCopyOut = null; fs.renameSync(d2, d2 + ".moved"); fs.symlinkSync(victim, d2); };
  t.after(() => { _test.beforeCopyOut = null; fs.rmSync(d2, { force: true }); fs.rmSync(d2 + ".moved", { recursive: true, force: true }); });
  const r = await call("artifacts.media.copy", { id: made.id }, "mcp:agent:kit", { thread: "t2" });
  assert.equal(r.error?.code, "denied", JSON.stringify(r));
  assert.deepEqual(fs.readdirSync(victim), [], "nothing was created in the target");
});

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const pngOf = (w, h, pad = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(w), u32(h), Buffer.alloc(9), Buffer.alloc(pad, 1)]);

test("media: a file's own size and length are kept, a gallery pages through them within scope, and usage and the box-wide cap are reported", async t => {
  const { ok, call, asVyre } = await boot(t);
  const made = [];
  for (const [i, [w, h]] of [[640, 480], [800, 600], [1024, 1024]].entries()) {
    const m = await asVyre("artifacts.media.register", { thread: i === 2 ? "t3" : "t1", mime: "image/png", data_b64: pngOf(w, h, i + 1).toString("base64"), provider: i === 1 ? "codex" : "grok", prompt: `picture ${i} ${"x".repeat(200)}`, title: `Picture ${i}` });
    made.push(m);
    await new Promise(r => setTimeout(r, 5)); // distinct created_at for paging
  }
  assert.deepEqual([made[0].media.width, made[0].media.height], [640, 480], "the size comes from the file's own header");
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(4), Buffer.alloc(8, 0)]);
  const vid = await asVyre("artifacts.media.register", { thread: "t1", mime: "video/mp4", data_b64: mp4.toString("base64"), title: "Clip" });
  assert.equal(vid.media.duration_s, undefined, "nothing is claimed that the file does not say");
  // The gallery: the person sees every project, newest first, a prompt cut short, paged by created_at.
  const g1 = await ok("artifacts.media.gallery", { kind: "image", limit: 2 });
  assert.deepEqual(g1.items.map(x => x.title), ["Picture 2", "Picture 1"]);
  assert.equal(g1.items[0].prompt.length, 140);
  assert.deepEqual([g1.items[0].width, g1.items[0].height], [1024, 1024]);
  assert.ok(g1.next);
  const g2 = await ok("artifacts.media.gallery", { kind: "image", limit: 2, before: g1.next });
  assert.deepEqual(g2.items.map(x => x.title), ["Picture 0"]);
  assert.equal(g2.next, null);
  assert.deepEqual((await ok("artifacts.media.gallery", { provider: "codex" })).items.map(x => x.title), ["Picture 1"]);
  assert.deepEqual((await ok("artifacts.media.gallery", { kind: "video" })).items.map(x => x.title), ["Clip"]);
  // An agent sees its own project only: t3 is northwind's, kit (t2) is harlow-legal's.
  const kit = (await call("artifacts.media.gallery", { kind: "image" }, "mcp:agent:kit", { thread: "t2" })).data;
  assert.deepEqual(kit.items.map(x => x.title).sort(), ["Picture 0", "Picture 1"]);
  // Usage: the person and Vyre's modules read it; a model does not.
  const use = await ok("artifacts.media.usage", {});
  assert.equal(use.total_bytes, made.reduce((n, m) => n + m.media.bytes, 0) + vid.media.bytes);
  assert.deepEqual(use.projects.map(p => p.project).sort(), ["harlow-legal", "northwind"]);
  assert.equal(use.limit_bytes, 20 * 1024 ** 3);
  assert.equal((await call("artifacts.media.usage", {}, "mcp:agent:kit", { thread: "t2" })).error.code, "denied");
  // The box-wide cap refuses with a plain sentence.
  _test.mediaCaps = { project: 1e12, thread: 1e12, total: use.total_bytes + 10 };
  await assert.rejects(asVyre("artifacts.media.register", { thread: "t1", mime: "image/png", data_b64: pngOf(10, 10, 100).toString("base64") }), /generated media on this box is at its limit/);
});

const PRETEND_VYRED = 99999;
async function shareServer(t, home) {
  const dir = path.join(home, "data", "artifacts", "public");
  fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
  const script = path.join(import.meta.dirname, "share-server.js");
  const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${dir}`, `--allow-fs-read=${script}`, `--allow-fs-write=${dir}`, script, "--dir", dir, "--port", "0", "--not-uid", String(PRETEND_VYRED)], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", b => { out += b; const m = /listening (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.on("exit", c => reject(new Error(`share server exited ${c}`)));
  });
  const own = _test.ownUid;
  _test.ownUid = () => PRETEND_VYRED;
  t.after(() => { _test.ownUid = own; child.kill("SIGTERM"); });
  return { port };
}
const fetchRaw = (port, p, headers = {}, method = "GET") => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, res => { const c = []; res.on("data", d => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); });
  req.on("error", reject); req.end();
});

test("media: a public link serves the file with its own type, Range and a sandbox, never as a page, and stops at once", async t => {
  const { home, ok, asVyre } = await boot(t);
  const { port } = await shareServer(t, home);
  const dir = folder(t);
  await asVyre("artifacts.capture.register", { thread: "t1", dir });
  fs.writeFileSync(path.join(dir, "clip.mp4"), MP4);
  const v = await asVyre("artifacts.media.register", { thread: "t1", name: "clip.mp4", title: "Flyover" });
  await ok("artifacts.public.set", { on: true });
  const shared = await ok("artifacts.share", { id: v.id });
  const url = shared.share.path;
  assert.match(url, /^\/s\/[A-Za-z0-9_-]{24}$/);
  const full = await fetchRaw(port, url);
  assert.equal(full.status, 200);
  assert.equal(full.headers["content-type"], "video/mp4");
  assert.equal(full.headers["x-content-type-options"], "nosniff");
  assert.match(full.headers["content-security-policy"], /^sandbox;/);
  assert.equal(full.headers["cache-control"], "no-store");
  assert.equal(full.headers["cross-origin-resource-policy"], "cross-origin", "a public link may be embedded on any page, by design");
  assert.ok(full.body.equals(MP4), "the bytes are the file");
  assert.ok(!JSON.stringify(full.headers).includes("harlow") && !JSON.stringify(full.headers).includes(v.id), "nothing names the project or the artifact");
  const part = await fetchRaw(port, url, { range: "bytes=4-11" });
  assert.equal(part.status, 206);
  assert.equal(part.body.toString("latin1"), "ftypmp42");
  assert.equal((await fetchRaw(port, url, { range: "bytes=99999999-" })).status, 416);
  assert.equal((await fetchRaw(port, url, {}, "HEAD")).body.length, 0);
  assert.equal((await fetchRaw(port, url, {}, "POST")).status, 405);
  // meta.json cannot make the server serve anything else or name its own type.
  const hash = fs.readdirSync(path.join(home, "data", "artifacts", "public")).find(n => /^[0-9a-f]{64}$/.test(n));
  const meta = path.join(home, "data", "artifacts", "public", hash, "meta.json");
  fs.writeFileSync(meta, JSON.stringify({ expires_at: null, media: { file: "../meta.json", mime: "text/html" } }));
  assert.equal((await fetchRaw(port, url)).status, 404, "a file name that is not media.<ext> is refused");
  fs.writeFileSync(meta, JSON.stringify({ expires_at: null, media: { file: "media.mp4", mime: "text/html" }, headers: { "content-type": "text/html" } }));
  assert.equal((await fetchRaw(port, url)).headers["content-type"], "video/mp4", "the type comes from the extension, not meta.json");
  await ok("artifacts.unshare", { id: v.id });
  assert.equal((await fetchRaw(port, url)).status, 410, "stopped at once");
});
