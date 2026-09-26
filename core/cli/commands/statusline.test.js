// @ts-check
// `vyre statusline install|uninstall` and the installed script, in a temp home with a temp
// CLAUDE_CONFIG_DIR. Never the real ~/.claude: every call passes its own env.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { install, uninstall, offerStatusline, ours, settingsPath } from "./statusline.js";
import { tempHome } from "../../../test/helpers.js";

const noTty = { tty: false, ask: async () => "" };
const says = answer => ({ tty: true, asked: /** @type {string[]} */ ([]), async ask(q) { this.asked.push(q); return answer; } });

function setup(t, settings) {
  const home = tempHome(t);
  const claude = path.join(home, "claude-config");
  fs.mkdirSync(claude);
  const env = { CLAUDE_CONFIG_DIR: claude };
  const file = settingsPath(env);
  assert.equal(file, path.join(claude, "settings.json"));
  if (settings !== undefined) fs.writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings, null, 2) + "\n");
  const lines = [];
  t.mock.method(console, "log", (...a) => { lines.push(a.join(" ")); });
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  /** Run the installed script as Claude Code would, with its JSON on stdin. */
  const run = (input = '{"model":{"display_name":"Opus"}}') =>
    execFileSync("sh", ["-c", read().statusLine.command], { input, encoding: "utf8" });
  return { home, env, file, read, run, text: () => lines.join("\n") };
}

const THEIRS = { type: "command", command: "echo hi", padding: 1 };

test("install: no status line yet, --yes installs it, keeps every other key, and the script prints the line", async t => {
  const s = setup(t, { theme: "dark", permissions: { allow: ["Bash(ls)"] } });
  assert.equal(await install(["--yes"], { env: s.env, home: s.home, io: noTty }), 0);
  const got = s.read();
  assert.deepEqual(got, { theme: "dark", permissions: { allow: ["Bash(ls)"] }, statusLine: { type: "command", command: ours(s.home), padding: 0 } });
  assert.match(fs.readFileSync(s.file, "utf8"), /^\{\n {2}"theme": "dark",/, "2-space JSON");
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file + ".vyre-backup", "utf8")), { theme: "dark", permissions: { allow: ["Bash(ls)"] } });
  assert.equal(fs.readFileSync(path.join(s.home, "statusline.sh"), "utf8").includes("@VYRE_HOME@"), false, "home baked in");

  assert.equal(s.run(), "", "no file yet: nothing");
  fs.writeFileSync(path.join(s.home, "statusline"), `${process.pid}\nvyre · juno idle\n`);
  assert.equal(s.run(), "vyre · juno idle\n");
  assert.equal(execFileSync("sh", ["-c", s.read().statusLine.command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), "vyre · juno idle\n", "needs no stdin");
  const dead = spawnSync("true").pid;
  fs.writeFileSync(path.join(s.home, "statusline"), `${dead}\nvyre · juno idle\n`);
  assert.equal(s.run(), "", "a dead vyred's line is not shown");
  fs.writeFileSync(path.join(s.home, "statusline"), `0\nvyre\n`);
  assert.equal(s.run(), "", "pid 0 is not a pid");

  assert.equal(await install(["--yes"], { env: s.env, home: s.home, io: noTty }), 0);
  assert.match(s.text(), /already installed/);
});

test("install: no settings.json at all creates it; no TTY and no --yes changes nothing", async t => {
  const s = setup(t);
  assert.equal(await install([], { env: s.env, home: s.home, io: noTty }), 0);
  assert.match(s.text(), /would set Claude Code's status line/);
  assert.equal(fs.existsSync(s.file), false);
  const io = says("y");
  assert.equal(await install([], { env: s.env, home: s.home, io }), 0);
  assert.equal(io.asked.length, 1);
  assert.equal(s.read().statusLine.command, ours(s.home));
  assert.equal(fs.existsSync(s.file + ".vyre-backup"), false, "nothing to back up");
});

test("install: a no at the prompt changes nothing", async t => {
  const s = setup(t, { theme: "dark" });
  assert.equal(await install([], { env: s.env, home: s.home, io: says("") }), 0);
  assert.deepEqual(s.read(), { theme: "dark" });
});

test("install: someone else's status line gets an offer, and --chain keeps it above ours; uninstall puts it back", async t => {
  const s = setup(t, { statusLine: THEIRS, model: "opus" });
  assert.equal(await install(["--yes"], { env: s.env, home: s.home, io: noTty }), 0);
  assert.match(s.text(), /you already have a status line; vyre statusline install --chain keeps it/);
  assert.deepEqual(s.read().statusLine, THEIRS, "unchanged without --chain");

  assert.equal(await install(["--chain", "--yes"], { env: s.env, home: s.home, io: noTty }), 0);
  assert.equal(s.read().statusLine.command, ours(s.home));
  assert.equal(s.read().model, "opus");
  assert.equal(fs.readFileSync(path.join(s.home, "statusline.prev"), "utf8"), "echo hi\n");
  assert.equal(s.run(), "hi\n", "theirs alone while vyred has no line");
  fs.writeFileSync(path.join(s.home, "statusline"), `${process.pid}\nvyre · box ok\n`);
  assert.equal(s.run(), "hi\nvyre · box ok\n");
  // Their command gets Claude Code's stdin.
  fs.writeFileSync(path.join(s.home, "statusline.prev"), "cat\n");
  assert.equal(s.run('{"a":1}'), '{"a":1}\nvyre · box ok\n');

  assert.equal(await uninstall({ env: s.env, home: s.home }), 0);
  assert.deepEqual(s.read(), { statusLine: THEIRS, model: "opus" });
  for (const f of ["statusline.sh", "statusline.prev", "statusline.prev.json"]) assert.equal(fs.existsSync(path.join(s.home, f)), false, f);
});

test("uninstall: removes ours; leaves someone else's; says when there is none", async t => {
  const s = setup(t, { theme: "dark" });
  assert.equal(await uninstall({ env: s.env, home: s.home }), 0);
  assert.match(s.text(), /no status line is installed/);
  await install(["--yes"], { env: s.env, home: s.home, io: noTty });
  assert.equal(await uninstall({ env: s.env, home: s.home }), 0);
  assert.deepEqual(s.read(), { theme: "dark" });
  fs.writeFileSync(s.file, JSON.stringify({ statusLine: THEIRS }));
  assert.equal(await uninstall({ env: s.env, home: s.home }), 0);
  assert.match(s.text(), /not Vyre's, so it stays/);
  assert.deepEqual(s.read(), { statusLine: THEIRS });
});

test("install and uninstall refuse a settings.json that does not parse", async t => {
  const s = setup(t, '{ "theme": "dark", ');
  assert.equal(await install(["--yes"], { env: s.env, home: s.home, io: noTty }), 1);
  assert.equal(await uninstall({ env: s.env, home: s.home }), 1);
  assert.match(s.text(), /does not parse/);
  assert.equal(fs.readFileSync(s.file, "utf8"), '{ "theme": "dark", ');
  assert.equal(fs.existsSync(path.join(s.home, "statusline.sh")), false);
});

test("install: writes through a symlinked settings.json", async t => {
  const s = setup(t);
  const real = path.join(s.home, "dotfiles-settings.json");
  fs.writeFileSync(real, JSON.stringify({ theme: "dark" }));
  fs.symlinkSync(real, s.file);
  assert.equal(await install(["--yes"], { env: s.env, home: s.home, io: noTty }), 0);
  assert.equal(fs.lstatSync(s.file).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(real, "utf8")).statusLine.command, ours(s.home));
});

test("offerStatusline: asks once, remembers a no, points at --chain, and is quiet once installed", async t => {
  const s = setup(t, { theme: "dark" });
  assert.equal(await offerStatusline({ interactive: false, env: s.env, home: s.home, io: noTty }), "offered");
  assert.match(s.text(), /vyre statusline install/);
  assert.equal(await offerStatusline({ interactive: true, env: s.env, home: s.home, io: says("n") }), "declined");
  assert.equal(await offerStatusline({ interactive: true, env: s.env, home: s.home, io: says("y") }), "skipped", "a no is remembered");
  fs.rmSync(path.join(s.home, "statusline.declined"));
  assert.equal(await offerStatusline({ interactive: true, env: s.env, home: s.home, io: says("y") }), "installed");
  assert.equal(await offerStatusline({ interactive: true, env: s.env, home: s.home, io: says("y") }), "skipped");
  fs.writeFileSync(s.file, JSON.stringify({ statusLine: THEIRS }));
  assert.equal(await offerStatusline({ interactive: true, env: s.env, home: s.home, io: says("y") }), "offered");
  assert.match(s.text(), /install --chain/);
  assert.equal(await offerStatusline({ interactive: true, env: { CLAUDE_CONFIG_DIR: path.join(s.home, "nope") }, home: s.home, io: says("y") }), "skipped", "no Claude Code, no offer");
});
