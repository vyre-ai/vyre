// @ts-check
// Slack through the MCP hub (slice 3). First the adapter against a fake hub (env.call), then the
// whole path in a real vyred in a temp home, with the real hub, the real Gate and a fake Slack MCP
// server (core/mcp/testing/fake-mcp.js, a stdio child): the send is held, nothing reaches the
// server before the person approves, and exactly one call arrives after.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import slack, { slackServer } from "./adapters/slack.js";
import { start } from "../../core/daemon/index.js";
import { call } from "../../core/daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";

const FAKE = path.join(import.meta.dirname, "..", "..", "core", "mcp", "testing", "fake-mcp.js");
const obj = (/** @type {Record<string, any>} */ properties, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });

const CHANNELS = { channels: [{ id: "C0001GENERAL", name: "general" }, { id: "C0002OLD", name: "old-stuff", is_archived: true }, { id: "C0003BAKERY", name: "northwind-bakery" }] };
const USERS = { members: [{ id: "U0001JUNO", name: "juno", profile: { real_name: "Juno Park" } }, { id: "U0002BOT", name: "helper", is_bot: true }, { id: "U0003KIT", name: "kit", deleted: true }] };

/** A fake hub: mcp.tools lists `tools`, mcp.call answers reads and holds posts, and records every call. */
function fakeEnv(/** @type {any[]} */ tools, /** @type {any} */ config = {}, /** @type {any} */ answer = null) {
  /** @type {any[]} */
  const calls = [];
  const env = /** @type {any} */ ({
    config,
    async call(/** @type {string} */ tool, /** @type {any} */ input) {
      calls.push({ tool, input });
      if (tool === "mcp.tools") return { data: tools };
      if (tool !== "mcp.call") return { error: { code: "no_such_tool", message: tool } };
      if (answer) return answer;
      if (/channels/.test(input.tool)) return { data: { structuredContent: CHANNELS } };
      if (/users/.test(input.tool)) return { data: { content: [{ type: "text", text: JSON.stringify(USERS) }] } };
      return { data: { held: "itm_7", message: "Held for your approval." } };
    },
  });
  return { env, calls };
}

const T = (/** @type {string} */ server, /** @type {string} */ tool, outward = false, input = obj({})) => ({ server, tool, name: `${server}__${tool}`, outward, input });
const OFFICIAL = [T("slack", "slack_post_message", true, obj({ channel_id: { type: "string" }, text: { type: "string" } })), T("slack", "slack_list_channels"), T("slack", "slack_get_users")];

test("slack: the one Slack-like server is found; two are a question for settings; none is setup", async () => {
  assert.equal((await slackServer(fakeEnv(OFFICIAL).env)).server, "slack");
  const two = [...OFFICIAL, T("work", "conversations_add_message", true), T("work", "channels_list")];
  await assert.rejects(slackServer(fakeEnv(two).env), (/** @type {any} */ e) => e.code === "setup" && /apps\.slack\.server/.test(e.message));
  assert.equal((await slackServer(fakeEnv(two, { slack: { server: "work" } }).env)).post.tool, "conversations_add_message");
  await assert.rejects(slackServer(fakeEnv([T("tracker", "list_issues")]).env), (/** @type {any} */ e) => e.code === "setup" && /vyre mcp add/.test(e.message));
  await assert.rejects(slackServer(fakeEnv(OFFICIAL, { slack: { server: "gone" } }).env), (/** @type {any} */ e) => e.code === "setup");
  assert.equal(await /** @type {any} */ (slack).ready(fakeEnv(OFFICIAL).env), true);
  assert.equal(await /** @type {any} */ (slack).ready(fakeEnv([]).env), false, "no Slack server: not offered as an app Vyre sends through");
});

test("slack: targets are live channels and real people, filtered by the words", async () => {
  const { env } = fakeEnv(OFFICIAL);
  const all = await /** @type {any} */ (slack).targets("", env);
  assert.deepEqual(all.map((/** @type {any} */ t) => [t.id, t.title, t.kind]), [["C0001GENERAL", "#general", "channel"], ["C0003BAKERY", "#northwind-bakery", "channel"], ["U0001JUNO", "Juno Park", "person"]]);
  assert.deepEqual((await /** @type {any} */ (slack).targets("#bak", env)).map((/** @type {any} */ t) => t.id), ["C0003BAKERY"]);
  assert.deepEqual((await /** @type {any} */ (slack).targets("juno", env)).map((/** @type {any} */ t) => t.id), ["U0001JUNO"]);
});

test("slack: a send is held, with the channel's id and the words in the server's own argument keys", async () => {
  const { env, calls } = fakeEnv(OFFICIAL);
  const out = await slack.actions.send.run({ to: "#general", text: "Ovens are in." }, env);
  assert.deepEqual(out.held, { id: "itm_7", message: "Held for your approval." });
  assert.equal(out.preview, "Slack → #general: Ovens are in.");
  const post = calls.filter(c => c.tool === "mcp.call" && c.input.tool === "slack_post_message");
  assert.deepEqual(post.map(c => c.input), [{ server: "slack", tool: "slack_post_message", arguments: { channel_id: "C0001GENERAL", text: "Ovens are in." } }]);
  // Another server's keys: conversations_add_message takes channel_id and payload.
  const other = fakeEnv([T("work", "conversations_add_message", true, obj({ channel_id: {}, payload: {} })), T("work", "channels_list")]);
  await slack.actions.send.run({ to: "C0009ABCDEF", text: "hi" }, other.env);
  assert.deepEqual(other.calls.at(-1).input.arguments, { channel_id: "C0009ABCDEF", payload: "hi" }, "an id needs no lookup");
});

test("slack: never a send the hub would run unapproved, to no one, or unheld", async () => {
  const loose = fakeEnv([T("slack", "slack_post_message", false), T("slack", "slack_list_channels")]);
  await assert.rejects(slack.actions.send.run({ to: "#general", text: "x" }, loose.env), (/** @type {any} */ e) => e.code === "failed" && /without approval/.test(e.message));
  assert.equal(loose.calls.filter(c => c.tool === "mcp.call" && c.input.tool === "slack_post_message").length, 0);
  await assert.rejects(slack.actions.send.run({ to: "#nowhere", text: "x" }, fakeEnv(OFFICIAL).env), (/** @type {any} */ e) => e.code === "not_found");
  const ran = fakeEnv(OFFICIAL, {}, { data: { content: [{ type: "text", text: "ok" }] } });
  await assert.rejects(slack.actions.send.run({ to: "C0001GENERAL", text: "x" }, ran.env), (/** @type {any} */ e) => e.code === "failed" && /without holding/.test(e.message));
});

// ---- The whole path, in a real vyred ----------------------------------------------------------

const SLACK_TOOLS = [
  { name: "slack_post_message", description: "Post a message to a Slack channel.", inputSchema: obj({ channel_id: { type: "string" }, text: { type: "string" } }, ["channel_id", "text"]) },
  { name: "slack_list_channels", description: "List public channels.", inputSchema: obj({}), annotations: { readOnlyHint: true }, result: { structuredContent: CHANNELS, content: [{ type: "text", text: JSON.stringify(CHANNELS) }] } },
  { name: "slack_get_users", description: "List people in the workspace.", inputSchema: obj({}), annotations: { readOnlyHint: true }, result: { structuredContent: USERS, content: [{ type: "text", text: JSON.stringify(USERS) }] } },
];

test("slack: words to a held message, nothing sent until the person approves, then exactly one", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-mac", role: "local", vault: { keystore: "file" }, apps: { dirs: [path.join(root, "Applications")] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cli = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
  const capsule = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "capsule" });
  const log = path.join(root, "slack.log");
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(l => l.startsWith("call slack_post_message")) : []);

  const added = await cli("mcp.add", { name: "slack", transport: "stdio", command: process.execPath, args: [FAKE, "--stdio"],
    vars: { FAKE_MCP_LOG: log, FAKE_MCP_TOOLS: JSON.stringify(SLACK_TOOLS) } });
  assert.equal(added.data && added.data.test.ok, true, JSON.stringify(added));

  const route = (await capsule("apps.route", { text: "tell the northwind-bakery on slack the ovens are in" })).data;
  assert.equal(route.ambiguous, true, "a name that is not quite the channel's is asked about, never guessed");
  const r = (await capsule("apps.route", { text: "slack #general: the ovens are in" })).data;
  assert.deepEqual({ app: r.app, action: r.action, args: r.args, sends: r.sends, gated: r.gated }, { app: "Slack", action: "send", args: { to: "#general", text: "the ovens are in" }, sends: true, gated: true });
  assert.equal((await capsule("apps.send", { app: r.app, action: r.action, args: r.args })).error.code, "gated");

  const held = (await capsule("apps.act", { app: r.app, action: r.action, args: r.args })).data;
  assert.equal(typeof held.held.id, "string", JSON.stringify(held));
  assert.equal(held.said, "Slack → #general: the ovens are in · waiting for your approval");
  assert.deepEqual(lines(), [], "a held message reached Slack before approval");

  // What the person proves against names the channel and the words, not a blank.
  const def = /** @type {any} */ (d.registry).tools.get("gate.approve");
  assert.equal(await def.presence.summary({ id: held.held.id }), 'Send send via mcp:slack to C0001GENERAL: "the ovens are in"');

  const out = await capsule("gate.approve", { id: held.held.id });
  assert.equal(out.data && out.data.state, "sent", JSON.stringify(out));
  assert.deepEqual(lines(), [`call slack_post_message ${JSON.stringify({ channel_id: "C0001GENERAL", text: "the ovens are in" })}`]);
  assert.notEqual((await capsule("gate.approve", { id: held.held.id })).data?.state, "sent", "an approved item is released once");
  assert.equal(lines().length, 1);
});
