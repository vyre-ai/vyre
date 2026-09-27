// @ts-check
// `--view` frames and `vyre commands --json`, the two shapes the Capsule, chat and the phone read
// (docs/reference/cli-json.md). The pure parts first, then the real bin/vyre in a temp home with
// no vyred, as the Capsule runs it: a child with pipes, no terminal, no colour asked for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";
import { derive, frame, done, verbWords, textLines, label, prompt, KINDS, ANSWERS } from "./view.js";
import { parseUsage, verbsOf, argsOf } from "./verbs.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, stdout: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, VYRE_NO_DIALOGS: "1", FORCE_COLOR: "1", NO_COLOR: "" }, timeout: 30_000 },
    (err, stdout) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, stdout })));

/** Every stdout line of a --view run, parsed; each must be a frame. @param {string} s */
const frames = s => s.trim().split("\n").map(l => JSON.parse(l));

test("view: derive draws rows as a table, one list in an object as a titled table, an object as a card", () => {
  const rows = [{ id: "d1", label: "alex's iPhone", seen: 3, tags: ["a", "b"], deep: { x: 1 } }, { id: "d2", label: "kit" }];
  const t = derive(rows);
  assert.equal(t.kind, "table");
  assert.deepEqual(t.columns.map(c => c.key), ["id", "label", "seen", "tags"], "nested objects stay in data, not columns");
  assert.equal(t.rows, rows);
  assert.equal(derive([]).empty, "Nothing here yet");
  const titled = derive({ box: "Northwind Bakery", devices: rows });
  assert.deepEqual([titled.kind, titled.title], ["table", "Box: Northwind Bakery"]);
  assert.deepEqual(derive({ devices: [] }), { kind: "table", title: "Devices", columns: [], rows: [], empty: "Nothing here yet" });
  const card = derive({ running: true, lastSeen: 5, names: ["juno", "kit"], nested: { a: 1 } });
  assert.equal(card.kind, "card");
  assert.deepEqual(card.fields, [{ label: "Running", value: "true" }, { label: "Last seen", value: "5" }, { label: "Names", value: "juno, kit" }, { label: "Nested", value: "{\"a\":1}" }]);
  assert.deepEqual(derive("two\nlines"), { kind: "text", lines: ["two", "lines"] });
  assert.deepEqual(derive({ error: { code: "bad_input", message: "no", next: "vyre help" } }), { kind: "error", code: "bad_input", message: "no", next: "vyre help" });
  assert.equal(label("last_seen_at"), "Last seen at");
  for (const k of ["table", "card", "text", "error"]) assert.ok(KINDS.includes(k));
});

test("view: a frame keeps the data as --json prints it, and a verb's own view wins", () => {
  const data = { url: "https://vyre.run/pair#x" };
  assert.deepEqual(frame("relay pair", data, { kind: "qr", text: data.url }), { v: 1, cmd: "relay pair", view: { kind: "qr", text: data.url }, data });
  assert.equal(frame("x", data).view.kind, "card");
  assert.equal(frame("x", undefined).data, null);
  assert.deepEqual(done(3), { v: 1, done: true, exit: 3 });
  assert.equal(verbWords("threads", ["--json", "list", "--all"]), "threads list");
  assert.equal(verbWords("send", ["./notes.txt"]), "send");
  assert.deepEqual(textLines(["\n\x1b[2m  hello\x1b[0m\r\n", "  world\n\n"]), ["  hello", "  world"]);
});

test("view: every prompt says where its answer goes", () => {
  assert.deepEqual(ANSWERS, ["word", "flag", "stdin", "confirm"]);
  assert.deepEqual(prompt({ name: "text", label: "New words", args: ["gate", "revise", "d1"], answer: "flag", flag: "text" }),
    { kind: "prompt", name: "text", label: "New words", args: ["gate", "revise", "d1"], answer: "flag", flag: "text" });
  assert.equal(prompt({ name: "key", label: "Key", args: ["voice", "key", "--stdin"], answer: "stdin" }).secret, true, "stdin answers are secret");
  assert.deepEqual(prompt({ name: "turn", label: "Which?", args: ["threads", "rewind", "t1"], answer: "word", choices: ["1", "2"] }).choices, ["1", "2"]);
  assert.throws(() => prompt({ name: "x", label: "x", args: [], answer: "maybe" }), /word, flag, stdin, confirm/);
  assert.throws(() => prompt({ name: "x", label: "x", args: [], answer: "flag" }), /names its flag/);
});

test("verbs: the usage grammar gives verbs, arguments, flags and choices", () => {
  const relay = parseUsage("vyre relay [status|pair|remove <id>|rename <id> <name>|trust <id> [--off]|on [--url u]] [--json]", "relay");
  assert.deepEqual(relay.map(v => v.verb), ["status", "pair", "remove", "rename", "trust", "on"]);
  assert.deepEqual(relay.find(v => v.verb === "rename")?.args, [{ name: "id", required: true }, { name: "name", required: true }]);
  assert.deepEqual(relay.find(v => v.verb === "trust")?.flags, [{ name: "off" }]);
  assert.deepEqual(relay.find(v => v.verb === "on")?.flags, [{ name: "url", value: "u" }]);
  assert.equal(relay.find(v => v.verb === "status")?.read, true);
  assert.equal(relay.find(v => v.verb === "pair")?.read, false);
  assert.deepEqual(parseUsage("vyre connect list|add|remove|test", "connect").map(v => v.verb), ["list", "add", "remove", "test"]);
  assert.deepEqual(parseUsage("vyre box add <user@host> | update | backup [file]", "box").map(v => [v.verb, v.args.map(a => a.required)]), [["add", [true]], ["update", []], ["backup", [false]]]);
  assert.deepEqual(parseUsage("vyre new [name]", "new"), [], "one bracketed word is an argument");
  assert.deepEqual(parseUsage("vyre send <file> [more files]", "send"), []);
  assert.deepEqual(argsOf(["<text...>", "--mode", "default|plan"]), { args: [{ name: "text", required: true, repeat: true }], flags: [{ name: "mode", value: "choice", choices: ["default", "plan"] }] });
  // A command's own list wins, and its usage fragment fills args and flags.
  const own = verbsOf({ name: "threads", usage: "vyre threads [start|send]", verbs: [{ verb: "model", usage: "<thread> [model]", summary: "see or switch", person: false }, { verb: "watch", usage: "<thread>" }] });
  assert.deepEqual(own[0], { verb: "model", summary: "see or switch", args: [{ name: "thread", required: true }, { name: "model", required: false }], flags: [], read: false });
  assert.equal(own[1].live, true);
  assert.equal(own[1].read, true);
});

test("vyre commands --json: every visible command with its verbs, before vyred runs", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  const r = await run(root, ["commands", "--json"]);
  assert.equal(r.code, 0, r.stdout);
  const d = JSON.parse(r.stdout);
  assert.equal(d.v, 1);
  const names = d.commands.map(c => c.name);
  for (const n of ["up", "threads", "vault", "relay", "phone", "commands"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("home"), "hidden commands only with --all");
  for (const c of d.commands) {
    assert.equal(typeof c.summary, "string", c.name);
    assert.equal(typeof c.group, "string", c.name);
    assert.ok(Array.isArray(c.verbs), c.name);
    for (const v of c.verbs) {
      assert.match(v.verb, /^[a-z][a-z.-]*$/, `${c.name} ${v.verb}`);
      assert.ok(Array.isArray(v.args) && Array.isArray(v.flags), `${c.name} ${v.verb}`);
    }
  }
  assert.deepEqual(d.commands.find(c => c.name === "relay").verbs.map(v => v.verb).slice(0, 3), ["status", "pair", "devices"]);
  assert.ok(JSON.parse((await run(root, ["commands", "--all", "--json"])).stdout).commands.some(c => c.name === "home"));
  const one = JSON.parse((await run(root, ["commands", "phone", "--json"])).stdout);
  assert.deepEqual(one.commands.map(c => c.name), ["phone"]);
  assert.equal((await run(root, ["commands", "nope"])).code, 2);
});

test("--view: frames only, a done frame with the exit code, and no colour even when asked", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  // A read with its own view.
  const c = frames((await run(root, ["commands", "--view"])).stdout);
  assert.deepEqual([c[0].v, c[0].cmd, c[0].view.kind, c[0].view.title], [1, "commands", "table", "Commands"]);
  assert.equal(c[0].data.v, 1, "data is what --json prints");
  assert.deepEqual(c.at(-1), { v: 1, done: true, exit: 0 });
  // A failure: an error frame, then done with the usual exit code (vyred is not running: 5).
  const s = await run(root, ["phone", "list", "--view"]);
  const f = frames(s.stdout);
  assert.equal(f[0].view.kind, "error");
  assert.equal(f[0].view.code, "unreachable");
  assert.match(f[0].view.next, /vyre up/);
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: s.code });
  // A usage mistake is exit 2 in a frame.
  const u = await run(root, ["commands", "a", "b", "--view"]);
  assert.equal(u.code, 2);
  assert.equal(frames(u.stdout)[0].view.code, "bad_input");
});

test("--view: a verb with no JSON still answers, its words as one text frame without colour", async t => {
  const { viewRun } = await import("./index.js");
  const { out } = await import("./style.js");
  const lines = [];
  const write = process.stdout.write;
  t.after(() => { process.stdout.write = write; });
  process.stdout.write = /** @type {any} */ (chunk => { lines.push(String(chunk)); return true; });
  let seen;
  const code = await viewRun({ name: "juno", summary: "a test command", async run(args) { seen = args; out("\x1b[2m  Harlow Legal\x1b[0m"); out("  kit"); return 0; } }, ["show", "--view", "--", "--view"]);
  process.stdout.write = write;
  assert.equal(code, 0);
  assert.deepEqual(seen, ["show", "--json", "--", "--view"], "--view goes, --json comes, words after -- stay");
  const f = lines.join("").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(f, [{ v: 1, cmd: "juno show", view: { kind: "text", lines: ["  Harlow Legal", "  kit"] }, data: null }, { v: 1, done: true, exit: 0 }]);
});
