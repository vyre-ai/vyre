// @ts-check
// `vyre apps` over fake deps: no vyred is started and no home is touched. What the words become,
// which tool each path calls, that a send goes through the person's proof after its preview is
// shown, and how results print.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../../test/helpers.js";
import { parseArgs, runApps, formatApps, formatTargets, pick, promptFor, USAGE, ASKED } from "./apps.js";

/**
 * Fake deps: answers by tool name, and records every call and printed line.
 * @param {Record<string, any>} answers tool -> data, or { error }
 */
function fake(answers) {
  /** @type {{ tool: string, input: any, as: string }[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const errs = [];
  const answer = (/** @type {string} */ tool, /** @type {any} */ input) => {
    const a = answers[tool];
    if (a === undefined) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    const v = typeof a === "function" ? a(input) : a;
    return v && v.error ? v : { data: v };
  };
  return {
    calls, lines, errs,
    deps: {
      call: async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ opts) => { calls.push({ tool, input, as: "call", ...(opts ? { opts } : {}) }); return answer(tool, input); },
      person: async (/** @type {string} */ tool, /** @type {any} */ input) => { calls.push({ tool, input, as: "person" }); return answer(tool, input); },
      up: async () => true,
      print: (/** @type {string} */ l) => { lines.push(l.replace(/\x1b\[[0-9;]*m/g, "")); },
      warn: (/** @type {string} */ l) => { errs.push(l); },
    },
  };
}

test("apps cli: arguments split into a subcommand, words and flags", () => {
  assert.deepEqual(parseArgs(["timer", "10", "min"]), { sub: null, words: ["timer", "10", "min"], flags: { json: false, help: false, model: false, app: null, to: null }, error: null });
  assert.deepEqual(parseArgs(["find", "note", "--json"]).sub, "find");
  assert.deepEqual(parseArgs(["--app", "Notes", "buy", "milk"]).flags.app, "Notes");
  assert.deepEqual(parseArgs(["--app=WhatsApp", "juno:", "hi", "--model"]).flags, { json: false, help: false, model: true, app: "WhatsApp", to: null });
  assert.deepEqual(parseArgs(["--", "--json", "is", "text"]).words, ["--json", "is", "text"]);
  assert.equal(parseArgs(["Setup", "clock"]).sub, "setup");
  assert.deepEqual(parseArgs(["--", "list", "of", "groceries"]), { sub: null, words: ["list", "of", "groceries"], flags: { json: false, help: false, model: false, app: null, to: null }, error: null });
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
  assert.deepEqual(f.calls[3].opts, { timeout: 180_000 }, "setup signs twice with Apple and needs longer");
  assert.deepEqual(f.lines.slice(0, 2), ["  Clock                 intents  com.apple.clock", "  Northwind Bakery POS  ax"]);
  assert.ok(f.lines.includes("  Harlow Legal  list  L2"));
  assert.ok(f.lines.includes("  Add each one once."));
  assert.equal(await runApps(["targets"], f.deps), 1);
  assert.deepEqual(formatApps([]), ["  no apps found"]);
  assert.deepEqual(formatTargets([], "Clock"), ["  nothing to pick in Clock"]);
});

test("apps cli: --app without a name, or an unknown flag, is a usage error with exit 2", async () => {
  for (const args of [["--app"], ["--app", "--json", "hi"], ["--app="], ["--verbose", "timer", "1", "min"], ["-x", "hi"]]) {
    const f = fake({});
    assert.equal(await runApps(args, f.deps), 2, args.join(" "));
    assert.equal(f.calls.length, 0);
    assert.ok(f.errs.some(l => l.includes("vyre apps <words...>")), "no usage shown");
  }
  assert.match(String(parseArgs(["--app"]).error), /needs an app name/);
});

test("apps cli: with --json a send's preview goes to stderr before the proof, and stdout holds only JSON", async () => {
  const route = { app: "WhatsApp", action: "send", args: { to: "juno", text: "hi" }, sends: true, said: "WhatsApp → juno: hi" };
  /** @type {string[]} */
  const order = [];
  const f = fake({ "apps.route": route, "apps.send": { said: "Sent to juno" } });
  const deps = { ...f.deps,
    warn: (/** @type {string} */ l) => { order.push("warn"); f.errs.push(l); },
    person: async (/** @type {string} */ tool, /** @type {any} */ input) => { order.push("proof"); return f.deps.person(tool, input); } };
  assert.equal(await runApps(["--json", "whatsapp", "juno:", "hi"], deps), 0);
  assert.deepEqual(order, ["warn", "proof"]);
  assert.deepEqual(f.errs, ["  WhatsApp → juno: hi"]);
  assert.deepEqual(JSON.parse(f.lines.join("\n")), { said: "Sent to juno" });
});

// ---- Questions: an unclear app or recipient is asked about, never dropped -------------------

const WHO = { ambiguous: true, reason: "who is the WhatsApp message for?", ask: "Who should get this?", text: "dinner at 8?", app: "WhatsApp", action: "send", to: "ammi",
  needs: { recipient: [{ id: "c3", title: "alex", app: "WhatsApp", score: 0.9 }, { id: "c9", title: "kit", app: "WhatsApp", score: 0.7 }] },
  didYouMean: "Did you mean alex on WhatsApp?" };
const WHICH = { ambiguous: true, reason: "which app should this go through?", ask: "Which app?", text: "I'm running late", action: "send", to: "juno",
  needs: { app: [{ name: "WhatsApp", hint: "Vyre sends through it" }, { name: "Messages", hint: "installed; Vyre cannot send through it yet" }] } };
/** The route vyred gives once the person has picked. @param {string} app @param {string} to @param {string} text */
const picked = (app, to, text) => ({ app, action: "send", args: { to, text }, sends: true, said: `${app} → ${to}: ${text}` });

/** A terminal that answers with these lines, in order. @param {string[]} answers */
const terminal = answers => ({ isTTY: true, asked: /** @type {string[]} */ ([]), async ask(/** @type {string} */ q) { this.asked.push(q); return answers.length ? /** @type {string} */ (answers.shift()) : null; } });

test("apps cli: with no terminal a question is printed with its candidates and exits 3; --json prints its shape", async () => {
  const f = fake({ "apps.route": WHO });
  assert.equal(await runApps(["whatsapp", "alx:", "dinner", "at", "8?"], f.deps), ASKED);
  assert.equal(ASKED, 3);
  assert.deepEqual(f.lines.slice(0, 4), ["  Who should get this? · dinner at 8?", "  Did you mean alex on WhatsApp?", "   1  alex", "   2  kit"]);
  assert.equal(f.calls.length, 1, "nothing but the route ran");

  const j = fake({ "apps.route": WHO });
  assert.equal(await runApps(["--json", "whatsapp", "alx:", "dinner", "at", "8?"], { ...j.deps, ...terminal(["1"]) }), ASKED, "--json never prompts");
  assert.deepEqual(JSON.parse(j.lines.join("\n")), WHO);
});

test("apps cli: on a terminal Enter takes the Did you mean, then the send is previewed and proved", async () => {
  const f = fake({ "apps.route": (/** @type {any} */ i) => (i.to ? picked(i.app, i.to, i.text) : WHO), "apps.send": { said: "Sent to alex" } });
  const tty = terminal(["", ""]);
  assert.equal(await runApps(["whatsapp", "alx:", "dinner", "at", "8?"], { ...f.deps, ...tty }), 0);
  assert.deepEqual(tty.asked, ["  pick one (Enter for the first): ", "  Enter to send, n to cancel: "]);
  assert.deepEqual(f.calls.map(c => [c.tool, c.as]), [["apps.route", "call"], ["apps.route", "call"], ["apps.send", "person"]]);
  assert.deepEqual(f.calls[1].input, { text: "dinner at 8?", app: "WhatsApp", to: "c3" }, "the id goes back, not the name");
  assert.deepEqual(f.calls[2].input, { app: "WhatsApp", action: "send", args: { to: "c3", text: "dinner at 8?" } });
  assert.deepEqual(f.lines.slice(-2), ["  WhatsApp → c3: dinner at 8?", "  ● Sent to alex"]);
});

test("apps cli: an unclear app is asked, then who; a number out of range asks again", async () => {
  const routes = [WHICH, { ...WHO, didYouMean: undefined, needs: { recipient: [{ id: "c1", title: "Juno Park", app: "WhatsApp", score: 0.9 }, { id: "c2", title: "Jules", app: "WhatsApp", score: 0.8 }] }, text: "I'm running late", to: "juno" }];
  const f = fake({ "apps.route": (/** @type {any} */ i) => routes.length ? routes.shift() : picked(i.app, i.to, i.text), "apps.send": { said: "Sent" } });
  const tty = terminal(["1", "7", "juno park", ""]);
  assert.equal(await runApps(["tell", "juno", "I'm", "running", "late"], { ...f.deps, ...tty }), 0);
  assert.deepEqual(f.calls.filter(c => c.tool === "apps.route").map(c => c.input), [
    { text: "tell juno I'm running late" },
    { text: "I'm running late", app: "WhatsApp", to: "juno" },
    { text: "I'm running late", app: "WhatsApp", to: "c1" },
  ]);
  assert.ok(f.lines.includes("  there is no 7 in the list"));
  assert.ok(f.lines.includes("  WhatsApp → c1: I'm running late"));
});

test("apps cli: an empty answer with no Did you mean, no, a closed terminal, or n at the preview sends nothing", async () => {
  for (const [answers, dym] of /** @type {[string[], any][]} */ ([[[""], undefined], [["no"], WHO.didYouMean], [[], WHO.didYouMean], [["", "n"], WHO.didYouMean], [["", ], WHO.didYouMean]])) {
    const f = fake({ "apps.route": (/** @type {any} */ i) => (i.to ? picked(i.app, i.to, i.text) : { ...WHO, didYouMean: dym }), "apps.send": { said: "Sent" } });
    assert.equal(await runApps(["whatsapp", "alx:", "dinner"], { ...f.deps, ...terminal(answers) }), 1);
    assert.equal(f.lines.at(-1), "  nothing sent");
    assert.equal(f.calls.some(c => c.tool === "apps.send"), false);
  }
});

test("apps cli: questions stop after three rounds", async () => {
  const f = fake({ "apps.route": { ...WHO, didYouMean: undefined, needs: { recipient: [] } } });
  const tty = terminal(["zed", "zed", "zed", "zed"]);
  assert.equal(await runApps(["whatsapp", "zed:", "hi"], { ...f.deps, ...tty }), 1);
  assert.equal(tty.asked.length, 3);
  assert.equal(f.lines.at(-1), "  not sure: who is the WhatsApp message for?");
  assert.ok(f.lines.includes("  no one to pick from in WhatsApp; type a name"));
});

test("apps cli: pick reads a number, a name from the list, yes, or a new name", () => {
  assert.deepEqual(pick(WHO, "2"), { text: "dinner at 8?", app: "WhatsApp", to: "c9" });
  assert.deepEqual(pick(WHO, "yes"), { text: "dinner at 8?", app: "WhatsApp", to: "c3" });
  assert.deepEqual(pick(WHO, "KIT"), { text: "dinner at 8?", app: "WhatsApp", to: "c9" });
  assert.equal(pick(WHO, "n"), null);
  assert.equal(pick({ ...WHO, didYouMean: undefined }, "y"), null, "a yes with nothing offered is not a name");
  assert.deepEqual(pick(WHO, "Northwind Bakery"), { text: "dinner at 8?", app: "WhatsApp", to: "Northwind Bakery" });
  assert.equal(pick(WHO, "9"), null);
  assert.deepEqual(pick(WHICH, "2"), { text: "I'm running late", app: "Messages", to: "juno" });
  assert.deepEqual(pick(WHICH, "slack"), { text: "I'm running late", app: "slack", to: "juno" });
  assert.equal(pick(WHICH, ""), null, "no Did you mean, no default");
});

// ---- Surfaces: verbs for autocomplete, one-line JSON, and a question as a prompt frame --------

test("apps cli: vyre commands lists list, find, targets and setup, the words runApps takes as verbs", async t => {
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");
  const out = await new Promise(resolve => execFile(process.execPath, [bin, "commands", "apps", "--json"],
    { env: { ...process.env, VYRE_HOME: tempHome(t), NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 }, (_e, stdout) => resolve(stdout)));
  const c = JSON.parse(String(out)).commands[0];
  assert.deepEqual(c.verbs.map(v => v.verb), ["list", "find", "targets", "setup"]);
  assert.deepEqual(c.verbs.filter(v => v.read).map(v => v.verb), ["list", "find", "targets"]);
  assert.match(c.usage, /list \| find <words\.\.\.> \| targets <app> \[words\.\.\.\] \| setup <app> \| <words\.\.\.>/);
  for (const v of c.verbs) assert.equal(parseArgs([v.verb, "x"]).sub, v.verb, `${v.verb} is a subcommand runApps knows`);
});

test("apps cli: --json is one line through the kit's emit when there is one; --to reaches apps.route", async () => {
  const f = fake({ "apps.list": { apps: [{ name: "Clock", tier: "intents", bundleId: "com.apple.clock" }] },
    "apps.route": { app: "WhatsApp", action: "send", args: { to: "juno", text: "hi" }, sends: true, said: "WhatsApp to juno: hi" }, "apps.send": { said: "Sent to juno" } });
  /** @type {any[]} */
  const emitted = [];
  const deps = { ...f.deps, emit: (/** @type {any} */ d, /** @type {any} */ v) => { emitted.push([d, v]); } };
  assert.equal(await runApps(["--json"], deps), 0);
  assert.deepEqual(emitted[0], [{ apps: [{ name: "Clock", tier: "intents", bundleId: "com.apple.clock" }] }, undefined]);
  assert.equal(await runApps(["--json", "--app", "WhatsApp", "--to", "juno", "hi"], deps), 0);
  assert.deepEqual(f.calls.find(c => c.tool === "apps.route")?.input, { text: "hi", app: "WhatsApp", to: "juno" });
  assert.equal(parseArgs(["--to"]).error, "--to needs who it is for, like --to juno");
  const plain = fake({ "apps.list": { apps: [] } });
  assert.equal(await runApps(["--json"], plain.deps), 0);
  assert.deepEqual(plain.lines, ['{"apps":[]}'], "without emit, still one line");
});

test("apps cli: under --view a question is a prompt frame with the candidates, exit 2, and no terminal is read", async () => {
  const f = fake({ "apps.route": WHO });
  /** @type {any[]} */
  const emitted = [];
  let asked = 0;
  const deps = { ...f.deps, viewing: true, isTTY: true, ask: async () => { asked++; return "1"; }, emit: (/** @type {any} */ d, /** @type {any} */ v) => { emitted.push([d, v]); } };
  assert.equal(await runApps(["--json", "whatsapp", "alx:", "dinner", "at", "8?"], deps), 2);
  assert.equal(asked, 0, "never a terminal question");
  assert.deepEqual(emitted[0][0], WHO, "data is what --json prints");
  assert.deepEqual(emitted[0][1], { kind: "prompt", name: "to", label: "Who should get this? Did you mean alex on WhatsApp?",
    args: ["apps", "--app", "WhatsApp", "dinner", "at", "8?"], answer: "flag", flag: "to", choices: ["alex", "kit"] });
  assert.deepEqual(promptFor(WHICH), { kind: "prompt", name: "app", label: "Which app?",
    args: ["apps", "--to", "juno", "I'm", "running", "late"], answer: "flag", flag: "app", choices: ["WhatsApp", "Messages"] });
  // The prompt's args with --to <choice> added route to exactly what a pick at a terminal would.
  const again = parseArgs([...promptFor(WHICH).args.slice(1), "--app", "WhatsApp"]);
  assert.deepEqual([again.flags.app, again.flags.to, again.words.join(" ")], ["WhatsApp", "juno", "I'm running late"]);
});
