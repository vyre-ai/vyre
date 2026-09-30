// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { spawn } from "node:child_process";
import { tempHome, writeModule } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { _test } from "./index.js";

// A fake threads.get: t1 is juno on Codex in harlow-legal, t2 is kit on Claude in northwind,
// t3 is a session with no project.
const THREADS = `
  const T = { t1: { project: "harlow-legal", agent: "juno", provider: "codex" }, t2: { project: "northwind", agent: "kit", provider: "claude" }, t3: { project: null, agent: null, provider: "claude" } };
  export default { async start(ctx) {
    ctx.tool("threads.get", { run: async ({ thread }) => thread === "gone" ? {} : ({ thread: { id: thread, ...(T[thread] || { project: null }) } }) });
    return {};
  } };`;

async function boot(t) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "threads", { does: { tools: ["threads.get"] } }, THREADS);
  // A fake agents.list: aide is the assistant.
  writeModule(root, "agents", { does: { tools: ["agents.list"] } }, `export default { async start(ctx) {
    ctx.tool("agents.list", { run: async () => [{ name: "juno", kind: "agent" }, { name: "kit", kind: "agent" }, { name: "aide", kind: "assistant" }] });
    return {}; } };`);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(import.meta.dirname, "..")]).filter(f => f.manifest?.name === "artifacts");
  await reg.start([...core, ...discover([root])], { role: "box" });
  t.after(async () => { await reg.stop?.(); db.close(); });
  const call = async (tool, input, caller = "deck", meta = {}) => reg.call(tool, input, caller, meta);
  const ok = async (tool, input, caller, meta) => { const r = await call(tool, input, caller, meta); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  // One of Vyre's own modules calling a reach "modules" tool (sessions, the network setup): the
  // registry sets firstParty from the loader, which a fake module in a temp home never is.
  const asVyre = (tool, input, who = "sessions") => reg.tools.get(tool).run(input, { caller: `module:${who}`, firstParty: true });
  return { home, reg, events, call, ok, asVyre };
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
  assert.equal((await call("artifacts.create", { project: "northwind", kind: "doc", content: "x" }, "mcp:agent:juno", { thread: "t1" })).error.code, "not_found"); // the registry refuses a project juno is not granted (projectArg), before artifacts does
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
  assert.match(ex.body, /<img alt="Flow"/);
  assert.match(ex.body, /Vyre removed a script from this SVG/, "the page says what was removed");
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

// The share server as the box image runs it: its own process, refusing vyred's uid. Tests run as
// one user, so vyred's uid is pretended to be 99999 here (the _test seam) and the server is told
// not to be 99999: the real uid check still runs, against a uid that differs.
const PRETEND_VYRED = 99999;
async function shareServer(t, home) {
  const dir = path.join(home, "data", "artifacts", "public");
  const script = path.join(import.meta.dirname, "share-server.js");
  const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${dir}`, `--allow-fs-read=${script}`, `--allow-fs-write=${dir}`, script, "--dir", dir, "--port", "0", "--not-uid", String(PRETEND_VYRED)], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", b => { out += b; const m = /listening (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.on("exit", c => reject(new Error(`share server exited ${c}`)));
  });
  const own = _test.ownUid;
  _test.ownUid = () => PRETEND_VYRED;
  t.after(() => { _test.ownUid = own; child.kill("SIGTERM"); });
  return { port: /** @type {number} */ (port), child };
}

/** A capture folder outside the home, by its real path (sessions passes real paths). */
function captureDir(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "cap-")));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("artifacts: public links stay off until the share server runs under a user that isn't vyred's (H2)", async t => {
  const { home, call, ok } = await boot(t);
  const a = await ok("artifacts.create", { kind: "doc", content: "# Menu" });
  let r = await call("artifacts.public.set", { on: true });
  assert.equal(r.error.code, "not_available");
  assert.match(r.error.message, /next server update/);
  assert.equal((await ok("artifacts.public.status", {})).available, false);
  // A share server started as vyred's own user refuses to run at all.
  const dir = path.join(home, "data", "artifacts", "public");
  const script = path.join(import.meta.dirname, "share-server.js");
  const same = spawn(process.execPath, [script, "--dir", dir, "--port", "0", "--not-uid", String(process.getuid?.())], { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(await new Promise(res => same.on("exit", c => res(c))), 3);
  const bare = spawn(process.execPath, [script, "--dir", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(await new Promise(res => bare.on("exit", c => res(c))), 3, "and without being told vyred's uid");
  // A record naming a process that runs as vyred's own user is not enough.
  fs.writeFileSync(path.join(dir, ".server.json"), JSON.stringify({ pid: process.pid, uid: 4242, port: 7311 }));
  r = await call("artifacts.public.set", { on: true });
  assert.equal(r.error.code, "not_available", "vyred checks the process's real uid, not the record's word");
  fs.rmSync(path.join(dir, ".server.json"));
  assert.equal((await call("artifacts.share", { id: a.id })).error.code, "public_off");
});

test("artifacts: public links, served by a separate process, pinned to a version, stopped at once", async t => {
  const { home, call, ok } = await boot(t);
  const { port } = await shareServer(t, home);
  const a = await ok("artifacts.create", { project: "harlow-legal", kind: "report", title: "Intake report, October", content: "# Intake\n\nNew matters: 46." });
  assert.equal((await call("artifacts.share", { id: a.id })).error.code, "public_off");
  assert.equal((await call("artifacts.public.set", { on: true }, "mcp:agent:juno", { thread: "t1" })).error.code, "not_asked", "an agent turns public links on only when asked");
  const on = await ok("artifacts.public.set", { on: true });
  assert.equal(on.available, true);
  // The registry holds an outward call from anyone but the person (held_unavailable until the Gate
  // is wired); artifacts refuses it itself as the second lock. Either way it doesn't run.
  assert.match((await call("artifacts.share", { id: a.id }, "mcp:agent:juno", { thread: "t1" })).error.code, /^(not_asked|held_unavailable)$/, "an agent's own share waits for the person");
  const shared = await ok("artifacts.share", { id: a.id });
  assert.match(shared.share.path, /^\/s\/[A-Za-z0-9_-]{24}$/);
  assert.equal(shared.share.version, 1);
  const url = `http://127.0.0.1:${port}${shared.share.path}`;
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
  assert.match((await get(url)).body, /New matters: 48/, "the person's own edit follows");
  // "Always the latest" is the person's choice: an agent's later version follows too (lead, 30 Sep).
  const juno = await ok("artifacts.update", { id: a.id, content: "# Intake\n\nNew matters: 49." }, "mcp:agent:juno", { thread: "t1" });
  assert.match((await get(url)).body, /New matters: 49/);
  assert.equal((await get(`http://127.0.0.1:${port}/s/AAAAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
  assert.equal((await get(`http://127.0.0.1:${port}/v1/tools`)).status, 404, "nothing but /s/ answers");
  await ok("artifacts.unshare", { id: a.id }, "mcp:agent:juno", { thread: "t1" });
  assert.equal((await get(url)).status, 410, "stopped at once, by anyone, never held");
  // Expiry
  const b = await ok("artifacts.create", { kind: "doc", content: "# Short-lived" });
  const sb = await ok("artifacts.share", { id: b.id, expires: "1d" });
  const pub = path.join(home, "data", "artifacts", "public");
  const metaFile = fs.readdirSync(pub).map(d => path.join(pub, d, "meta.json")).find(f => fs.existsSync(f));
  const m = JSON.parse(fs.readFileSync(/** @type {string} */ (metaFile), "utf8"));
  fs.writeFileSync(/** @type {string} */ (metaFile), JSON.stringify({ ...m, expires_at: Date.now() - 1 }));
  assert.equal((await get(`http://127.0.0.1:${port}${sb.share.path}`)).status, 410, "an expired link is gone");
  // Secrets
  const c = await ok("artifacts.create", { kind: "doc", content: `# Setup\n\nkey: AKIA${"ABCDEFGHIJKLMNOP"}` });
  const refused = (await call("artifacts.share", { id: c.id })).error;
  assert.equal(refused.code, "secret_found");
  assert.ok(!refused.message.includes("AKIA"), "the refusal doesn't repeat the secret");
  assert.equal((await ok("artifacts.get", { id: c.id })).share, null, "and leaves no share behind");
  // Off stops every link; on again brings them back until they expire.
  const d = await ok("artifacts.create", { kind: "doc", content: "# Menu" });
  const sd = await ok("artifacts.share", { id: d.id });
  await ok("artifacts.public.set", { on: false });
  assert.equal((await get(`http://127.0.0.1:${port}${sd.share.path}`)).status, 404);
  await ok("artifacts.public.set", { on: true });
  assert.equal((await get(`http://127.0.0.1:${port}${sd.share.path}`)).status, 200);
  // L2: a downloaded page carries its own network ban.
  const ex = await ok("artifacts.export", { id: d.id, as: "page" });
  assert.match(ex.body, /<head><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*connect-src 'none'/);
});

test("artifacts: deleting stops the link and can be undone; archived artifacts leave the lists", async t => {
  const { home, call, ok } = await boot(t);
  const { port } = await shareServer(t, home);
  const a = await ok("artifacts.create", { kind: "doc", content: "# Plan" });
  await ok("artifacts.public.set", { on: true });
  const s = await ok("artifacts.share", { id: a.id });
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

test("artifacts: an added module and a project-less agent reach only what they made (M1, M2); the public address is Vyre's own (M4)", async t => {
  const { call, ok, asVyre } = await boot(t);
  const mine = await ok("artifacts.create", { kind: "doc", content: "# My own notes" });
  assert.equal(mine.project, null, "the person's own space");
  // A session with no project
  assert.deepEqual(await ok("artifacts.list", {}, "mcp", { thread: "t3" }), [], "doesn't see the person's own artifacts");
  assert.equal((await call("artifacts.get", { id: mine.id }, "mcp", { thread: "t3" })).error.code, "not_found");
  assert.equal((await call("artifacts.delete", { id: mine.id }, "mcp", { thread: "t3" })).error.code, "not_found");
  const its = await ok("artifacts.create", { kind: "doc", content: "# Draft" }, "mcp", { thread: "t3" });
  assert.deepEqual((await ok("artifacts.list", {}, "mcp", { thread: "t3" })).map(a => a.id), [its.id], "but sees its own");
  // The assistant reaches everything, the person's own space included (lead, 30 Sep).
  assert.equal((await ok("artifacts.get", { id: mine.id }, "mcp:agent:aide", { thread: "t3" })).id, mine.id);
  assert.equal((await ok("artifacts.list", {}, "mcp:agent:aide")).length, 2);
  // An added module is not the person
  const mod = await call("artifacts.list", {}, "module:bakery");
  if (!mod.error) assert.deepEqual(mod.data, [], "an added module lists nothing it didn't make");
  else assert.ok(["denied", "not_declared", "not_found", "forbidden"].includes(mod.error.code) || /module/.test(mod.error.message), JSON.stringify(mod.error));
  assert.equal((await call("artifacts.get", { id: mine.id }, "module:bakery")).error?.code !== undefined, true);
  // The public address: never the person, never an added module
  assert.equal((await call("artifacts.public.base", { base: "https://evil.example" })).error.code, "no_such_tool", "the person never sets it");
  assert.equal((await call("artifacts.public.base", { base: "https://evil.example" }, "module:bakery")).error !== undefined, true, "nor an added module");
  await assert.rejects(asVyre("artifacts.public.base", { base: "http://plain.example" }, "network"), /https origin/);
  await asVyre("artifacts.public.base", { base: "https://studio.tail1234.ts.net:8443" }, "network");
  assert.equal((await ok("artifacts.public.status", {})).base, "https://studio.tail1234.ts.net:8443");
  assert.equal((await call("artifacts.public.set", { on: true, base: "https://evil.example" })).error.code, "bad_input", "public.set takes only on");
});

test("artifacts: a file a session saves in its artifacts folder becomes an artifact, and saving again is a new version", async t => {
  const { home, call, ok, events, asVyre } = await boot(t);
  const dir = captureDir(t);
  assert.equal((await call("artifacts.capture.register", { thread: "t1", dir })).error.code, "no_such_tool", "only Vyre's own modules see it");
  fs.mkdirSync(path.join(home, "inside"));
  await assert.rejects(asVyre("artifacts.capture.register", { thread: "t1", dir: fs.realpathSync(path.join(home, "inside")) }), /inside Vyre's own home/);
  await assert.rejects(asVyre("artifacts.capture.register", { thread: "t1", dir: "/" }), /absolute folder/);
  await asVyre("artifacts.capture.register", { thread: "t1", dir });
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
  // Outside the folder, nested, a symlink, a hard link, or an unknown type: nothing.
  const outside = path.join(home, "elsewhere.md");
  fs.writeFileSync(outside, "# Not mine");
  fs.symlinkSync(outside, path.join(dir, "link.md"));
  fs.linkSync(outside, path.join(dir, "hard.md"));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "deep.md"), "# Deep");
  fs.writeFileSync(path.join(dir, "notes.txt"), "plain");
  for (const p of [outside, path.join(dir, "link.md"), path.join(dir, "hard.md"), path.join(dir, "sub", "deep.md"), path.join(dir, "notes.txt"), path.join(dir, "sub", "..", "..", path.basename(dir), "summary.md")]) events.emit("sessions", "floor.wrote", { thread: "t1", path: p });
  events.emit("sessions", "floor.wrote", { thread: "t2", path: file });
  await settle();
  assert.equal((await ok("artifacts.list", {})).length, 1);
});

test("artifacts: a symlink swapped in after the checks, or a swapped folder, is never read (H1)", async t => {
  const { home, ok, events, asVyre } = await boot(t);
  const secret = path.join(home, "vyred-only.md");
  fs.writeFileSync(secret, "# vyred's own secret");
  const dir = captureDir(t);
  await asVyre("artifacts.capture.register", { thread: "t1", dir });
  const file = path.join(dir, "report.md");
  fs.writeFileSync(file, "# Honest report");
  t.after(() => { _test.beforeOpen = null; });
  // The file becomes a link between the checks and the open.
  _test.beforeOpen = f => { fs.rmSync(f); fs.symlinkSync(secret, f); };
  events.emit("sessions", "floor.wrote", { thread: "t1", path: file });
  await settle();
  assert.equal((await ok("artifacts.list", {})).length, 0);
  // The folder itself is swapped for a link to another folder holding the same name.
  const other = captureDir(t);
  fs.copyFileSync(secret, path.join(other, "report.md"));
  fs.rmSync(file);
  fs.writeFileSync(file, "# Honest report");
  const moved = `${dir}.real`;
  _test.beforeOpen = () => { fs.renameSync(dir, moved); fs.symlinkSync(other, dir); };
  t.after(() => { try { fs.rmSync(dir); } catch {} try { fs.rmSync(moved, { recursive: true, force: true }); } catch {} });
  events.emit("sessions", "floor.wrote", { thread: "t1", path: file });
  await settle();
  _test.beforeOpen = null;
  assert.equal((await ok("artifacts.list", {})).length, 0);
  // A file owned by someone other than the agent's registered user is ignored.
  const d2 = captureDir(t);
  await asVyre("artifacts.capture.register", { thread: "t2", dir: d2, uid: 4242 });
  fs.writeFileSync(path.join(d2, "x.md"), "# Not the agent's");
  events.emit("sessions", "floor.wrote", { thread: "t2", path: path.join(d2, "x.md") });
  await settle();
  assert.equal((await ok("artifacts.list", {})).length, 0);
});

test("artifacts: the # picker finds titles within the caller's reach and resolves a tag to a reference", async t => {
  const { ok, call, asVyre } = await boot(t);
  const a = await ok("artifacts.create", { project: "harlow-legal", kind: "report", title: "Referral tracker", content: "# Referral tracker\n\nsecret body words" });
  await ok("artifacts.create", { project: "other", kind: "doc", title: "Lease notes", content: "# Lease notes\n\nx" });
  const hit = await ok("artifacts.mention.search", { q: "refer" });
  assert.deepEqual(hit.map(h => [h.kind, h.id, h.name]), [["artifact", a.id, "Referral tracker"]]);
  assert.ok(!JSON.stringify(hit).includes("secret body"), "names and hints only");
  assert.equal((await ok("artifacts.mention.search", {})).length, 2, "an empty query lists the latest");
  const r = await asVyre("artifacts.mention.resolve", { id: a.id, thread: "t1" });
  assert.equal((await call("artifacts.mention.search", { q: "x" }, "mcp:agent:juno", { thread: "t1" })).error !== undefined, true, "a model never searches");
  assert.deepEqual([r.name, r.grant], ["Referral tracker", { read: a.id, access: "read" }]);
  assert.ok(!JSON.stringify(r).includes("secret body"), "a tag carries no content");
  assert.equal((await call("artifacts.mention.resolve", { id: a.id })).error.code, "no_such_tool", "the person never calls it");
  await assert.rejects(asVyre("artifacts.mention.resolve", { id: "a_nope", thread: "t1" }), /no artifact/i);
  await assert.rejects(asVyre("artifacts.mention.resolve", { id: a.id, thread: "gone" }), /no thread/i, "only on a thread that exists");
});

test("artifacts: a # tag lets one thread read exactly one artifact, in any project, and nothing more", async t => {
  const { ok, call, asVyre, events } = await boot(t);
  const far = await ok("artifacts.create", { project: "other", kind: "doc", title: "Lease notes", content: "# Lease notes\n\nx" });
  const near = await ok("artifacts.create", { project: "other", kind: "doc", title: "Other notes", content: "# Other notes\n\ny" });
  const juno = (tool, input, thread = "t1") => call(tool, input, "mcp:agent:juno", { thread });
  assert.equal((await juno("artifacts.get", { id: far.id })).error.code, "not_found", "before the tag");
  assert.notEqual((await call("artifacts.mention.resolve", { id: far.id, thread: "t1" }, "module:bakery")).error, undefined, "a tag is recorded only by first-party modules");
  assert.notEqual((await call("artifacts.mention.resolve", { id: far.id, thread: "t1" }, "mcp:agent:juno", { thread: "t1" })).error, undefined, "never by an agent for itself");
  const r = await asVyre("artifacts.mention.resolve", { id: far.id, thread: "t1" });
  assert.deepEqual(r.grant, { read: far.id, access: "read" });
  const got = await juno("artifacts.get", { id: far.id });
  assert.equal(got.error, undefined, JSON.stringify(got.error));
  assert.equal((await juno("artifacts.versions", { id: far.id })).error, undefined);
  assert.equal((await juno("artifacts.get", { id: near.id })).error.code, "not_found", "exactly that item");
  assert.equal((await juno("artifacts.update", { id: far.id, content: "changed" })).error.code, "not_found", "read only");
  assert.equal((await juno("artifacts.move", { id: far.id, project: "harlow-legal" })).error.code, "not_found", "a read grant never moves, archives, shares or deletes it");
  for (const tool of ["artifacts.archive", "artifacts.delete", "artifacts.share", "artifacts.export"]) assert.notEqual((await juno(tool, { id: far.id })).error, undefined, tool);
  assert.equal((await juno("artifacts.get", { id: far.id }, "t9")).error.code, "not_found", "only that thread");
  assert.equal((await juno("artifacts.search", { q: "Lease" })).data?.length ?? 0, 0, "search stays in scope");
  await assert.rejects(asVyre("artifacts.mention.resolve", { id: near.id, thread: "t1" }, "mentions"), /only Vyre's session and assistant/, "the mentions core forwards the caller, it does not record");
  await asVyre("artifacts.mention.resolve", { id: near.id, thread: "t1" }, "assistant");
  assert.equal((await juno("artifacts.get", { id: near.id })).error, undefined, "the assistant module may record one");
  events.emit("threads", "thread.deleted", { thread: "t1" });
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await juno("artifacts.get", { id: far.id })).error.code, "not_found", "a deleted thread's tags end");
  await asVyre("artifacts.mention.resolve", { id: far.id, thread: "t1" });
  await ok("artifacts.delete", { id: far.id });
  assert.equal((await juno("artifacts.get", { id: far.id })).error.code, "not_found");
});
