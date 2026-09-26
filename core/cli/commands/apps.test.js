// @ts-check
// `vyre apps` over fake deps: no vyred is started and no home is touched. What the words become,
// which tool each path calls, that a send goes through the person's proof after its preview is
// shown, and how results print.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, runApps, formatApps, formatTargets, USAGE } from "./apps.js";

/**
 * Fake deps: answers by tool name, and records every call and printed line.
 * @param {Record<string, any>} answers tool -> data, or { error }
 */
function fake(answers) {
  /** @type {{ tool: string, input: any, as: string }[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  const answer = (/** @type {string} */ tool) => {
    const a = answers[tool];
    if (a === undefined) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    return a && a.error ? a : { data: typeof a === "function" ? a() : a };
  };
  return {
    calls, lines,
    deps: {
      call: async (/** @type {string} */ tool, /** @type {any} */ input) => { calls.push({ tool, input, as: "call" }); return answer(tool); },
      person: async (/** @type {string} */ tool, /** @type {any} */ input) => { calls.push({ tool, input, as: "person" }); return answer(tool); },
      up: async () => true,
      print: (/** @type {string} */ l) => { lines.push(l.replace(/\x1b\[[0-9;]*m/g, "")); },
    },
  };
}

test("apps cli: arguments split into a subcommand, words and flags", () => {
  assert.deepEqual(parseArgs(["timer", "10", "min"]), { sub: null, words: ["timer", "10", "min"], flags: { json: false, help: false, model: false, app: null } });
  assert.deepEqual(parseArgs(["find", "note", "--json"]).sub, "find");
  assert.deepEqual(parseArgs(["--app", "Notes", "buy", "milk"]).flags.app, "Notes");
  assert.deepEqual(parseArgs(["--app=WhatsApp", "juno:", "hi", "--model"]).flags, { json: false, help: false, model: true, app: "WhatsApp" });
  assert.deepEqual(parseArgs(["--", "--json", "is", "text"]).words, ["--json", "is", "text"]);
  assert.equal(parseArgs(["Setup", "clock"]).sub, "setup");
});

test("apps cli: --help prints the usage without reaching vyred", async () => {
  const f = fake({});
  let asked = false;
  assert.equal(await runApps(["--help"], { ...f.deps, up: async () => { asked = true; return true; } }), 0);
  assert.equal(asked, false);
  assert.equal(f.lines[0], USAGE);
});

test("apps cli: words are routed, then acted on, and the one line is printed", async () => {
  const route = { app: "Clock", action: "timer", args: { seconds: 600 }, sends: false, said: "Timer for 10 minutes" };
  const f = fake({ "apps.route": route, "apps.act": { said: "Timer set for 10 minutes", seconds: 600 } });
  assert.equal(await runApps(["timer", "10", "min"], f.deps), 0);
  assert.deepEqual(f.calls, [
    { tool: "apps.route", input: { text: "timer 10 min" }, as: "call" },
    { tool: "apps.act", input: { app: "Clock", action: "timer", args: { seconds: 600 } }, as: "call" },
  ]);
  assert.deepEqual(f.lines, ["  ● Timer set for 10 minutes"]);
});

test("apps cli: a send shows its preview first, then goes through the person's proof", async () => {
  const route = { app: "WhatsApp", action: "send", args: { to: "juno", text: "running late" }, sends: true, said: "WhatsApp → juno: running late" };
  const f = fake({ "apps.route": route, "apps.send": { said: "Sent to juno" } });
  assert.equal(await runApps(["whatsapp", "juno:", "running", "late"], f.deps), 0);
  assert.deepEqual(f.calls.map(c => [c.tool, c.as]), [["apps.route", "call"], ["apps.send", "person"]]);
  assert.deepEqual(f.lines, ["  WhatsApp → juno: running late", "  ● Sent to juno"]);
});

test("apps cli: a refused proof, an ambiguous route and a setup error print in words and exit 1", async () => {
  const route = { app: "WhatsApp", action: "send", args: { to: "juno", text: "hi" }, sends: true, said: "WhatsApp → juno: hi" };
  const refused = fake({ "apps.route": route, "apps.send": { error: { code: "no_terminal", message: "this needs a person at a terminal" } } });
  assert.equal(await runApps(["whatsapp", "juno:", "hi"], refused.deps), 1);
  assert.equal(refused.lines.at(-1), "  no_terminal: this needs a person at a terminal");

  const unsure = fake({ "apps.route": { ambiguous: true, reason: "Vyre does not know what \"banana\" should do" } });
  assert.equal(await runApps(["banana"], unsure.deps), 1);
  assert.deepEqual(unsure.lines, ["  not sure: Vyre does not know what \"banana\" should do"]);
  assert.equal(unsure.calls.length, 1, "an ambiguous route ran something");

  const setup = fake({ "apps.route": { app: "Clock", action: "timer", args: { seconds: 60 }, sends: false, said: "x" },
    "apps.act": { error: { code: "setup", message: "Clock needs Vyre's Timer shortcut, once: run \"vyre apps setup clock\" (the apps.setup tool)" } } });
  assert.equal(await runApps(["timer", "1", "min"], setup.deps), 1);
  assert.match(setup.lines[0], /^  setup: Clock needs .*vyre apps setup clock/);

  const down = fake({ "apps.route": { error: { code: "unreachable", message: "no socket" } } });
  assert.equal(await runApps(["timer", "1", "min"], down.deps), 1);
  assert.match(down.lines[0], /vyred is not running/);
});

test("apps cli: --app and --model reach apps.route; --json prints vyred's answer", async () => {
  const f = fake({ "apps.route": { app: "Notes", action: "create", args: { text: "buy milk" }, sends: false, said: "Note: buy milk" },
    "apps.act": { said: "Note saved: buy milk", id: "n1", title: "buy milk" } });
  assert.equal(await runApps(["--app", "Notes", "--model", "--json", "buy", "milk"], f.deps), 0);
  assert.deepEqual(f.calls[0].input, { text: "buy milk", app: "Notes", model: true });
  assert.deepEqual(JSON.parse(f.lines.join("\n")), { said: "Note saved: buy milk", id: "n1", title: "buy milk" });
});

test("apps cli: list, find, targets and setup call their tools and print columns", async () => {
  const apps = { apps: [{ name: "Clock", tier: "intents", bundleId: "com.apple.clock" }, { name: "Northwind Bakery POS", tier: "ax", bundleId: null }] };
  const f = fake({ "apps.list": apps, "apps.targets": { targets: [{ id: "L2", title: "Harlow Legal", kind: "list" }] },
    "apps.setup": { ready: false, steps: ["Add each one once."], files: ["/tmp/h/Vyre Timer.shortcut"] } });
  assert.equal(await runApps([], f.deps), 0);
  assert.equal(await runApps(["find", "bakery"], f.deps), 0);
  assert.equal(await runApps(["targets", "Reminders", "harl"], f.deps), 0);
  assert.equal(await runApps(["setup", "clock"], f.deps), 0);
  assert.deepEqual(f.calls.map(c => [c.tool, c.input]), [
    ["apps.list", { limit: 100 }], ["apps.list", { q: "bakery" }], ["apps.targets", { app: "Reminders", q: "harl" }], ["apps.setup", { app: "clock" }],
  ]);
  assert.deepEqual(f.lines.slice(0, 2), ["  Clock                 intents  com.apple.clock", "  Northwind Bakery POS  ax"]);
  assert.ok(f.lines.includes("  Harlow Legal  list  L2"));
  assert.ok(f.lines.includes("  Add each one once."));
  assert.equal(await runApps(["targets"], f.deps), 1);
  assert.deepEqual(formatApps([]), ["  no apps found"]);
  assert.deepEqual(formatTargets([], "Clock"), ["  nothing to pick in Clock"]);
});
