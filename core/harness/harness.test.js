// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
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

test("rules: nothing reads the vault's key from the keychain", () => {
  const deny = command => rules({ tool: "Bash", input: { command }, cwd: "/home/alex/Work", home: HOME }).decision;
  assert.equal(deny("security find-generic-password -s vyre-vault -w"), "deny");
  assert.equal(deny("security find-generic-password -a x -w login.keychain"), "deny", "any keychain password printed with -w");
  assert.equal(deny("security dump-keychain -d"), "deny");
  assert.equal(deny("security find-certificate -a"), null, "other security commands are fine");
  assert.equal(deny("npm audit --security"), null);
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

test("rules: the MCP hub's own tools are left to the Gate; every other send still asks", () => {
  const decide = (tool, input = { to: "dana@harlowlegal.com" }) => rules({ tool, input, home: HOME }).decision;
  // The hub's namespace inside Vyre's MCP server, as `vyre mcp` and as the plugin.
  assert.equal(decide("mcp__vyre__mail__send_email"), null);
  assert.equal(decide("mcp__plugin_vyre_vyre__harlow-slack__post_message", { channel: "#general" }), null);
  // Vyre's own tools, one underscore: unchanged.
  assert.equal(decide("mcp__vyre__threads_send"), "ask");
  assert.equal(decide("mcp__plugin_vyre_vyre__threads_send"), "ask");
  assert.equal(decide("mcp__vyre__threads_list"), null);
  // Look-alikes are not the hub.
  assert.equal(decide("mcp__other__x__send_email"), "ask");
  assert.equal(decide("mcp__vyrex__mail__send_email"), "ask");
  assert.equal(decide("mcp__vyre__Mail__send_email"), "ask", "hub server names are lowercase");
  assert.equal(decide("mcp__vyre__" + "a".repeat(33) + "__send_email"), "ask", "hub server names are at most 32 characters");
  // Vyre tools that hold at the Gate themselves step aside too; exactly those, by full name.
  assert.equal(decide("mcp__vyre__google_mail_send"), null);
  assert.equal(decide("mcp__plugin_vyre_vyre__google_mail_send"), null);
  assert.equal(decide("mcp__other__google_mail_send"), "ask");
  assert.equal(decide("mcp__vyre__google_mail_send_now"), "ask");
  // Rule 8 still holds for the hub's tools.
  assert.equal(rules({ tool: "mcp__vyre__files__read_file", input: { path: path.join(HOME, "vault", "x") }, home: HOME }).decision, "deny");
  assert.equal(rules({ tool: "mcp__vyre__srv__send_message", input: { to: "dana@harlowlegal.com", text: path.join(HOME, "vault", "items.sealed") }, home: HOME }).decision, "deny");
  assert.equal(rules({ tool: "mcp__vyre__srv__send_message", input: { to: "dana@harlowlegal.com", attach: "~/.vyre/vault" }, home: path.join(os.homedir(), ".vyre") }).rule, 8);
  assert.equal(rules({ tool: "mcp__vyre__srv__send_message", input: { command: "cat ../.vyre/vault/*" }, cwd: "/home/alex/Work", home: HOME }).rule, 8, "a command reaching the vault");
  // A send outside the hub's namespace still asks, by rule 1.
  assert.equal(rules({ tool: "mcp__other__send_message", input: { to: "dana@harlowlegal.com" }, home: HOME }).rule, 1);
  assert.equal(rules({ tool: "mcp__vyre__threads_send", input: {}, home: HOME }).rule, 1);
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
  // Teammates section 1: core/team says the sentence to inject, or null (team.default off, or
  // no teammates yet with the person choosing not to be nudged - not this hook's business which).
  const team = `export default { async start(ctx) {
    ctx.tool("team.project-append", { run: async ({ project }) => ({ project, text: project === "harlow-legal" ? "This project has teammates: design." : null }) });
    return {};
  } };`;
  const { reg, events } = await harness(t, [
    ["projects", { version: "0.1.0", does: { tools: ["projects.of", "projects.context"] } }, projects],
    ["memory", { version: "0.1.0", does: { tools: ["memory.relevant"] } }, memory],
    ["team", { version: "0.1.0", does: { tools: ["team.project-append"] } }, team],
  ]);
  const b = await reg.call("harness.brief", { cwd: "/w/harlow-site", session: "s1", source: "startup" });
  // The team nudge comes ahead of the project's own brief.
  assert.equal(b.data.text, "This project has teammates: design.\n\nProject harlow-legal. People: Dana Reyes.");
  assert.equal(events.since(0).find(e => e.type === "thread.started").payload.session, "s1");
  assert.match((await reg.call("harness.enrich", { prompt: "What did Dana ask for?", cwd: "/w/harlow-site" })).data.text, /Dana Reyes is at Harlow Legal/);
  assert.equal((await reg.call("harness.enrich", { prompt: "/compact", cwd: "/w/harlow-site" })).data.text, "", "slash commands get nothing");
  assert.equal((await reg.call("harness.brief", { cwd: "/w/northwind" })).data.text, "", "outside a project, no brief");
  // An agent's scope, as the switchboard hands it to the hooks.
  assert.equal((await reg.call("harness.brief", { cwd: "/w/harlow-site", projects: "harlow-legal,northwind" })).data.text, "This project has teammates: design.\n\nProject harlow-legal. People: Dana Reyes.");
  assert.equal((await reg.call("harness.brief", { cwd: "/w/harlow-site", projects: "northwind" })).data.text, "", "an agent outside its projects gets no brief");
  assert.equal((await reg.call("harness.enrich", { prompt: "What did Dana ask for?", cwd: "/w/harlow-site", projects: "northwind" })).data.text, "", "nor their memory");
  assert.match((await reg.call("harness.enrich", { prompt: "What did Dana ask for?", cwd: "/w/harlow-site", projects: "*" })).data.text, /Dana Reyes/, "the assistant sees every project");
});

test("harness: brief's team nudge is null-safe - team.default off, or core/team not running, changes nothing", async t => {
  const projects = `export default { async start(ctx) {
    ctx.tool("projects.context", { run: async () => ({ project: "harlow-legal", candidates: [], text: "Project harlow-legal." }) });
    return {};
  } };`;
  // core/team absent entirely: ask() fails closed to null, same as any other missing module.
  const { reg: withoutTeam } = await harness(t, [["projects", { version: "0.1.0", does: { tools: ["projects.context"] } }, projects]]);
  assert.equal((await withoutTeam.call("harness.brief", { cwd: "/w/harlow-site" })).data.text, "Project harlow-legal.");
  // core/team running, but this project's person turned team.default off (its own tool says so).
  const teamOff = `export default { async start(ctx) {
    ctx.tool("team.project-append", { run: async () => ({ project: "harlow-legal", text: null }) });
    return {};
  } };`;
  const { reg: withTeamOff } = await harness(t, [
    ["projects", { version: "0.1.0", does: { tools: ["projects.context"] } }, projects],
    ["team", { version: "0.1.0", does: { tools: ["team.project-append"] } }, teamOff],
  ]);
  assert.equal((await withTeamOff.call("harness.brief", { cwd: "/w/harlow-site" })).data.text, "Project harlow-legal.");
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

test("harness: brief warns a terminal resume of a live headless thread, and not our own child", async t => {
  // A stub switchboard: one live thread, s-live, whose keyboard the deck holds.
  const threads = `export default { async start(ctx) {
    const live = s => s === "s-live";
    ctx.tool("threads.claimed", { internal: true, run: async ({ session }) => ({ headless: live(session), holder: live(session) ? "deck:1" : null, status: live(session) ? "idle" : null }) });
    ctx.tool("threads.contend", { internal: true, run: async ({ session }) => { if (live(session)) ctx.events.emit("thread.contended", { session, holder: "deck:1" }); return { emitted: live(session) }; } });
    return {};
  } };`;
  const { reg, events } = await harness(t, [["threads", { version: "0.1.0", does: { tools: ["threads.claimed", "threads.contend"] }, watches: { emits: ["thread.contended"] } }, threads]]);
  const term = (await reg.call("harness.brief", { cwd: "/w/northwind", session: "s-live", headless: false })).data.text;
  assert.equal(term, "Warning from Vyre: this conversation is also running headless under Vyre right now (holder: deck:1). " +
    "Two processes writing one transcript lose work. Stop the headless one with `vyre threads stop s-live` before going on here, " +
    "or leave this session and keep working there. Tell the user this before anything else.");
  assert.deepEqual(events.since(0).filter(e => e.type === "thread.contended").map(e => e.payload), [{ session: "s-live", holder: "deck:1" }]);
  assert.equal((await reg.call("harness.brief", { cwd: "/w/northwind", session: "s-live", headless: true })).data.text, "", "our own child is not a second writer");
  assert.equal((await reg.call("harness.brief", { cwd: "/w/northwind", session: "s-other" })).data.text, "", "a session vyred is not running");
  assert.equal(events.since(0).filter(e => e.type === "thread.contended").length, 1);
});

test("harness: a send inside an agent's thread is routed to the Gate; the user's own session still asks", async t => {
  const gate = `export default { async start(ctx) {
    ctx.tool("gate.route", { internal: true, run: async ({ agent }) => agent ? { decision: "deny", reason: "Use gate_request." } : { decision: null } });
    return {};
  } };`;
  const { reg } = await harness(t, [["gate", { version: "0.1.0", does: { tools: ["gate.route"] } }, gate]]);
  const call = { tool_name: "mcp__mail__send_message", tool_input: { to: "dana@harlowlegal.com", body: "hi" }, session: "s1" };
  const agent = (await reg.call("harness.rules", { ...call, agent: "juno" })).data;
  assert.deepEqual([agent.decision, agent.reason, agent.rule], ["deny", "Use gate_request.", 1]);
  assert.equal((await reg.call("harness.rules", call)).data.decision, "ask", "without an agent the floor's ask stands");
});

test("harness: without the Gate running, an agent's send falls back to asking", async t => {
  const { reg } = await harness(t);
  const r = (await reg.call("harness.rules", { tool_name: "mcp__mail__send_message", tool_input: { to: "dana@harlowlegal.com" }, agent: "juno" })).data;
  assert.equal(r.decision, "ask");
});
