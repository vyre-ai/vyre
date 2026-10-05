// @ts-check
// Every project file lands in the project's Drive folder (the user, 6 Oct 2026), in a real vyred with the kernel on and the fake claude: an image Claude returns in a tool result, a file another provider's
// tool made (vyre_media), an image the person dropped into the chat, and a document a model made with artifacts.create. Each is in Projects/<project id>/chat|made/<chat id>/, recorded as a project-file linked
// from its chat and its Project.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, until } from "./testing/boot.js";

process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1"; process.env.VYRE_LEGACY_DIRECT_MODEL = "1";
const png = (/** @type {string} */ tag) => Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from(tag.repeat(30))]);

async function world(/** @type {any} */ t, /** @type {any} */ o = {}) {
  const w = await boot(t, { kernel: true, ...o });
  await w.tool("projects.create", { name: "Northgate Intake", home: w.work }).catch(() => null);
  const owner = w.d.kernel.id.owner;
  const admin = w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck", name: "Draft the welcome email" })).data;
  await w.finished(th.id);
  // the thread's chat: its folders are named by the chat id
  const chat = (await w.d.registry.call("threads.chat-of", { thread: th.id }, "module:work")).data.chat;
  assert.ok(chat, "the thread has a chat");
  // the Project record is made with the chat (the hub); its Drive folder is named by its id, and so is each chat's
  const root = await until(async () => { const r = (await w.d.kernel.gateway.records.query(admin, "project", { page: { limit: 20 } })).rows.find((/** @type {any} */ x) => x.data.slug === "northgate-intake"); return r ? r.data.drive_path : null; }, "the project folder");
  let turn = 1;
  const say = async (/** @type {string} */ text, /** @type {any} */ more = {}) => { await w.tool("threads.send", { thread: th.id, surface: "deck", text, ...more }); await w.finished(th.id, ++turn); };
  const drive = async () => (await w.d.kernel.gateway.drive.list(admin, "Projects/")).map((/** @type {any} */ e) => e.path || e.name).filter((/** @type {string} */ p) => !p.endsWith(".project")).sort();
  const files = async () => (await w.d.kernel.gateway.records.query(admin, "project-file", { page: { limit: 100 } })).rows;
  const bytes = async (/** @type {string} */ p) => Buffer.from(await w.d.kernel.gateway.drive.get(admin, p));
  return { w, th, chat, say, drive, files, bytes, admin, root };
}

test("an image Claude returns as a tool result, a provider's generated media, a dropped image and a model's document each land in the project's Drive folder, once", { timeout: 180_000 }, async t => {
  const { w, th, chat, say, drive, files, bytes, admin, root } = await world(t);
  const folder = chat;
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
  // each is a record, linked from its chat and its Project
  const rows = await files();
  assert.equal(rows.length, 4);
  const chatRec = (await w.d.kernel.gateway.records.query(admin, "chat-record", { page: { limit: 10 } })).rows.find((/** @type {any} */ x) => x.data.chat === chat);
  const project = (await w.d.kernel.gateway.records.query(admin, "project", { page: { limit: 20 } })).rows.find((/** @type {any} */ x) => x.data.slug === "northgate-intake");
  assert.ok(rows.every((/** @type {any} */ r) => r.data.chat.urn === chatRec.urn && r.data.project.urn === project.urn && r.data.path && r.data.sha256 && r.data.size > 0));
  assert.deepEqual(rows.map((/** @type {any} */ r) => r.data.kind).sort(), ["chat", "made", "made", "made"]);
  const linked = await w.d.kernel.gateway.records.linked(admin, project.urn, { type: "project-file" });
  assert.equal(linked.rows.length, 4, "the Project lists its files");
  // the Drive screen shows the Project's and the chat's own names over the id folders
  const meta = { token: (await w.d.kernel.surfaces.open(w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: w.d.kernel.id.owner, path: "direct", session: "s" }), {})).token };
  const listed = await w.d.registry.call("files.drive.space.list", { prefix: "Projects" }, "cli", meta);
  assert.equal(listed.data.names[root], "Northgate Intake");
  assert.equal(listed.data.names[`${root}/chat/${folder}`], "Draft the welcome email");
  assert.equal(listed.data.names[`${root}/made/${folder}`], "Draft the welcome email");
});

test("only Vyre's own modules put files into a project's folder; a chat without a project of its own is filed under General", { timeout: 120_000 }, async t => {
  const w = await boot(t, { kernel: true });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
  await w.finished(th.id);
  const r = await w.d.registry.call("work.files.save", { thread: th.id, kind: "made", name: "a.png", base64: png("x").toString("base64") }, "module:artifacts");
  assert.match(r.data.path, new RegExp(`^Projects/[^/]+/made/[^/]+/a\\.png$`), JSON.stringify(r));
  // an exact list of modules: any other module, even a first-party one, cannot plant a file in a chat's folder
  for (const who of ["module:gate", "module:vyred", "module:sessions"]) assert.equal((await w.d.registry.call("work.files.save", { thread: th.id, kind: "made", name: "b.png", base64: png("y").toString("base64") }, who)).error?.code, "denied", who);
  assert.equal((await w.tool("work.files.save", { thread: th.id, kind: "made", name: "a.png", base64: "AAAA" })).error?.code, "no_such_tool", "a person's surface does not call it");
  assert.ok((await w.d.registry.call("work.files.save", { thread: th.id, kind: "made", name: "a.png", base64: "AAAA" }, "mcp")).error, "a model does not either");
});

test("a file a session saves in its own folder ($VYRE_ARTIFACTS_DIR) lands in the project's folder with no event from the provider: an image, a document, a spreadsheet, a PDF and a code output", { timeout: 180_000 }, async t => {
  const { w, th, chat, say, drive, files, bytes, admin, root } = await world(t);
  const folder = chat;
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

test("a rename never moves a chat's files; filing the chat under another Project (Move to project) moves them and their records follow", { timeout: 180_000 }, async t => {
  const { w, chat, say, drive, files, bytes, admin, root } = await world(t);
  await say(`imageblock ${png("heron ").toString("base64")}`);
  await say("look at this", { images: [{ media_type: "image/png", data: png("dropped ").toString("base64"), name: "site photo" }] });
  const before = [`${root}/chat/${chat}/site photo.png`, `${root}/made/${chat}/image.png`];
  await until(async () => JSON.stringify(await drive()) === JSON.stringify(before), "both files", 30_000);
  // a rename of the chat is only a title: nothing in the Drive moves, and the records still point at the same paths
  const row = (await w.d.kernel.gateway.records.query(admin, "chat-record", { page: { limit: 5 } })).rows.find((/** @type {any} */ x) => x.data.chat === chat);
  await w.d.kernel.gateway.records.update(admin, "chat-record", row.id, { title: "Rivera retainer follow-up" }, row.version);
  await new Promise(r => setTimeout(r, 1500));
  assert.deepEqual(await drive(), before);
  assert.deepEqual((await files()).map((/** @type {any} */ r) => r.data.path).sort(), before);
  // Move to project
  const owner = w.d.kernel.id.owner;
  const meta = { token: (await w.d.kernel.surfaces.open(w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" }), {})).token };
  const other = await w.d.registry.call("work.project.create", { name: "Rivera Estate" }, "cli", meta);
  assert.ok(other.data, JSON.stringify(other));
  const moved = await w.d.registry.call("work.chat.move", { chat, project: other.data.slug }, "cli", meta);
  assert.ok(moved.data, JSON.stringify(moved));
  const after = [`${other.data.drive_path}/chat/${chat}/site photo.png`, `${other.data.drive_path}/made/${chat}/image.png`].sort();
  await until(async () => { const r = (await files()).map((/** @type {any} */ x) => x.data.path).sort(); return JSON.stringify(r) === JSON.stringify(after); }, "the records to follow the move", 30_000);
  assert.deepEqual((await drive()).filter((/** @type {string} */ p) => !p.startsWith(root + "/")), after.filter(p => (p)), "the files are under the other Project now");
  assert.ok((await bytes(after[1])).equals(png("heron ")), "the same bytes");
  const project = (await w.d.kernel.gateway.records.query(admin, "project", { page: { limit: 20 } })).rows.find((/** @type {any} */ x) => x.data.slug === "rivera-estate");
  assert.ok((await files()).every((/** @type {any} */ r) => r.data.project.urn === project.urn), "each file is linked from the new Project");
});

test("Share to project: a person in the chat shares one of its files with the project's members, sharing twice changes nothing, and unsharing takes it back", { timeout: 180_000 }, async t => {
  const { w, chat, say, drive, root } = await world(t);
  await say("look at this", { images: [{ media_type: "image/png", data: png("dropped ").toString("base64"), name: "site photo" }] });
  const path = `${root}/chat/${chat}/site photo.png`;
  await until(async () => (await drive()).includes(path), "the dropped image in the chat's folder");
  const meta = { token: (await w.d.kernel.surfaces.open(w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: w.d.kernel.id.owner, path: "direct", session: "s" }), {})).token };
  const a = await w.d.registry.call("work.files.share", { path }, "cli", meta);
  assert.ok(a.data && a.data.shared === path, JSON.stringify(a));
  const b = await w.d.registry.call("work.files.share", { path }, "cli", meta);
  assert.deepEqual(b.data.grant, a.data.grant, "sharing twice returns the same grant");
  assert.equal((await w.d.registry.call("work.files.share", { path: `${root}/chat/${chat}/../x` }, "cli", meta)).error?.code, "bad_input");
  assert.equal((await w.d.registry.call("work.files.share", { path: `${root}/chat/${chat}/site photo.png` }, "mcp")).error !== undefined, true, "a model with no session of the person's does not share");
  const u = await w.d.registry.call("work.files.unshare", { path }, "cli", meta);
  assert.equal(u.data.unshared, 1, JSON.stringify(u));
});

test("a person who is not in the chat cannot share one of its files, nor take a share back: the kernel answers not_found as for a file that is not there", { timeout: 180_000 }, async t => {
  const { w, chat, say, drive, root, admin } = await world(t, { standIn: true });
  await say("look at this", { images: [{ media_type: "image/png", data: png("dropped ").toString("base64"), name: "site photo" }] });
  const path = `${root}/chat/${chat}/site photo.png`;
  await until(async () => (await drive()).includes(path), "the dropped image in the chat's folder");
  // a second person in the Space, who is not in this chat (a member; the owner started the chat)
  const DAN = "per_dan";
  await w.d.kernel.gateway.grants.setRole(admin, { person: DAN, role: "member" }, { presence: { method: "stand-in" } });
  const dan = w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-dan", person: DAN, path: "direct", session: "s" });
  const danMeta = { token: (await w.d.kernel.surfaces.open(dan, {})).token };
  const share = await w.d.registry.call("work.files.share", { path }, "cli", danMeta);
  assert.equal(share.error?.code, "not_found", "not in the chat: " + JSON.stringify(share));
  // the person in the chat shares it; the other still cannot take it back
  const ownerMeta = { token: (await w.d.kernel.surfaces.open(w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: w.d.kernel.id.owner, path: "direct", session: "s" }), {})).token };
  assert.ok((await w.d.registry.call("work.files.share", { path }, "cli", ownerMeta)).data);
  assert.equal((await w.d.registry.call("work.files.unshare", { path }, "cli", danMeta)).error?.code, "not_found");
  assert.equal((await w.d.registry.call("work.files.unshare", { path }, "cli", ownerMeta)).data.unshared, 1);
});
