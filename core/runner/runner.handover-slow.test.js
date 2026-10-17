import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import "./testing/require-sandbox.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { plan, seatbeltProfile } from "./sandbox.js";
import { rig, waitFor, SKIP, sleep, procState, LINUX, PLUGIN_FLAG, HARNESS_MARK, SCRATCH, rm } from "./runner-test-lib.js";

test("runner: a server that never answers a hand-over leaves the session running, not frozen for ever", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  const r = await rig(t, { requestServer: () => new Promise(() => {}), handoverMs: 400 });
  const h = await r.launch(r.runner, "s1");
  h.send("turn a");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  await assert.rejects(r.runner.moveToServer("s1", "lid-closed"), /did not answer/);
  await waitFor(() => procState(h.pid) !== "T");
  assert.deepEqual(r.runner.status().sessions, ["s1"]);
  // and the next hand-over can be asked: the first left nothing set
  await assert.rejects(r.runner.moveToServer("s1", "lid-closed"), /did not answer/);
});

test("runner: a hand-over the home holds back, or that fails, does not wake a session the person paused", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  let answer = /** @type {() => any} */ (() => ({ moved: false, why: "cooldown" }));
  const r = await rig(t, { requestServer: () => answer(), handoverMs: 400 });
  const h = await r.launch(r.runner, "s1");
  r.runner.pause(); await waitFor(() => procState(h.pid) === "T");
  assert.deepEqual(await r.runner.moveToServer("s1", "lid-closed"), { moved: false, why: "cooldown" });
  await sleep(300);
  assert.equal(procState(h.pid), "T", "Pause all stands after a refused hand-over");
  answer = () => new Promise(() => {});
  await assert.rejects(r.runner.moveToServer("s1", "lid-closed"), /did not answer/);
  await sleep(300);
  assert.equal(procState(h.pid), "T", "and after one that never answered");
  r.runner.resume();
  await waitFor(() => procState(h.pid) !== "T");
});

test("a folder of the computer the person approved becomes the session's own folder: read and write on the Mac, bound over the workspace's files on Linux, and never the home folder or one that holds a secret", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "fp-"))); const home = path.join(dir, "home"), proj = path.join(home, "acme"); fs.mkdirSync(proj, { recursive: true });
  try {
    const mac = seatbeltProfile({ platform: "darwin", workspace: path.join(dir, "ws"), command: process.execPath, readOnly: [path.dirname(process.execPath)], proxy: { port: 4567 }, folder: proj, home });
    assert.ok(mac.includes(`(allow file-read* file-write* (subpath ${JSON.stringify(proj)}))`) && mac.includes(`(allow process-exec (subpath ${JSON.stringify(proj)}))`));
    const p = plan({ platform: "darwin", workspace: path.join(dir, "ws"), command: process.execPath, readOnly: [path.dirname(process.execPath)], proxy: { port: 4567 }, folder: proj, home });
    assert.equal(p.cwd, proj, "the program starts in the person's folder");
    assert.throws(() => seatbeltProfile({ platform: "darwin", workspace: path.join(dir, "ws"), command: process.execPath, readOnly: [path.dirname(process.execPath)], proxy: { port: 4567 }, folder: home, home }), /home folder/);
    fs.mkdirSync(path.join(proj, ".ssh"));
    assert.throws(() => seatbeltProfile({ platform: "darwin", workspace: path.join(dir, "ws"), command: process.execPath, readOnly: [path.dirname(process.execPath)], proxy: { port: 4567 }, folder: proj, home }), /\.ssh/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("seatbelt: the session may see that its door to Vyre exists (a hook checks VYRE_SOCKET before it trusts it), and open only that socket", () => {
  const sock = "/private/var/folders/zz/T/vyre-door-abc.sock";
  const p = seatbeltProfile({ platform: "darwin", workspace: "/tmp/ws", command: process.execPath, readOnly: [path.dirname(process.execPath)], proxy: { port: 4567 }, vyre: { socket: sock } });
  assert.match(p, new RegExp(`\\(allow network-outbound \\(remote unix-socket \\(path-literal "${sock}"\\)\\)\\)`));
  for (const d of [sock, "/private/var/folders/zz/T", "/private/var/folders/zz", "/private/var/folders"]) assert.ok(p.includes(`(allow file-read-metadata (literal "${d}"))`), d);
  assert.ok(!p.includes('(allow file-read* (subpath "/private/var/folders'), "a stat, never a read or a listing");
});

test("runner: a chat's session gets a door to Vyre (VYRE_SOCKET) that asks the home, and a Vyre folder the sandbox will not bind leaves the session running without it, said in an event", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  /** @type {any[]} */ const events = [];
  const r = await rig(t, { onEvent: e => events.push(e) });
  const root = fs.mkdtempSync(path.join(SCRATCH, "vyre-root-")); t.after(() => rm(root));
  fs.mkdirSync(path.join(root, "harness", "mcp"), { recursive: true }); fs.writeFileSync(path.join(root, "harness", "mcp", "run.js"), "");
  /** @type {any[]} */ const asked = [];
  fs.mkdirSync(path.join(root, "harness", "hooks"), { recursive: true }); fs.writeFileSync(path.join(root, "harness", "hooks", "run.js"), "");
  const door = { call: async (/** @type {any} */ q) => { asked.push(q); return { status: 200, body: JSON.stringify({ data: "from the home" }) }; }, entry: path.join(root, "harness", "mcp", "run.js"), root, plugin: path.join(root, "harness") };
  const h = await r.launch(r.runner, "sd", { vyre: door, moreArgs: ["--verbose", PLUGIN_FLAG, HARNESS_MARK] });
  const lines = []; h.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) lines.push(JSON.parse(l)); });
  h.send("vyre records.list {\"a\":1}");
  const said = await waitFor(() => lines.find(e => e.type === "vyre"));
  assert.deepEqual([said.reply.status, JSON.parse(said.reply.body).data], [200, "from the home"]);
  assert.deepEqual([asked[0].method, asked[0].path, asked[0].body, asked[0].caller], ["POST", "/v1/tools/records.list", "{\"a\":1}", "mcp"]);
  h.send("argv");
  const argv = await waitFor(() => lines.find(e => e.type === "argv"));
  assert.equal(argv.socket, "/run/vyre.sock");
  assert.ok(argv.argv.includes("--mcp-config"));
  // the box's Harness is named by the mark; with the door up the lender's copy of it loads in its place, and the hooks have the door too
  const at = argv.argv.indexOf(PLUGIN_FLAG);
  assert.ok(at >= 0 && argv.argv[at + 1] === path.join(root, "harness") && !argv.argv.includes(HARNESS_MARK), JSON.stringify(argv.argv));
  h.send("env VYRE_THREAD");
  assert.equal((await waitFor(() => lines.find(e => e.type === "env"))).value, "sd", "Vyre's own session, as on the box");
  // a folder that holds a person's secret folder is never bound: no door, the session still runs
  const bad = fs.mkdtempSync(path.join(SCRATCH, "vyre-bad-")); t.after(() => rm(bad));
  fs.mkdirSync(path.join(bad, ".ssh")); fs.mkdirSync(path.join(bad, "harness", "mcp"), { recursive: true }); fs.writeFileSync(path.join(bad, "harness", "mcp", "run.js"), "");
  const h2 = await r.launch(r.runner, "se", { vyre: { ...door, entry: path.join(bad, "harness", "mcp", "run.js"), root: bad }, moreArgs: ["--verbose", PLUGIN_FLAG, HARNESS_MARK] });
  const lines2 = []; h2.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) lines2.push(JSON.parse(l)); });
  h2.send("argv");
  const argv2 = await waitFor(() => lines2.find(e => e.type === "argv"));
  assert.equal(argv2.socket, null, "no door");
  assert.ok(!argv2.argv.includes(PLUGIN_FLAG) && !argv2.argv.includes(HARNESS_MARK) && argv2.argv.includes("--verbose"), "and no plugin flag left without a value or a door: " + JSON.stringify(argv2.argv));
  assert.ok(events.some(e => e.type === "vyre-unavailable" && e.session === "se"), "and the person's side is told");
});

test("runner: thawing a reason nobody froze for sends no signal; a session stopped by the machine's teardown says so, not that the person stopped it", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  /** @type {any[]} */ const ended = [];
  const r = await rig(t, { onEvent: e => { if (e.type === "stopped") ended.push(e.why); } });
  const h = await r.launch(r.runner, "s1");
  r.runner.pause(); await waitFor(() => procState(h.pid) === "T");
  r.runner.thaw("offline");   // never frozen for that: the person's pause stands
  await sleep(200);
  assert.equal(procState(h.pid), "T");
  r.runner.resume();
  await r.runner.stopAll();
  assert.deepEqual(ended, ["teardown"]);
});
