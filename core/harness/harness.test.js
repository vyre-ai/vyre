// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rules } from "./rules.js";
import { formatMemory } from "./index.js";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const HOME = "/home/alex/.vyre";

test("rules: nothing reads the vault, however it is reached", () => {
  const deny = i => rules({ tool: i.tool, input: i.input, cwd: "/home/alex/Work", home: HOME }).decision;
  assert.equal(deny({ tool: "Read", input: { file_path: "/home/alex/.vyre/vault/items.sealed" } }), "deny");
  assert.equal(deny({ tool: "Bash", input: { command: "cat /home/alex/.vyre/vault/*" } }), "deny");
  assert.equal(deny({ tool: "Bash", input: { command: "cd ../.vyre/vault && ls" } }), "deny", "relative paths are resolved from cwd");
  assert.equal(deny({ tool: "Bash", input: { command: "ls ./notes/vault-ideas" } }), null, "a relative path outside the vault is fine");
  assert.equal(rules({ tool: "Bash", input: { command: "ls vault" }, cwd: HOME, home: HOME }).decision, "deny", "relative to cwd inside ~/.vyre");
  assert.equal(deny({ tool: "Grep", input: { pattern: "key", path: "/home/alex/.vyre/vault" } }), "deny");
  assert.equal(deny({ tool: "Read", input: { file_path: "/home/alex/Work/vault/notes.md" } }), null, "a folder that happens to be called vault is fine");
});

test("rules: a tool that sends as the user asks first and names where it is going", () => {
  const r = rules({ tool: "mcp__mail__send_message", input: { to: "dana@harlowlegal.com", body: "hi" }, home: HOME });
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /dana@harlowlegal\.com/);
  assert.equal(rules({ tool: "mcp__chat__post_message", input: { channel: "#general" }, home: HOME }).decision, "ask");
  assert.equal(rules({ tool: "mcp__mail__create_draft", input: { to: "x@y.z" }, home: HOME }).decision, null, "a draft goes nowhere");
  assert.equal(rules({ tool: "mcp__mail__search_threads", input: {}, home: HOME }).decision, null);
  assert.equal(rules({ tool: "Bash", input: { command: "git push" }, home: HOME }).decision, null, "the floor is about messages, not code");
});

test("formatMemory: reads Memory's own item shape, where source is an object", () => {
  const t = formatMemory([{ id: "a|works_at|b", text: "Dana Reyes works at Harlow Legal", confidence: 0.9, age: "3 weeks", source: { session: "s1", seq: 0, name: "Harlow site rebuild" } }]);
  assert.match(t, /\(from Harlow site rebuild, 3 weeks, confidence 0\.90\)/);
});

test("formatMemory: marks memory as memory, with source and age; empty for nothing", () => {
  assert.equal(formatMemory([]), "");
  const t = formatMemory([{ text: "Dana Reyes works at Harlow Legal", source: "Harlow site rebuild", age: "3 weeks", confidence: 0.9 }]);
  assert.match(t, /^Vyre memory\./);
  assert.match(t, /Dana Reyes works at Harlow Legal \(from Harlow site rebuild, 3 weeks, confidence 0\.90\)/);
});

async function harness(t, extra = []) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  for (const [name, manifest, src] of extra) writeModule(root, name, manifest, src);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "harness");
  await reg.start([...core, ...discover([root])], { role: "local" });
  t.after(() => db.close());
  return { reg, events, home };
}

test("harness: with no other modules, every hook answers with nothing rather than failing", async t => {
  const { reg } = await harness(t);
  assert.equal((await reg.call("harness.brief", { cwd: "/home/alex/Work/harlow-site", session: "s1" })).data.text, "");
  assert.deepEqual(await reg.call("harness.enrich", { prompt: "what did Dana want?", cwd: "/x" }), { data: { text: "" } });
  assert.deepEqual(await reg.call("harness.rules", { tool_name: "Read", tool_input: { file_path: "/tmp/a" } }), { data: { decision: null } });
});

test("harness: brief and enrich use projects and memory when they are running", async t => {
  const projects = `export default { async start(ctx) {
    ctx.tool("projects.of", { run: async ({ cwd }) => cwd.includes("harlow") ? { project: "harlow-legal", name: "Harlow Legal", home: "/w/harlow-site" } : null });
    ctx.tool("projects.context", { run: async ({ cwd }) => cwd.includes("harlow") ? { project: "harlow-legal", candidates: [], text: "Project harlow-legal. People: Dana Reyes." } : { project: null, candidates: [], text: "" } });
    return {};
  } };`;
  const memory = `export default { async start(ctx) {
    ctx.tool("memory.relevant", { run: async ({ text, project_cwds }) => text.includes("Dana") ? [{ text: "Dana Reyes is at Harlow Legal", source: "Harlow site rebuild", age: "2 days", confidence: 0.8, cwds: project_cwds }] : [] });
    return {};
  } };`;
  const { reg, events } = await harness(t, [
    ["projects", { version: "0.1.0", does: { tools: ["projects.of", "projects.context"] } }, projects],
    ["memory", { version: "0.1.0", does: { tools: ["memory.relevant"] } }, memory],
  ]);
  const b = await reg.call("harness.brief", { cwd: "/w/harlow-site", session: "s1", source: "startup" });
  assert.equal(b.data.text, "Project harlow-legal. People: Dana Reyes.");
  assert.equal(events.since(0).find(e => e.type === "thread.started").payload.session, "s1");
  assert.match((await reg.call("harness.enrich", { prompt: "What did Dana ask for?", cwd: "/w/harlow-site" })).data.text, /Dana Reyes is at Harlow Legal/);
  assert.equal((await reg.call("harness.enrich", { prompt: "/compact", cwd: "/w/harlow-site" })).data.text, "", "slash commands get nothing");
  assert.equal((await reg.call("harness.brief", { cwd: "/w/northwind" })).data.text, "", "outside a project, no brief");
  // An agent's scope, as the switchboard hands it to the hooks.
  assert.equal((await reg.call("harness.brief", { cwd: "/w/harlow-site", projects: "harlow-legal,northwind" })).data.text, "Project harlow-legal. People: Dana Reyes.");
  assert.equal((await reg.call("harness.brief", { cwd: "/w/harlow-site", projects: "northwind" })).data.text, "", "an agent outside its projects gets no brief");
  assert.equal((await reg.call("harness.enrich", { prompt: "What did Dana ask for?", cwd: "/w/harlow-site", projects: "northwind" })).data.text, "", "nor their memory");
  assert.match((await reg.call("harness.enrich", { prompt: "What did Dana ask for?", cwd: "/w/harlow-site", projects: "*" })).data.text, /Dana Reyes/, "the assistant sees every project");
});

test("harness: learn records changed files; touched lists them; the vault rule emits tool.held", async t => {
  const { reg, events, home } = await harness(t);
  await reg.call("harness.learn", { tool_name: "Edit", tool_input: { file_path: "src/intake.tsx" }, cwd: "/w/harlow-site", session: "s1" });
  await reg.call("harness.learn", { tool_name: "Read", tool_input: { file_path: "README.md" }, cwd: "/w/harlow-site", session: "s1" });
  const touched = (await reg.call("harness.touched", { session: "s1" })).data;
  assert.deepEqual(touched.map(f => f.path), ["/w/harlow-site/src/intake.tsx"]);
  const held = await reg.call("harness.rules", { tool_name: "Read", tool_input: { file_path: path.join(home, "vault", "x") }, session: "s1" });
  assert.equal(held.data.decision, "deny");
  assert.equal(events.since(0).find(e => e.type === "tool.held").payload.rule, 8);
});
