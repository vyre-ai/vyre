// @ts-check
// The session view's pure rules: labels, headers per assistant run, grouping, merging a re-read,
// footers, and the raw view printed the way Claude Code's terminal prints it. Sample world only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shortPath, toolVerb, whoLabel, plan, groupBlocks, mergeBlocks, blockKey, rawLines, rawToolHead, duration, tokens, cost, turnParts, clip,
  langOf, toolTitle, toolState, commandText } from "./blocks.js";

const fx = JSON.parse(readFileSync(new URL("../fixtures/session-blocks.json", import.meta.url), "utf8"));

test("labels: the model is Vyre or the agent, the person is you, another surface its name, never claude", () => {
  assert.equal(whoLabel({ role: "assistant" }), "Vyre");
  assert.equal(whoLabel({ role: "assistant", agent: "juno" }), "juno");
  assert.equal(whoLabel({ role: "assistant", agent: "claude" }), "Vyre");
  assert.equal(whoLabel({ role: "user" }), "you");
  assert.equal(whoLabel({ role: "user", surface: "deck" }), "you");
  assert.equal(whoLabel({ role: "user", surface: "chat" }), "you");
  assert.equal(whoLabel({ role: "user", surface: "capsule" }), "capsule");
  assert.equal(whoLabel({ role: "user", surface: "claude-code" }), "terminal");
  for (const o of [{ role: "assistant", agent: "Claude" }, { role: "user", surface: "claude" }]) assert.doesNotMatch(whoLabel(/** @type {any} */ (o)), /claude/i);
});

test("plan: one header per assistant run, none before user lines or after a run already open", () => {
  const ops = plan(fx.blocks, null);
  const heads = ops.filter(o => o.op === "head");
  assert.equal(heads.length, 1, "the whole reply is one run");
  assert.equal(ops[0].op, "block"); // the user line first
  assert.equal(ops[1].op, "head");
  assert.equal(plan([{ seq: 1, kind: "text", ts: 1 }], "assistant").filter(o => o.op === "head").length, 0);
  const two = plan([{ seq: 1, kind: "text" }, { seq: 2, kind: "turn" }, { seq: 3, kind: "user" }, { seq: 4, kind: "tool" }], null);
  assert.deepEqual(two.map(o => o.op === "head" ? "H" : o.block.kind), ["H", "text", "turn", "user", "H", "tool"]);
});

test("groupBlocks: you, the reply as one group, the turn footer", () => {
  const g = groupBlocks(fx.blocks);
  assert.deepEqual(g.map(x => x.type), ["user", "assistant", "turn"]);
  assert.equal(g[1].blocks.length, fx.blocks.length - 2);
});

test("blockKey and mergeBlocks: same seq different kinds stay apart, a re-read replaces, an open turn gives way", () => {
  assert.notEqual(blockKey({ seq: 5, kind: "turn" }), blockKey({ seq: 5, kind: "user" }));
  assert.equal(blockKey({ seq: 9, kind: "tool", id: "t1" }), "tool:t1");
  assert.equal(blockKey({ seq: 9, kind: "turn", open: true }), "turn:open");
  const have = [{ seq: 1, kind: "user" }, { seq: 2, kind: "tool", id: "a", output: null }, { seq: 2, kind: "turn", open: true }];
  const more = [{ seq: 2, kind: "tool", id: "a", output: "ok" }, { seq: 3, kind: "turn" }, { seq: 3, kind: "user" }];
  const m = mergeBlocks(have, more);
  assert.deepEqual(m.map(blockKey), ["user:1", "tool:a", "turn:3", "user:3"]);
  assert.equal(m[1].output, "ok");
});

test("raw view: printed the way the terminal prints it", () => {
  const lines = rawLines(fx.blocks);
  const s = lines.join("\n");
  assert.equal(lines[0], "> The order form on the Northwind Bakery site drops the pickup date when a customer changes the quantity. Can you find out why and fix it?");
  assert.match(s, /^✻ Thinking…$/m);
  assert.match(s, /^⏺ I'll look at the order form component first\.$/m);
  assert.match(s, /^⏺ Bash\(npm test -- src\/order\)\n  ⎿  > northwind-bakery@1\.4\.0 test\n     > node --test src\/order\n     \n     # tests 14\n     … \+3 lines$/m);
  assert.match(s, /^⏺ Update\(\/home\/alex\/work\/northwind-bakery\/src\/order\/OrderForm\.js\)\n  ⎿  Updated \/home\/alex/m);
  assert.match(s, /^⏺ Read\(.*OrderForm\.js\)\n  ⎿  Read 7 lines$/m);
  assert.match(s, /^⏺ Update Todos\n  ⎿  ☒ Find where the pickup date is lost\n     ◼ Fix the quantity handler\n     ☐ Run the tests$/m);
  assert.match(s, /^⏺ Search\(pattern: "pickupDate", path: "src"\)$/m);
  assert.match(s, /^⏺ Fetch\(https:\/\/react\.dev/m);
  // A multi-line reply keeps its lines under the dot, indented.
  assert.match(s, /^⏺ Fixed\. .*\n  \n  - `src\/order\/OrderForm\.js`/m);
  // Entries are separated by one blank line; the turn prints nothing.
  assert.equal(lines[1], "");
  assert.doesNotMatch(s, /claude/i);
});

test("raw view: running, failed and live tools", () => {
  assert.deepEqual(rawLines([{ seq: 1, kind: "tool", id: "x", tool: "Bash", input: { command: "npm test" }, output: null }]), ["⏺ Bash(npm test)", "  ⎿  Running…"]);
  assert.deepEqual(rawLines([{ seq: 1, kind: "tool", id: "x", tool: "Bash", input: { command: "false" }, output: "exit 1", error: true, done_ts: 2 }]), ["⏺ Bash(false)", "  ⎿  Error: exit 1"]);
  assert.deepEqual(rawLines([{ seq: 1, kind: "tool", id: "x", tool: "Bash", summary: "ls", output: null }]), ["⏺ Bash(ls)", "  ⎿  Running…"]);
  assert.equal(rawToolHead("WebSearch", { query: "bakery pickup slots" }), 'Web Search("bakery pickup slots")');
  assert.equal(rawToolHead("mcp__harlow__lookup_client", { client: "Harlow Legal" }), "mcp__harlow__lookup_client(Harlow Legal)");
  assert.deepEqual(rawLines([{ seq: 0, kind: "user", command: true, text: "<command-name>/clear</command-name><command-args></command-args>" }]), ["> /clear"]);
});

test("formatters: duration, tokens, cost, the turn footer", () => {
  assert.equal(duration(840), "0.8 s");
  assert.equal(duration(1), "", "under a twentieth of a second says nothing");
  assert.equal(duration(49), "");
  assert.equal(duration(2400), "2.4 s");
  assert.equal(duration(19000), "19 s");
  assert.equal(duration(185000), "3 min 05 s");
  assert.equal(duration(null), "");
  assert.equal(tokens(912), "912");
  assert.equal(tokens(18420), "18k");
  assert.equal(tokens(3200), "3.2k");
  assert.equal(cost(0.0423), "$0.042");
  assert.equal(cost(1.2), "$1.20");
  assert.equal(cost(0), "");
  assert.deepEqual(turnParts({ duration_ms: 19000, tokens: { input: 18420, output: 912 } }), ["19 s", "19k tokens"]);
  // No $ figure without api-key billing: a subscription runs on the person's plan, never a charge
  // (the user's rule) - cost_usd with no `auth`, or any auth but api-key, drops the $ figure.
  assert.deepEqual(turnParts({ duration_ms: 19000, tokens: { input: 18420, output: 912 }, cost_usd: 0.05 }), ["19 s", "19k tokens"]);
  assert.deepEqual(turnParts({ duration_ms: 19000, tokens: { input: 18420, output: 912 }, cost_usd: 0.05, auth: "subscription" }), ["19 s", "19k tokens"]);
  assert.deepEqual(turnParts({ duration_ms: 19000, tokens: { input: 18420, output: 912 }, cost_usd: 0.05, auth: "api-key" }), ["19 s", "19k tokens", "$0.050"]);
});

test("shortPath: inside the session's folder relative, outside whole", () => {
  const cwd = "/home/alex/Work/harlow-site";
  assert.equal(shortPath(cwd + "/menu.md", cwd), "menu.md");
  assert.equal(shortPath(cwd + "/src/app.js", cwd + "/"), "src/app.js");
  assert.equal(shortPath(cwd, cwd), ".");
  assert.equal(shortPath("/home/alex/Work/harlow-site-old/menu.md", cwd), "/home/alex/Work/harlow-site-old/menu.md", "a sibling with the same prefix is not inside");
  assert.equal(shortPath("/srv/data/alex/Work/other/notes/q3.md", cwd), "/srv/data/alex/Work/other/notes/q3.md", "outside the folder: whole");
  assert.equal(shortPath("notes.md", null), "notes.md");
  assert.equal(shortPath(null, cwd), "");
  assert.equal(toolTitle("Read", { file_path: cwd + "/menu.md" }, cwd), "menu.md");
  assert.equal(toolTitle("Grep", { pattern: "price", path: cwd + "/src" }, cwd), "price in src");
  assert.equal(toolTitle("Bash", { command: `cat ${cwd}/menu.md && ls ${cwd}` }, cwd), "cat menu.md && ls .");
});

test("raw view: paths relative to the session's folder, as Claude Code prints them", () => {
  const cwd = "/home/alex/Work/harlow-site";
  assert.equal(rawToolHead("Edit", { file_path: cwd + "/menu.md" }, cwd), "Update(menu.md)");
  assert.deepEqual(rawLines([{ kind: "tool", tool: "Edit", input: { file_path: cwd + "/menu.md" }, output: "ok", done: true, cwd }]), ["⏺ Update(menu.md)", "  ⎿  Updated menu.md"]);
});

test("toolVerb: past tense done, -ing while running or waiting, never the SDK's names", () => {
  assert.equal(toolVerb("Edit", "done"), "Edited");
  assert.equal(toolVerb("Edit", "running"), "Editing");
  assert.equal(toolVerb("Bash", "failed"), "Ran");
  assert.equal(toolVerb("Bash", "waiting"), "Running");
  assert.equal(toolVerb("TodoWrite", "done"), "Todos");
  assert.equal(toolVerb("AskUserQuestion", "running"), "Asking");
  assert.equal(toolVerb("mcp__harlow__lookup_client", "done"), "Lookup client");
  assert.equal(toolVerb("Frobnicate", "done"), "Frobnicate");
});

test("clip, langOf, toolTitle, toolState, commandText", () => {
  const c = clip(Array.from({ length: 30 }, (_, i) => "line " + i).join("\n"), 12);
  assert.equal(c.shown.split("\n").length, 12);
  assert.equal(c.hidden, 18);
  assert.equal(c.total, 30);
  assert.deepEqual(clip("", 12), { shown: "", hidden: 0, total: 0 });
  assert.equal(langOf("src/a.tsx"), "ts");
  assert.equal(langOf("README"), "text");
  assert.equal(toolTitle("Bash", { command: "npm test\necho done" }), "npm test");
  assert.equal(toolTitle("TodoWrite", fx.blocks[3].input), "1 of 3 done");
  assert.equal(toolTitle("Grep", { pattern: "x", path: "src" }), "x in src");
  assert.equal(toolState({ output: null }), "running");
  assert.equal(toolState({ output: "ok", done_ts: 1 }), "done");
  assert.equal(toolState({ output: "no", error: true }), "failed");
  assert.equal(toolState({ output: null, done: true }), "done");
  assert.equal(commandText("<command-name>/model</command-name><command-args>sample</command-args>"), "/model sample");
});
