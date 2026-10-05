// @ts-check
// Every project file lands in the project's Drive folder (the user, 6 Oct 2026), in a real vyred with the kernel on and the fake claude: an image Claude returns in a tool result, a file another provider's
// tool made (vyre_media), an image the person dropped into the chat, and a document a model made with artifacts.create. Each is in Projects/<slug>/chat|made/<session>/, recorded as a project-file linked
// from its session and its Project.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, until } from "./testing/boot.js";

process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1"; process.env.VYRE_LEGACY_DIRECT_MODEL = "1";
const png = (/** @type {string} */ tag) => Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from(tag.repeat(30))]);

async function world(/** @type {any} */ t) {
  const w = await boot(t, { kernel: true });
  await w.tool("projects.create", { name: "Harlow Intake", home: w.work }).catch(() => null);
  const owner = w.d.kernel.id.owner;
  const admin = w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck", name: "Draft the welcome email" })).data;
  await w.finished(th.id);
  // the Project record is made with the session (the hub); its Drive folder is named by its id, and so is each session's
  const root = await until(async () => { const r = (await w.d.kernel.gateway.records.query(admin, "project", { page: { limit: 20 } })).rows.find((/** @type {any} */ x) => x.data.slug === "harlow-intake"); return r ? r.data.drive_path : null; }, "the project folder");
  let turn = 1;
  const say = async (/** @type {string} */ text, /** @type {any} */ more = {}) => { await w.tool("threads.send", { thread: th.id, surface: "deck", text, ...more }); await w.finished(th.id, ++turn); };
  const drive = async () => (await w.d.kernel.gateway.drive.list(admin, "Projects/")).map((/** @type {any} */ e) => e.path || e.name).filter((/** @type {string} */ p) => !p.endsWith(".project")).sort();
  const files = async () => (await w.d.kernel.gateway.records.query(admin, "project-file", { page: { limit: 100 } })).rows;
  const bytes = async (/** @type {string} */ p) => Buffer.from(await w.d.kernel.gateway.drive.get(admin, p));
  return { w, th, say, drive, files, bytes, admin, root };
}

test("an image Claude returns as a tool result, a provider's generated media, a dropped image and a model's document each land in the project's Drive folder, once", { timeout: 180_000 }, async t => {
  const { w, th, say, drive, files, bytes, admin, root } = await world(t);
  const folder = th.id;
  const heron = png("heron "), circle = png("circle "), dropped = png("dropped "), made = png("made ");
  // 1. Claude's own tool_result image block
  await say(`imageblock ${heron.toString("base64")}`);
  await until(async () => (await drive()).length >= 1, "the Claude image in the folder");
  assert.deepEqual(await drive(), [`${root}/made/${folder}/image.png`]);
  assert.ok((await bytes(`${root}/made/${folder}/image.png`)).equals(heron), "the bytes as Claude returned them");
  // 2. a file another provider's tool made (the shape the Codex and Grok drivers give)
  await say(`media ${JSON.stringify([{ mime: "image/png", data_b64: circle.toString("base64"), source: "content-block", prompt: "a red circle" }])}`);
  await until(async () => (await drive()).length >= 2, "the generated image in the folder");
  assert.ok((await drive()).includes(`${root}/made/${folder}/a-red-circle.png`));
  // 3. an image the person dropped into the chat
  await say("look at this", { images: [{ media_type: "image/png", data: dropped.toString("base64"), name: "site photo" }] });
  await until(async () => (await drive()).some(p => p.includes("/chat/")), "the dropped image in the folder");
  assert.ok((await bytes(`${root}/chat/${folder}/site photo.png`)).equals(dropped));
  // the same image dropped again is not saved twice
  await say("and again", { images: [{ media_type: "image/png", data: dropped.toString("base64"), name: "site photo" }] });
  // 4. a document a model made with artifacts.create, and a new version of it
  await say(`vyre artifacts.create ${JSON.stringify({ kind: "report", title: "Intake report", content: "# Intake\n\nNew matters: 46." })}`);
  const path = `${root}/made/${folder}/intake-report.md`;
  await until(async () => (await drive()).includes(path), "the report in the folder");
  assert.equal((await bytes(path)).toString(), "# Intake\n\nNew matters: 46.");
  const art = (await w.d.registry.call("artifacts.list", {}, "cli")).data;
  const id = (art.items || art).find((/** @type {any} */ a) => a.title === "Intake report").id;
  await say(`vyre artifacts.update ${JSON.stringify({ id, content: "# Intake\n\nNew matters: 47." })}`);
  await until(async () => (await bytes(path)).toString().includes("47"), "the new version");
  assert.equal((await w.d.kernel.gateway.drive.history(admin, path)).length, 2, "an edit is a new Drive version of the same file");
  assert.deepEqual(await drive(), [
    `${root}/chat/${folder}/site photo.png`, `${root}/made/${folder}/a-red-circle.png`, `${root}/made/${folder}/image.png`, path].sort());
  // each is a record, linked from its session and its Project
  const rows = await files();
  assert.equal(rows.length, 4);
  const session = (await w.d.kernel.gateway.records.query(admin, "session-summary", { page: { limit: 10 } })).rows[0];
  const project = (await w.d.kernel.gateway.records.query(admin, "project", { page: { limit: 20 } })).rows.find((/** @type {any} */ x) => x.data.slug === "harlow-intake");
  assert.ok(rows.every((/** @type {any} */ r) => r.data.session.urn === session.urn && r.data.project.urn === project.urn && r.data.path && r.data.sha256 && r.data.size > 0));
  assert.deepEqual(rows.map((/** @type {any} */ r) => r.data.kind).sort(), ["chat", "made", "made", "made"]);
  const linked = await w.d.kernel.gateway.records.linked(admin, project.urn, { type: "project-file" });
  assert.equal(linked.rows.length, 4, "the Project lists its files");
  // the Drive screen shows the Project's and the session's own names over the id folders
  const meta = { token: (await w.d.kernel.surfaces.open(w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: w.d.kernel.id.owner, path: "direct", session: "s" }), {})).token };
  const listed = await w.d.registry.call("files.drive.space.list", { prefix: "Projects" }, "cli", meta);
  assert.equal(listed.data.names[root], "Harlow Intake");
  assert.equal(listed.data.names[`${root}/chat/${folder}`], "Draft the welcome email");
  assert.equal(listed.data.names[`${root}/made/${folder}`], "Draft the welcome email");
});

test("only Vyre's own modules put files into a project's folder; a session without a project of its own is filed under General", { timeout: 120_000 }, async t => {
  const w = await boot(t, { kernel: true });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
  await w.finished(th.id);
  const r = await w.internal("work.files.save", { thread: th.id, kind: "made", name: "a.png", base64: png("x").toString("base64") });
  assert.match(r.data.path, new RegExp(`^Projects/[^/]+/made/${th.id}/a\\.png$`), JSON.stringify(r));
  assert.equal((await w.tool("work.files.save", { thread: th.id, kind: "made", name: "a.png", base64: "AAAA" })).error?.code, "no_such_tool", "a person's surface does not call it");
  assert.ok((await w.d.registry.call("work.files.save", { thread: th.id, kind: "made", name: "a.png", base64: "AAAA" }, "mcp")).error, "a model does not either");
});

test("a file a session saves in its own folder ($VYRE_ARTIFACTS_DIR) lands in the project's folder with no event from the provider: an image, a document, a spreadsheet, a PDF and a code output", { timeout: 180_000 }, async t => {
  const { w, th, say, drive, files, bytes, admin, root } = await world(t);
  const folder = th.id;
  await say("artifactsdir");
  const said = (await w.said(th.id)).at(-1);
  assert.match(said, /^folder .*\/artifacts$/, "the session was given a folder of its own: " + said);
  const b64 = (/** @type {string | Buffer} */ x) => Buffer.from(x).toString("base64");
  const pdf = Buffer.from("%PDF-1.4\n% a made-up pdf body\n" + "x".repeat(200));
  await say(`savefile chart.png ${b64(png("chart "))}`);
  await say(`savefile notes.md ${b64("# Notes\n\nthe call went well")}`);
  await say(`savefile matters.csv ${b64("id,client\n1,Rivera\n2,Kim\n")}`);
  await say(`savefile retainer.pdf ${b64(pdf)}`);
  await say(`savefile script.py ${b64("print('hello')\n")}`);
  const want = ["chart.png", "notes.md", "matters.csv", "retainer.pdf", "script.py"].map(n => `${root}/made/${folder}/${n}`).sort();
  await until(async () => JSON.stringify((await drive()).filter(p => p.includes("/made/"))) === JSON.stringify(want), "all five files in the project folder", 30_000);
  assert.ok((await bytes(`${root}/made/${folder}/retainer.pdf`)).equals(pdf), "a PDF is kept as it is");
  assert.equal((await bytes(`${root}/made/${folder}/matters.csv`)).toString(), "id,client\n1,Rivera\n2,Kim\n");
  // an edit to a saved file is a new Drive version of the same file, not a second file
  await say(`savefile notes.md ${b64("# Notes\n\nthe call went well; send the retainer")}`);
  await until(async () => (await bytes(`${root}/made/${folder}/notes.md`)).toString().includes("retainer"), "the edited notes", 30_000);
  assert.equal((await drive()).filter(p => p.includes("notes")).length, 1);
  assert.equal((await w.d.kernel.gateway.drive.history(admin, `${root}/made/${folder}/notes.md`)).length >= 2, true);
  // the image and the notes are also artifacts; the spreadsheet, PDF and script are files of the project
  const arts = (await w.d.registry.call("artifacts.list", {}, "cli")).data;
  const kinds = (arts.items || arts).map((/** @type {any} */ a) => a.kind).sort();
  assert.ok(kinds.includes("image") && kinds.includes("doc"));
  assert.equal((await files()).filter((/** @type {any} */ r) => r.data.kind === "made").length, 5);
});

test("a rename never moves a session's files; filing the session under another Project (Move to project) moves them and their records follow", { timeout: 180_000 }, async t => {
  const { w, th, say, drive, files, bytes, admin, root } = await world(t);
  await say(`imageblock ${png("heron ").toString("base64")}`);
  await say("look at this", { images: [{ media_type: "image/png", data: png("dropped ").toString("base64"), name: "site photo" }] });
  const before = [`${root}/chat/${th.id}/site photo.png`, `${root}/made/${th.id}/image.png`];
  await until(async () => JSON.stringify(await drive()) === JSON.stringify(before), "both files", 30_000);
  // a rename of the session is only a title: nothing in the Drive moves, and the records still point at the same paths
  const row = (await w.d.kernel.gateway.records.query(admin, "session-summary", { page: { limit: 5 } })).rows[0];
  await w.d.kernel.gateway.records.update(admin, "session-summary", row.id, { title: "Rivera retainer follow-up" }, row.version);
  await new Promise(r => setTimeout(r, 1500));
  assert.deepEqual(await drive(), before);
  assert.deepEqual((await files()).map((/** @type {any} */ r) => r.data.path).sort(), before);
  // Move to project
  const owner = w.d.kernel.id.owner;
  const meta = { token: (await w.d.kernel.surfaces.open(w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" }), {})).token };
  const other = await w.d.registry.call("work.project.create", { name: "Rivera Estate" }, "cli", meta);
  assert.ok(other.data, JSON.stringify(other));
  const moved = await w.d.registry.call("work.session.move", { thread: th.id, project: other.data.slug }, "cli", meta);
  assert.ok(moved.data, JSON.stringify(moved));
  const after = [`${other.data.drive_path}/chat/${th.id}/site photo.png`, `${other.data.drive_path}/made/${th.id}/image.png`].sort();
  await until(async () => { const r = (await files()).map((/** @type {any} */ x) => x.data.path).sort(); return JSON.stringify(r) === JSON.stringify(after); }, "the records to follow the move", 30_000);
  assert.deepEqual((await drive()).filter((/** @type {string} */ p) => !p.startsWith(root + "/")), after.filter(p => (p)), "the files are under the other Project now");
  assert.ok((await bytes(after[1])).equals(png("heron ")), "the same bytes");
  const project = (await w.d.kernel.gateway.records.query(admin, "project", { page: { limit: 20 } })).rows.find((/** @type {any} */ x) => x.data.slug === "rivera-estate");
  assert.ok((await files()).every((/** @type {any} */ r) => r.data.project.urn === project.urn), "each file is linked from the new Project");
});
