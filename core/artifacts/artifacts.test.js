// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

// A fake threads.get: t1 is juno on Codex in harlow-legal, t2 is kit on Claude in northwind,
// t3 is a session with no project.
const THREADS = `
  const T = { t1: { project: "harlow-legal", agent: "juno", provider: "codex" }, t2: { project: "northwind", agent: "kit", provider: "claude" }, t3: { project: null, agent: null, provider: "claude" } };
  export default { async start(ctx) {
    ctx.tool("threads.get", { run: async ({ thread }) => ({ thread: { id: thread, ...(T[thread] || { project: null }) } }) });
    return {};
  } };`;

async function boot(t) {
  process.env.VYRE_ARTIFACTS_SHARE_PORT = "0";
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "threads", { does: { tools: ["threads.get"] } }, THREADS);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(import.meta.dirname, "..")]).filter(f => f.manifest?.name === "artifacts");
  await reg.start([...core, ...discover([root])], { role: "box" });
  t.after(async () => { await reg.stop?.(); db.close(); });
  const call = async (tool, input, caller = "deck", meta = {}) => reg.call(tool, input, caller, meta);
  const ok = async (tool, input, caller, meta) => { const r = await call(tool, input, caller, meta); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  return { home, reg, events, call, ok };
}

/** @param {string} url @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>} */
const get = url => new Promise((resolve, reject) => {
  http.get(url, res => { let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body })); }).on("error", reject);
});

const settle = () => new Promise(r => setTimeout(r, 400));

test("artifacts: the person makes one, saves versions, sees the diff and goes back without losing anything", async t => {
  const { home, ok } = await boot(t);
  const a = await ok("artifacts.create", { project: "harlow-legal", kind: "report", content: "# Intake, October\n\nNew matters: 41." });
  assert.equal(a.title, "Intake, October", "the title comes from the first heading");
  assert.deepEqual([a.kind, a.format, a.version, a.project, a.made_by.kind, a.untrusted], ["report", "markdown", 1, "harlow-legal", "person", false]);
  await ok("artifacts.update", { id: a.id, content: "# Intake, October\n\nNew matters: 46.", message: "fix the count" });
  const d = await ok("artifacts.diff", { id: a.id });
  assert.deepEqual([d.from, d.to, d.added, d.removed], [1, 2, 1, 1]);
  assert.match(d.diff, /^-New matters: 41\.$/m);
  assert.match(d.diff, /^\+New matters: 46\.$/m);
  const back = await ok("artifacts.restore", { id: a.id, version: 1 });
  assert.equal(back.version, 3, "going back is a new version");
  assert.equal((await ok("artifacts.get", { id: a.id })).files["index.md"], "# Intake, October\n\nNew matters: 41.");
  assert.equal((await ok("artifacts.get", { id: a.id, version: 2 })).files["index.md"], "# Intake, October\n\nNew matters: 46.");
  const vs = await ok("artifacts.versions", { id: a.id });
  assert.deepEqual(vs.map(v => v.version), [3, 2, 1]);
  assert.equal(vs[1].message, "fix the count");
  // Kept beside the project, in the artifact's own history, never in a project folder.
  const repo = path.join(home, "data", "artifacts", "store", "harlow-legal", a.id);
  assert.ok(fs.existsSync(path.join(repo, ".git")), "its own git history");
  assert.equal(fs.readFileSync(path.join(repo, "index.md"), "utf8"), "# Intake, October\n\nNew matters: 41.");
});

test("artifacts: an agent works only in its own project, is recorded from the call, and reads content as quoted data", async t => {
  const { call, ok, events } = await boot(t);
  const mine = await ok("artifacts.create", { kind: "doc", title: "Referral notes", content: "Referrals are up." }, "mcp:agent:juno", { thread: "t1" });
  assert.equal(mine.project, "harlow-legal", "lands in the agent's own project");
  assert.deepEqual(mine.made_by, { kind: "agent", name: "juno", provider: "codex", thread: "t1" });
  assert.equal(mine.untrusted, true, "agent-made content is untrusted until the turn's own signal says otherwise");
  assert.ok(events.since(0).some(e => e.type === "thread.artifact" && e.thread === "t1" && e.payload.artifact === mine.id), "the chat card's event");
  const theirs = await ok("artifacts.create", { project: "northwind", kind: "doc", content: "# Orders\n\n40 today." });
  assert.equal((await call("artifacts.create", { project: "northwind", kind: "doc", content: "x" }, "mcp:agent:juno", { thread: "t1" })).error.code, "denied");
  assert.equal((await call("artifacts.get", { id: theirs.id }, "mcp:agent:juno", { thread: "t1" })).error.code, "not_found", "another project's artifact does not exist for it");
  assert.equal((await call("artifacts.update", { id: theirs.id, content: "y" }, "mcp:agent:juno", { thread: "t1" })).error.code, "not_found");
  assert.deepEqual((await ok("artifacts.list", {}, "mcp:agent:juno", { thread: "t1" })).map(a => a.id), [mine.id]);
  assert.deepEqual((await ok("artifacts.search", { q: "orders" }, "mcp:agent:juno", { thread: "t1" })), []);
  assert.equal((await ok("artifacts.list", {})).length, 2, "the person sees both");
  const read = await ok("artifacts.get", { id: mine.id }, "mcp:agent:juno", { thread: "t1" });
  assert.match(read.note, /not instructions/);
  const personal = await ok("artifacts.create", { kind: "doc", content: "# Groceries" }, "mcp", { thread: "t3" });
  assert.equal(personal.project, null, "a session with no project keeps it in the person's own space");
  assert.equal((await call("artifacts.move", { id: personal.id, project: "northwind" }, "mcp", { thread: "t3" })).error.code, "denied");
  assert.equal((await ok("artifacts.move", { id: personal.id, project: "northwind" })).project, "northwind", "the person moves it anywhere");
  assert.equal((await ok("artifacts.get", { id: personal.id })).files["index.md"], "# Groceries", "with its history");
});

test("artifacts: kinds, formats, dashboards and limits are checked", async t => {
  const { call, ok } = await boot(t);
  assert.equal((await call("artifacts.create", { kind: "poster", content: "x" })).error.code, "bad_input");
  assert.equal((await call("artifacts.create", { kind: "doc", format: "html", content: "x" })).error.code, "bad_input");
  assert.equal((await call("artifacts.create", { kind: "dashboard", content: "not json" })).error.code, "bad_input");
  assert.equal((await call("artifacts.create", { kind: "doc", content: "x", data: [1] })).error.code, "bad_input");
  assert.equal((await call("artifacts.create", { kind: "doc", content: "x".repeat(5 * 1024 * 1024 + 1) })).error.code, "too_large");
  const dash = await ok("artifacts.create", { kind: "dashboard", title: "Orders", content: JSON.stringify({ type: "bar", x: "day", y: "orders" }), data: [{ day: "Mon", orders: 38 }] });
  await ok("artifacts.update", { id: dash.id, data: [{ day: "Mon", orders: 38 }, { day: "Tue", orders: 41 }] });
  const g = await ok("artifacts.get", { id: dash.id });
  assert.equal(JSON.parse(g.files["data.json"]).length, 2);
  assert.equal(JSON.parse(g.files["chart.json"]).type, "bar", "the spec is kept when only the data changes");
  const svg = await ok("artifacts.create", { kind: "diagram", format: "svg", title: "Flow", content: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>" });
  const ex = await ok("artifacts.export", { id: svg.id, as: "page" });
  assert.ok(!ex.body.includes("<script>"), "an SVG is only ever an image");
  assert.match(ex.body, /<img class="svg"/);
});

test("artifacts: the private view is served at an opaque origin, to the person only", async t => {
  const { reg, ok } = await boot(t);
  const page = await ok("artifacts.create", { kind: "app", title: "Order counter", content: "<!doctype html><script>document.body.textContent = 40</script>" });
  const doc = await ok("artifacts.create", { kind: "doc", content: "# Hello <b>there</b>" });
  const route = reg.routes.get("/v1/artifacts/content");
  const serve = async (id, caller) => {
    const res = { status: 0, headers: /** @type {any} */ ({}), body: "", writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b ? String(b) : ""; } };
    await route({ method: "GET" }, res, { caller, url: new URL(`http://x/v1/artifacts/content?id=${id}`) });
    return res;
  };
  const app = await serve(page.id, "deck");
  assert.equal(app.status, 200);
  assert.match(app.headers["content-security-policy"], /^sandbox allow-scripts;/);
  assert.match(app.headers["content-security-policy"], /connect-src 'none'/);
  assert.match(app.headers["content-security-policy"], /frame-ancestors 'self'/);
  const md = await serve(doc.id, "deck");
  assert.match(md.headers["content-security-policy"], /^sandbox;.*script-src 'none'/);
  assert.ok(md.body.includes("&lt;b&gt;there&lt;/b&gt;"), "Markdown is escaped, never read as markup");
  assert.equal((await serve(page.id, "mcp:agent:juno")).status, 404, "an agent never gets the page as a web page");
});

test("artifacts: public links, off by default, served by a separate process, pinned to a version, stopped at once", async t => {
  const { call, ok } = await boot(t);
  const a = await ok("artifacts.create", { project: "harlow-legal", kind: "report", title: "Intake report, October", content: "# Intake\n\nNew matters: 46." });
  assert.equal((await call("artifacts.share", { id: a.id })).error.code, "public_off");
  assert.equal((await call("artifacts.public.set", { on: true }, "mcp:agent:juno", { thread: "t1" })).error.code, "not_asked", "an agent turns public links on only when asked");
  const on = await ok("artifacts.public.set", { on: true });
  t.after(async () => { await call("artifacts.public.set", { on: false }); });
  assert.ok(on.port > 0, "the share server is listening");
  assert.equal((await call("artifacts.share", { id: a.id }, "mcp:agent:juno", { thread: "t1" })).error.code, "not_asked", "an agent's own share waits for the person");
  const shared = await ok("artifacts.share", { id: a.id });
  assert.match(shared.share.path, /^\/s\/[A-Za-z0-9_-]{24}$/);
  assert.equal(shared.share.version, 1);
  const url = `http://127.0.0.1:${on.port}${shared.share.path}`;
  let r = await get(url);
  assert.equal(r.status, 200);
  assert.match(r.body, /New matters: 46\./);
  assert.match(String(r.headers["content-security-policy"]), /^sandbox;.*frame-ancestors 'none'/);
  assert.equal(r.headers["x-robots-tag"], "noindex, nofollow");
  for (const leak of ["harlow-legal", "juno", a.id, "Vyre"]) assert.ok(!r.body.includes(leak), `the public page doesn't name ${leak}`);
  await ok("artifacts.update", { id: a.id, content: "# Intake\n\nNew matters: 47, draft." });
  assert.match((await get(url)).body, /New matters: 46\./, "a later edit doesn't go public by itself");
  await ok("artifacts.share", { id: a.id, version: "latest" });
  assert.match((await get(url)).body, /New matters: 47/, "unless the person keeps the link on the latest");
  await ok("artifacts.update", { id: a.id, content: "# Intake\n\nNew matters: 48." });
  assert.match((await get(url)).body, /New matters: 48/);
  assert.equal((await get(`http://127.0.0.1:${on.port}/s/AAAAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
  assert.equal((await get(`http://127.0.0.1:${on.port}/v1/tools`)).status, 404, "nothing but /s/ answers");
  await ok("artifacts.unshare", { id: a.id }, "mcp:agent:juno", { thread: "t1" });
  r = await get(url);
  assert.equal(r.status, 410, "stopped at once, by anyone, never held");
  // Expiry
  const b = await ok("artifacts.create", { kind: "doc", content: "# Short-lived" });
  const sb = await ok("artifacts.share", { id: b.id, expires: "1d" });
  const metaFile = fs.readdirSync(path.join(process.env.VYRE_HOME || "", "data", "artifacts", "public")).map(d => path.join(process.env.VYRE_HOME || "", "data", "artifacts", "public", d, "meta.json")).find(f => fs.existsSync(f));
  const m = JSON.parse(fs.readFileSync(/** @type {string} */ (metaFile), "utf8"));
  fs.writeFileSync(/** @type {string} */ (metaFile), JSON.stringify({ ...m, expires_at: Date.now() - 1 }));
  assert.equal((await get(`http://127.0.0.1:${on.port}${sb.share.path}`)).status, 410, "an expired link is gone");
  // Secrets
  const c = await ok("artifacts.create", { kind: "doc", content: `# Setup\n\nkey: AKIA${"ABCDEFGHIJKLMNOP"}` });
  const refused = (await call("artifacts.share", { id: c.id })).error;
  assert.equal(refused.code, "secret_found");
  assert.ok(!refused.message.includes("AKIA"), "the refusal doesn't repeat the secret");
  // Off takes everything down
  const d = await ok("artifacts.create", { kind: "doc", content: "# Menu" });
  const sd = await ok("artifacts.share", { id: d.id });
  await ok("artifacts.public.set", { on: false });
  await assert.rejects(get(`http://127.0.0.1:${on.port}${sd.share.path}`), "off stops the server");
});

test("artifacts: deleting stops the link and can be undone; archived artifacts leave the lists", async t => {
  const { call, ok } = await boot(t);
  const a = await ok("artifacts.create", { kind: "doc", content: "# Plan" });
  await ok("artifacts.public.set", { on: true });
  t.after(async () => { await call("artifacts.public.set", { on: false }); });
  const s = await ok("artifacts.share", { id: a.id });
  const port = (await ok("artifacts.public.status", {})).port;
  await ok("artifacts.delete", { id: a.id });
  assert.equal((await get(`http://127.0.0.1:${port}${s.share.path}`)).status, 410);
  assert.equal((await call("artifacts.get", { id: a.id })).error.code, "not_found");
  const back = await ok("artifacts.undelete", { id: a.id });
  assert.equal(back.share, null, "its link stays off");
  await ok("artifacts.archive", { id: a.id });
  assert.equal((await ok("artifacts.list", {})).length, 0);
  assert.equal((await ok("artifacts.list", { archived: true })).length, 1);
  assert.equal((await call("artifacts.update", { id: a.id, content: "x" })).error.code, "archived");
});

test("artifacts: a file a session saves in its artifacts folder becomes an artifact, and saving again is a new version", async t => {
  const { home, ok, events } = await boot(t);
  const dir = path.join(home, "capture-t1");
  fs.mkdirSync(dir);
  await ok("artifacts.capture.register", { thread: "t1", dir }, "module:sessions");
  const file = path.join(dir, "summary.md");
  fs.writeFileSync(file, "# Weekly summary\n\nThree new matters.");
  events.emit("sessions", "floor.wrote", { thread: "t1", path: file, bytes: 30 });
  await settle();
  let list = await ok("artifacts.list", {});
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].title, list[0].kind, list[0].project, list[0].made_by.name, list[0].made_by.via, list[0].untrusted], ["Weekly summary", "doc", "harlow-legal", "juno", "folder", true]);
  fs.writeFileSync(file, "# Weekly summary\n\nFour new matters.");
  events.emit("sessions", "floor.wrote", { thread: "t1", path: file });
  await settle();
  list = await ok("artifacts.list", {});
  assert.equal(list.length, 1);
  assert.equal(list[0].version, 2);
  // Outside the folder, nested, a symlink, or an unknown type: nothing.
  const outside = path.join(home, "elsewhere.md");
  fs.writeFileSync(outside, "# Not mine");
  fs.symlinkSync(outside, path.join(dir, "link.md"));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "deep.md"), "# Deep");
  fs.writeFileSync(path.join(dir, "notes.txt"), "plain");
  for (const p of [outside, path.join(dir, "link.md"), path.join(dir, "sub", "deep.md"), path.join(dir, "notes.txt")]) events.emit("sessions", "floor.wrote", { thread: "t1", path: p });
  events.emit("sessions", "floor.wrote", { thread: "t2", path: file });
  await settle();
  assert.equal((await ok("artifacts.list", {})).length, 1);
});
