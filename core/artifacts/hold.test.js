// The Gate on interactive pages: a page or an app made by a session that BOTH read outside content and touched
// private data is held until the person opens it on purpose. Anything less, and every other kind, is untouched.
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
import { _test } from "./index.js";

const THREADS = `
  const T = {
    tainted: { project: "harlow-legal", agent: "juno", provider: "claude", taint: { outside: true, private: true } },
    outside: { project: "harlow-legal", agent: "kit", provider: "claude", taint: { outside: true, private: false } },
    priv: { project: "harlow-legal", agent: "nia", provider: "claude", taint: { outside: false, private: true } },
    clean: { project: "harlow-legal", agent: "ida", provider: "claude", taint: { outside: false, private: false } },
    plain: { project: "harlow-legal", agent: "oz", provider: "claude" },
  };
  export default { async start(ctx) { ctx.tool("threads.get", { run: async ({ thread }) => ({ thread: { id: thread, ...(T[thread] || { project: null }) } }) }); return {}; } };`;
const AGENTS = `export default { async start(ctx) { ctx.tool("agents.list", { run: async () => [{ name: "juno", kind: "agent" }, { name: "kit", kind: "agent" }, { name: "nia", kind: "agent" }, { name: "ida", kind: "agent" }, { name: "oz", kind: "agent" }] }); return {}; } };`;
const AGENT_OF = { tainted: "juno", outside: "kit", priv: "nia", clean: "ida", plain: "oz" };
const PAGE = "<!doctype html><p id=x>runs</p><script>document.getElementById('x').textContent='ran'</script>";

async function boot(t) {
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
  const as = (thread, tool, input) => call(tool, input, `mcp:agent:${AGENT_OF[thread]}`, { thread });
  return { home, reg, events, call, ok, as };
}
async function serve(reg, id) {
  const route = reg.routes.get("/v1/artifacts/content");
  const chunks = [];
  const res = Object.assign(new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }), { status: 0, headers: /** @type {any} */ ({}), writeHead(s, h) { this.status = s; this.headers = h; } });
  const done = new Promise(r => { res.on("finish", r); setTimeout(r, 2000); });
  await route({ method: "GET", headers: {} }, res, { caller: "deck", url: new URL(`http://x/v1/artifacts/content?id=${id}`) });
  await done;
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") };
}

test("hold: a page or an app from a session that read outside content AND touched private data is held; less than both is not", async t => {
  const { ok, as, events } = await boot(t);
  const made = {};
  for (const th of ["tainted", "outside", "priv", "clean", "plain"]) {
    const r = await as(th, "artifacts.create", { kind: "app", title: `Counter ${th}`, content: PAGE });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    made[th] = r.data;
  }
  assert.ok(made.tainted.held && made.tainted.held.why.includes("read content from outside"), "both flags: held");
  assert.equal(made.tainted.interactive, true);
  for (const th of ["outside", "priv", "clean", "plain"]) assert.equal(made[th].held, null, `${th}: not held`);
  assert.ok(events.since(0).some(e => e.type === "artifact.held" && e.payload.artifact === made.tainted.id), "an event tells the surfaces");
  // Only a page or an app: a document or a dashboard from the same session runs no code.
  const doc = (await as("tainted", "artifacts.create", { kind: "doc", content: "# Notes\n\nbody" })).data;
  assert.equal(doc.held, null);
  // The person's own page is never held, even in a thread that is tainted (the person made it).
  assert.equal((await ok("artifacts.create", { kind: "app", title: "Mine", content: PAGE })).held, null);
  // A list says so.
  assert.deepEqual((await ok("artifacts.list", {})).filter(x => x.held).map(x => x.id), [made.tainted.id]);
});

test("hold: a held page serves a note with no script, never the page, until the person opens it; then it runs", async t => {
  const { reg, ok, as } = await boot(t);
  const a = (await as("tainted", "artifacts.create", { kind: "page", title: "Quote calculator", content: PAGE })).data;
  const held = await serve(reg, a.id);
  assert.equal(held.status, 200);
  assert.ok(!held.body.includes("ran") && !held.body.includes("<script"), "the page's code is not served");
  assert.match(held.body, /Quote calculator is held/);
  assert.match(held.body, /read content from outside and used your private data/);
  assert.match(held.headers["content-security-policy"], /^sandbox;/, "the note itself is a static page");
  assert.ok(!/allow-scripts/.test(held.headers["content-security-policy"]));
  // A model cannot open it; the person can.
  assert.notEqual((await as("tainted", "artifacts.release", { id: a.id })).error, undefined);
  assert.equal(held.status, (await serve(reg, a.id)).status);
  assert.equal((await ok("artifacts.release", { id: a.id })).held, null);
  const open1 = await serve(reg, a.id);
  assert.match(open1.headers["content-security-policy"], /^sandbox allow-scripts;/);
  assert.ok(open1.body.includes("document.getElementById"), "now it is the page");
  // Releasing twice is harmless.
  assert.equal((await ok("artifacts.release", { id: a.id })).held, null);
});

test("hold: changed content from a tainted session is held again, a held page is not shared, and a file the session saves is held too", async t => {
  const { reg, ok, as, call, events } = await boot(t);
  const a = (await as("tainted", "artifacts.create", { kind: "app", content: PAGE })).data;
  await ok("artifacts.release", { id: a.id });
  const up = (await as("tainted", "artifacts.update", { id: a.id, content: PAGE + "<!-- v2 -->" })).data;
  assert.ok(up.held, "an update from the tainted session is held again");
  assert.match((await call("artifacts.share", { id: a.id })).error.message, /held/);
  // The person editing it does not change the hold; opening it is its own act.
  assert.ok((await ok("artifacts.update", { id: a.id, title: "Renamed by me" })).held);
  // A file saved in the thread's artifacts folder goes through the same rule.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "hold-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asVyre = (tool, input) => reg.tools.get(tool).run(input, { caller: "module:sessions", firstParty: true });
  await asVyre("artifacts.capture.register", { thread: "tainted", dir });
  fs.writeFileSync(path.join(dir, "tool.html"), PAGE);
  events.emit("sessions", "floor.wrote", { thread: "tainted", path: path.join(dir, "tool.html"), bytes: PAGE.length });
  await new Promise(r => setTimeout(r, 500));
  const saved = (await ok("artifacts.list", {})).find(x => x.title === "tool" || x.made_by.via === "folder");
  assert.ok(saved && saved.held, "a saved file is held too");
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
const getBody = (port, p) => new Promise((resolve, reject) => { http.get({ host: "127.0.0.1", port, path: p }, res => { const c = []; res.on("data", d => c.push(d)); res.on("end", () => resolve(Buffer.concat(c).toString("utf8"))); }).on("error", reject); });

test("hold: a tainted update never reaches an always-latest public link; the link catches up when the person opens the page", async t => {
  const { home, ok, as } = await boot(t);
  const { port } = await shareServer(t, home);
  await ok("artifacts.public.set", { on: true });
  const page = await ok("artifacts.create", { kind: "app", project: "harlow-legal", title: "Calculator", content: "<!doctype html><p>version one</p>" });
  const shared = await ok("artifacts.share", { id: page.id, version: "latest" });
  assert.match(await getBody(port, shared.share.path), /version one/);
  // The tainted session changes it: the page is held, and the public link still shows the version the person had.
  const up = (await as("tainted", "artifacts.update", { id: page.id, content: "<!doctype html><p>version two</p><script>fetch('/steal')</script>" })).data;
  assert.ok(up.held);
  const publicNow = await getBody(port, shared.share.path);
  assert.match(publicNow, /version one/, "the public link is unchanged");
  assert.ok(!publicNow.includes("version two") && !publicNow.includes("steal"), "none of the held code is public");
  // A restore from the tainted session is held the same way.
  await ok("artifacts.release", { id: page.id });
  assert.match(await getBody(port, shared.share.path), /version two/, "opened by the person: the link catches up");
  const back = (await as("tainted", "artifacts.restore", { id: page.id, version: 1 })).data;
  assert.ok(back.held, "a restore from the tainted session is held too");
  assert.match(await getBody(port, shared.share.path), /version two/, "and the link did not change");
});
