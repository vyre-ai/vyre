// @ts-check
// The hub's rules without a vyred: which tools are reads, how names are aggregated, what a row
// may hold, and how calls retry and release, against a fake connect and an in-memory store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Credentials } from "../connectors/auth.js";
import { McpError } from "./client.js";
import { Hub, MIGRATIONS, MAX_NAME, aggregate, classify, normalize, target, looksSecret, whoFrom, checkUrl, sends } from "./hub.js";

test("classify: reads by verb or readOnlyHint, never with a send, write or delete word; unknown is outward", () => {
  const out = (name, annotations, mode) => classify({ name, annotations }, mode);
  for (const n of ["list_issues", "getIssue", "search-docs", "read_file", "find_user", "fetch_page", "query", "describe_table", "lookup", "view_board", "show_status", "listissues"])
    assert.equal(out(n).outward, false, n);
  for (const n of ["send_message", "create_issue", "delete_issue", "get_and_delete", "list_then_send", "sendmessage", "echo_env", "do_thing", "address_book_update"])
    assert.equal(out(n).outward, true, n);
  assert.equal(out("address_lookup").outward, false, "add inside a word is not a write");
  assert.equal(out("summarize", { readOnlyHint: true }).outward, false, "the hint relaxes a name with no write word");
  assert.equal(out("post_update", { readOnlyHint: true }).outward, true, "the hint never relaxes a send");
  assert.deepEqual(out("delete_issue"), { outward: true, kind: "delete", off: false });
  assert.equal(out("refund_payment").kind, "spend");
  assert.equal(out("send_message").kind, "send");
  assert.equal(out("create_issue", undefined, "read").outward, false, "the person's mode wins for a tool that does not send");
  // A tool that sends is held whatever the mode says: the floor's name rule steps aside for hub
  // tools only because the hub holds them.
  for (const n of ["send_message", "postMessage", "reply", "forward_mail", "publish-page", "share_doc", "invite_user", "tweet", "dm_user", "add_comment", "sendmessage", "autoreply", "pOst_update"])
    assert.deepEqual(out(n, { readOnlyHint: true }, "read"), { outward: true, kind: "send", off: false }, n);
  assert.equal(out("delete_and_send", undefined, "read").kind, "delete", "the kind is unchanged");
  assert.equal(out("send_message", undefined, "off").off, true, "off still turns it off");
  assert.equal(out("send_message", undefined, "write").outward, true);
  // Judged by the name the floor sees too: a cut aggregated name with a send word is held.
  assert.equal(classify({ name: "admin_dmx_list" }, "read").outward, false);
  assert.equal(classify({ name: "admin_dmx_list" }, "read", "srv__admin_dm_a1b2c3").outward, true);
  assert.equal(sends("list_issues"), false);
  assert.equal(sends("address_lookup"), false);
  assert.equal(out("list_issues", undefined, "write").outward, true);
  assert.equal(out("list_issues", undefined, "off").off, true);
});

test("aggregate: <server>__<tool>, reduced, deterministic, and never over the limit", () => {
  const m = aggregate("tracker", ["list.issues", "list_issues", "get issue"]);
  assert.equal(m.get("get issue"), "tracker__get_issue");
  assert.equal(m.get("list.issues"), "tracker__list_issues");
  assert.notEqual(m.get("list_issues"), "tracker__list_issues", "a collision gets a hash");
  assert.match(m.get("list_issues") || "", /^tracker__list_issues_[0-9a-f]{6}$/);
  const long = "x".repeat(32).replace(/^x/, "a");
  const m2 = aggregate(long, ["a_really_long_tool_name_for_a_really_long_server"]);
  const n = m2.get("a_really_long_tool_name_for_a_really_long_server") || "";
  assert.ok(n.length <= MAX_NAME && n.startsWith(`${long}__`), n);
  assert.deepEqual([...aggregate("a", ["b", "c"])], [...aggregate("a", ["c", "b"])].sort());
  for (const [, v] of aggregate("svc", ["ünïcode tool", "a/b", "ok-1"])) assert.match(v, /^[a-z][a-z0-9-]*__[A-Za-z0-9_-]+$/);
});

test("normalize: a row holds item names, never values", () => {
  const base = { name: "tracker", transport: "stdio", command: "node" };
  assert.deepEqual(normalize({ ...base, env: { GH: "gh-token" } }).auth, { type: "env" });
  assert.deepEqual(normalize({ ...base, auth: { type: "env", item: "gh-token", var: "GH" } }).env, { GH: "gh-token" });
  assert.deepEqual(normalize({ ...base, env: { K: { item: "keys", field: "k" } } }).env, { K: { item: "keys", field: "k" } });
  assert.throws(() => normalize({ ...base, env: { GH: "ghp_" + "Ab1".repeat(12) } }), /vault/);
  assert.throws(() => normalize({ ...base, env: { GH: "not a name!" } }), /vault item/);
  assert.throws(() => normalize({ ...base, vars: { API_KEY: "plain" } }), /credential/);
  assert.throws(() => normalize({ ...base, vars: { MODE: "sk-" + "a1".repeat(12) } }), /credential/);
  assert.throws(() => normalize({ ...base, args: ["--token", "xoxb-" + "1a".repeat(12)] }), /secret/);
  assert.throws(() => normalize({ ...base, auth: { type: "bearer", item: "x" } }), /http and sse/);
  assert.throws(() => normalize({ name: "t", transport: "stdio" }), /command/);
  // Vyre's own MCP server is never a hub server, however it is spelled.
  const own = /Vyre's own MCP server; its tools are already offered through the one vyre entry/;
  assert.throws(() => normalize({ ...base, command: "vyre", args: ["mcp"] }), own);
  assert.throws(() => normalize({ ...base, command: "/usr/local/bin/vyre", args: ["mcp"] }), own);
  assert.throws(() => normalize({ ...base, command: "node", args: ["/opt/vyre/bin/vyre.js", "mcp"] }), own);
  assert.throws(() => normalize({ ...base, command: "npx", args: ["vyre", "mcp"] }), own);
  assert.throws(() => normalize({ ...base, command: "node", args: ["/opt/vyre/harness/mcp/server.js"] }), own);
  assert.throws(() => normalize({ ...base, command: "/opt/vyre/harness/mcp/server.js" }), own);
  assert.equal(normalize({ ...base, command: "vyre-tracker", args: ["mcp"] }).command, "vyre-tracker", "another program is fine");
  assert.equal(normalize({ ...base, command: "vyre", args: ["status"] }).command, "vyre");
  assert.throws(() => normalize({ ...base, vars: { VYRE_HOME: "/tmp/x" } }), /VYRE_ settings belong to Vyre, not a server/);
  assert.throws(() => normalize({ ...base, env: { VYRE_AGENT_KEY: "gh-token" } }), /VYRE_ settings belong to Vyre/);
  assert.throws(() => normalize({ ...base, auth: { type: "env", item: "gh-token", var: "VYRE_HUB_CHILD" } }), /VYRE_ settings belong to Vyre/);
  const web = { name: "web", transport: "http", url: "https://mcp.northwind.example/mcp" };
  assert.equal(normalize(web).url, "https://mcp.northwind.example/mcp");
  assert.deepEqual(normalize({ ...web, headers: { "X-Team": "northwind" } }).headers, { "x-team": "northwind" });
  assert.throws(() => normalize({ ...web, headers: { "X-Api-Key": "abc" } }), /credential/);
  assert.throws(() => normalize({ ...web, headers: { "X-Thing": "Bearer abcdefghijkl" } }), /credential/);
  assert.throws(() => normalize({ ...web, env: { A: "b" } }), /stdio/);
  assert.throws(() => normalize({ ...web, auth: { type: "env", item: "a", var: "A" } }), /stdio/);
  assert.deepEqual(normalize({ ...web, auth: { type: "bearer", item: "tok", header: "X-Token", format: "token {value}" } }).auth,
    { type: "bearer", item: "tok", header: "x-token", format: "token {value}" });
  assert.throws(() => normalize({ ...web, auth: { type: "bearer", item: "tok", format: "nope" } }), /\{value\}/);
  assert.throws(() => normalize({ ...web, scope: { projects: "harlow-legal" } }), /scope.projects/);
  assert.throws(() => normalize({ ...web, tools: { mode: { x: "maybe" } } }), /read, write or off/);
  assert.throws(() => normalize({ ...web, tools: { mode: { send_message: "read" } } }), /send_message sends as the person, so it is always held and cannot be read: set send_message to write or off/);
  assert.throws(() => normalize({ ...web, tools: { mode: { postComment: "read" } } }), /always held/);
  assert.deepEqual(normalize({ ...web, tools: { mode: { send_message: "off", reply: "write", list_issues: "read" } } }).tools.mode, { send_message: "off", reply: "write", list_issues: "read" });
  assert.throws(() => normalize({ ...web, idle: 5 }), /idle/);
  assert.throws(() => normalize({ ...web, name: "a".repeat(33) }), /lowercase/);
  assert.throws(() => normalize({ ...web, name: "has_underscore" }), /lowercase/);
});

test("checkUrl: https anywhere, plain http only to this machine, the tailnet or a listed origin", () => {
  assert.ok(checkUrl("http://127.0.0.1:9/mcp") && checkUrl("http://localhost/mcp") && checkUrl("http://[::1]:3/x") && checkUrl("http://100.101.1.2/mcp"));
  assert.throws(() => checkUrl("http://100.1.2.3/mcp"), /https/);
  assert.throws(() => checkUrl("http://tracker.example.com/mcp"), /https/);
  assert.ok(checkUrl("http://tracker.lan:8080/mcp", ["http://tracker.lan:8080"]));
  assert.throws(() => checkUrl("ftp://x/y"), /http or https/);
  assert.throws(() => checkUrl("https://u:p@x.example/mcp"), /user or password/);
  assert.throws(() => checkUrl("https://x.example/mcp?api_key=abc"), /credential/);
  assert.ok(checkUrl("https://x.example/mcp?team=northwind"));
});

test("looksSecret and target", () => {
  assert.equal(looksSecret("gh-token"), false);
  assert.equal(looksSecret("/Users/alex/northwind/notes"), false);
  assert.equal(looksSecret("mcp.northwind.example"), false);
  assert.equal(looksSecret("ghp_abcdefghijklmnop"), true);
  assert.equal(looksSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGV4In0.sig"), true);
  assert.equal(looksSecret("q8ZkR2mV7xTn4LpW9sHc3JdF"), true);
  assert.deepEqual(target({ channel: "#northwind", to: "" }, "chat"), { key: "channel", to: ["#northwind"], list: false });
  assert.deepEqual(target({ to: ["dana@harlowlegal.com"] }, "chat"), { key: "to", to: ["dana@harlowlegal.com"], list: true });
  assert.deepEqual(target({ title: "x" }, "tracker"), { key: null, to: ["tracker"], list: false });
  assert.deepEqual(target({ channel_id: "C0NORTHWIND", text: "hi" }, "slack"), { key: "channel_id", to: ["C0NORTHWIND"], list: false });
});

test("whoFrom: people see all, a model is scoped by what vyred verified", () => {
  assert.deepEqual(whoFrom("cli"), { person: true, agent: null, thread: null });
  assert.deepEqual(whoFrom("module:capsule"), { person: true, agent: null, thread: null });
  assert.deepEqual(whoFrom("mcp:agent:juno", { thread: "t-1" }), { person: false, agent: "juno", thread: "t-1" });
  assert.deepEqual(whoFrom("mcp", { thread: "t-2" }), { person: false, agent: null, thread: "t-2" });
  assert.equal(whoFrom("harness:agent:kit").person, false);
});

// ---- a hub with a fake connect ----

function fakeHub({ values = {}, behave = {}, ...extra } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATIONS[0]);
  const events = [];
  const opened = [];
  const creds = new Credentials({ fetchItem: async item => { if (!(item in values)) throw new Error(`${item} is not granted`); return values[item]; } });
  const connect = async (spec, opts) => {
    const n = opened.length;
    const b = behave;
    const client = {
      transport: spec.transport, pid: 1, n,
      stderr: () => b.stderr ? [b.stderr] : [],
      async initialize() { if (opts.headers) await opts.headers(); if (b.initFail && b.initFail(n)) throw b.initFail(n); return {}; },
      async listTools() { return b.tools ? b.tools(n) : [{ name: "list_issues", annotations: { readOnlyHint: true } }, { name: "send_message" }]; },
      async callTool(name, args) {
        const h = opts.headers ? await opts.headers() : {};
        if (b.call) return b.call(n, name, args, h, opts);
        return { content: [{ type: "text", text: JSON.stringify({ name, args, h }) }] };
      },
      closed: false,
      async close() { this.closed = true; },
    };
    opened.push({ spec, opts, client });
    return client;
  };
  const held = new Map();
  const hub = new Hub({
    db, creds, connect, emit: (type, payload) => events.push({ type, payload }),
    request: async input => { const id = `h${held.size + 1}`; held.set(id, { ...input, state: "held", draft: input.content }); return { id, message: `Held as ${id}` }; },
    item: async id => held.get(id) || null, ...extra,
  });
  return { hub, db, events, opened, held, creds };
}

const person = { person: true, agent: null, thread: null };

test("hub: a 401 invalidates, reconnects and retries once; the token never comes back", async () => {
  const token = "fixture-abcdefghijklmnop-1234";
  let first = true;
  const { hub, opened } = fakeHub({ values: { tok: token }, behave: {
    call: (n, name, args, h) => {
      if (first) { first = false; throw new McpError("unauthorized", "401"); }
      return { content: [{ type: "text", text: `you sent ${h.authorization}` }], echo: Buffer.from(token).toString("base64") };
    },
  } });
  await hub.add({ name: "web", transport: "http", url: "https://mcp.northwind.example/mcp", auth: { type: "bearer", item: "tok" } });
  const r = await hub.call({ server: "web", tool: "list_issues" }, person);
  assert.equal(opened.length, 2, "one reconnect");
  assert.ok(opened[0].client.closed);
  assert.ok(!JSON.stringify(r).includes(token) && !JSON.stringify(r).includes(Buffer.from(token).toString("base64")), JSON.stringify(r));
  assert.equal(r.content[0].text, "you sent <concealed by vyre>");
});

test("hub: an error from the server is scrubbed, and a result over the cap is cut", async () => {
  const token = "fixture-zyxwvutsrqponm-9876";
  const { hub } = fakeHub({ values: { tok: token }, maxResult: 1000, behave: {
    call: (n, name) => { if (name === "list_issues") throw new McpError("rpc", `bad key ${token}`); return { content: [{ type: "text", text: "y".repeat(5000) }] }; },
    tools: () => [{ name: "list_issues" }, { name: "get_big" }],
  } });
  await hub.add({ name: "web", transport: "http", url: "https://mcp.northwind.example/mcp", auth: { type: "bearer", item: "tok" } });
  await hub.call({ server: "web", tool: "get_big" }, person).then(r => { assert.equal(r.truncated, true); assert.ok(JSON.stringify(r).length < 1300); });
  await assert.rejects(hub.call({ server: "web", tool: "list_issues" }, person), e => e.code === "rpc" && !e.message.includes(token));
});

test("hub: an error says whether the call may have reached the server (detail.reached)", async () => {
  let mode = "rpc";
  const { hub } = fakeHub({ behave: {
    call: () => { throw new McpError(mode, `${mode} happened`); },
    initFail: n => (mode === "start" && n > 0 ? new McpError("spawn_failed", "could not start") : null),
  } });
  await hub.add({ name: "web", transport: "http", url: "https://mcp.northwind.example/mcp" });
  const reached = async () => { try { await hub.run("web", "list_issues", {}); return "ran"; } catch (e) { return /** @type {any} */ (e).detail?.reached; } };
  assert.equal(await reached(), "no", "the server answered no itself");
  mode = "closed";
  assert.equal(await reached(), "maybe", "it closed mid-call: it may have run");
  mode = "timeout";
  assert.equal(await reached(), "maybe");
  mode = "exited";
  assert.equal(await reached(), "maybe");
  mode = "start";
  assert.equal(await reached(), "no", "it never started, so nothing was asked");
  await hub.stop();
});

test("hub: a failed add stands, does not spend the restart budget, and a missing grant reads plainly", async () => {
  const { hub } = fakeHub();
  const r = await hub.add({ name: "web", transport: "http", url: "https://mcp.northwind.example/mcp", auth: { type: "bearer", item: "tok" } });
  assert.equal(r.test.ok, false);
  assert.match(r.test.error, /tok could not be fetched: tok is not granted/);
  assert.equal(r.state, "stopped");
  assert.equal(hub.state("web").crashes.length, 0);
  await assert.rejects(hub.add({ name: "web", transport: "http", url: "https://mcp.northwind.example/mcp" }), /already/);
});

test("hub: release runs the approved arguments, only on the server the item was held for, and re-checks the tool", async () => {
  const { hub, held, opened } = fakeHub();
  await hub.add({ name: "chat", transport: "stdio", command: "node" });
  const who = { person: false, agent: "juno", thread: "t-1" };
  const h = await hub.call({ server: "chat", tool: "send_message", arguments: { to: "dana@harlowlegal.com", text: "hi" } }, who);
  assert.equal(h.held, "h1");
  const it = held.get("h1");
  assert.deepEqual([it.via, it.kind, it.to, it.agent, it.thread], ["mcp:chat", "send", ["dana@harlowlegal.com"], "juno", "t-1"]);

  await assert.rejects(hub.release({ id: "h1", to: ["dana@harlowlegal.com"], content: it.content }), /not an approved item/);
  it.state = "sending";
  await assert.rejects(hub.release({ id: "h1", to: ["x"], content: { ...it.content, server: "other" } }), /held for chat/);
  await assert.rejects(hub.release({ id: "h1", to: ["kit@northwind.example"], content: { ...it.content, arguments: { to: "alex@harlowlegal.com", text: "hi" } } }), /disagree/);
  const r = await hub.release({ id: "h1", to: ["dana@harlowlegal.com"], content: { ...it.content, arguments: { to: "dana@harlowlegal.com", text: "edited" } } });
  assert.deepEqual(JSON.parse(r.content[0].text).args, { to: "dana@harlowlegal.com", text: "edited" });
  assert.equal(opened.length, 1);

  await hub.update({ name: "chat", tools: { mode: { send_message: "off" } } });
  await assert.rejects(hub.release({ id: "h1", to: ["dana@harlowlegal.com"], content: it.content }), /no longer has send_message on/);
  await hub.remove({ name: "chat" });
  await assert.rejects(hub.release({ id: "h1", to: ["dana@harlowlegal.com"], content: it.content }), /removed/);
});

test("hub: an update that changes the connection stops the server and drops its cache; a scope change does not", async () => {
  const { hub, opened } = fakeHub();
  await hub.add({ name: "chat", transport: "stdio", command: "node" });
  assert.equal(hub.state("chat").state, "running");
  await hub.update({ name: "chat", scope: { agents: ["juno"] } });
  assert.equal(hub.state("chat").state, "running");
  await hub.update({ name: "chat", args: ["server.js"] });
  assert.equal(hub.state("chat").state, "stopped");
  assert.ok(opened[0].client.closed);
  assert.equal(hub.must("chat").cache, null);
  assert.deepEqual(await hub.tools(person), []);
  await hub.stop();
});

test("hub: a server whose tool list changed is re-cached on start", async () => {
  let v = 0;
  const { hub, events } = fakeHub({ behave: { tools: () => (v === 0 ? [{ name: "list_issues" }] : [{ name: "list_issues" }, { name: "get_issue" }]) } });
  await hub.add({ name: "t", transport: "stdio", command: "node" });
  assert.equal((await hub.tools(person)).length, 1);
  v = 1;
  await hub.restart({ name: "t" });
  assert.deepEqual((await hub.tools(person)).map(x => x.name), ["t__get_issue", "t__list_issues"]);
  assert.equal(events.filter(e => e.type === "mcp.refreshed").length, 2);
  await hub.stop();
});
