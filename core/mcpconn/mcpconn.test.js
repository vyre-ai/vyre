// @ts-check
// The person's own AI, connected (core/mcpconn), on a real daemon with the kernel on. The person connects once with presence; from then on a call on the connection is the person's own: the
// person-only setup tools work for it as in the app, outward acts and the person's face-and-key tools do not, a revoke ends it at once, and nothing but the person's own call can make one.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("connect once, then the client is the person: setup tools work, the person's keys and outward acts do not, revoke ends it", { timeout: 240_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ recall: { every: 0 } }));
  const d = await start({ root, log: () => {}, kernel: true, presence: present, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const opts = { root };
  const proof = { root, headers: { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ method: "stand-in" })).toString("base64url") } };
  const noted = /** @type {any[]} */ ([]);
  d.registry.deps.events?.on?.("mcpconn.did", (/** @type {any} */ e) => noted.push(e));

  // The mark is the daemon's alone: a plain meta { viaMcp } on an in-process call changes nothing, whatever the label.
  for (const forged of [{ viaMcp: "mcn_x" }, { viaMcp: true }, { "viaMcp": "mcn_x", person: { id: "x" } }]) {
    const f = await d.registry.call("projects.create", { name: "Forged", home: path.join(work, "forged") }, "mcp", forged);
    assert.ok(f.error, "a forged viaMcp is refused: " + JSON.stringify(f).slice(0, 160));
  }
  assert.ok(!(d.registry.listTools("mcp", { viaMcp: "mcn_x" }).some((/** @type {any} */ x) => x.name === "projects.create")), "and the listing ignores it too");
  // Not connected: a plain mcp caller has no setup tools; a forged key is refused outright.
  assert.ok((await call("projects.create", { name: "Harlow Legal", home: path.join(work, "harlow") }, { root, caller: "mcp" })).error, "a plain mcp caller has no setup tools");
  assert.equal((await call("projects.list", {}, { root, caller: "mcp", headers: { "x-vyre-mcp-id": "mcn_x", "x-vyre-mcp-key": "nope" } })).error.code, "denied");
  // Only the person connects, and a model cannot.
  assert.ok((await call("mcpconn.connect", {}, { root, caller: "mcp" })).error, "a model cannot connect itself");
  const made = await call("mcpconn.connect", { name: "Claude Code on laptop" }, proof);
  assert.ok(!made.error, JSON.stringify(made));
  assert.match(made.data.snippets.codex, /codex mcp add vyre/);
  assert.equal(made.data.name, "Claude Code on laptop");
  const file = path.join(root, "mcp-connection.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the secret is readable by this OS user only");
  const { id, key } = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(id, made.data.id);
  assert.equal(made.data.key, `${id}~${key}`, "the key is shown once, at creation");
  assert.ok(!JSON.stringify((await call("mcpconn.list", {}, opts)).data).includes(key), "the list never holds the secret");
  assert.equal((await call("mcpconn.list", {}, opts)).data[0].name, "Claude Code on laptop");
  const as = { root, caller: "mcp", headers: { "x-vyre-mcp-id": id, "x-vyre-mcp-key": key } };

  // As the person: the setup tools, including the ones the person alone does in the app.
  const proj = await call("projects.create", { name: "Harlow Legal", home: path.join(work, "harlow") }, as);
  assert.ok(!proj.error, JSON.stringify(proj));
  assert.ok(!(await call("agents.create", { name: "intake-bot", instructions: "Answer intake.", projects: [] }, as)).error, "an agent");
  const def = await call("records.define", { diff: { add_types: [{ name: "client", label: "Client", fields: [{ name: "name", kind: "text", label: "Name" }] }] } }, as);
  assert.ok(!def.error, "records.define as the person: " + JSON.stringify(def).slice(0, 300));
  const types = await call("records.types", {}, as);
  assert.ok((types.data.types || []).some((/** @type {any} */ x) => x.name === "client"), JSON.stringify(types).slice(0, 200));
  assert.ok(!(await call("import.sessions.list", {}, as)).error, "the sessions scan is the person's");
  assert.match((await call("mcpconn.guide", {}, as)).data.guide, /import_sessions_run/);

  // Bringing sessions in: filed in the project as the person (relay), and taken back when the upload cannot start (no server here), so a project never keeps sessions that did not go.
  const tr = path.join(root, "claude", "projects", "-x-Work-harlow");
  fs.mkdirSync(tr, { recursive: true });
  const sid = "44444444-0000-4000-8000-000000000001";
  fs.writeFileSync(path.join(tr, `${sid}.jsonl`), JSON.stringify({ type: "user", cwd: "/home/alex/Work/harlow-site", message: { content: "hello" } }) + "\n");
  const sc = await call("import.sessions.list", { folders: [tr] }, as);
  assert.ok(!sc.error && sc.data.sessions.some((/** @type {any} */ x) => x.id === sid), "the scan sees a session in a folder it is given: " + JSON.stringify(sc).slice(0, 200));
  // Over a key the run is held for the person's yes, a card, not a flag the AI sets itself.
  const held = await call("import.sessions.run", { sessions: [{ id: sid, project: "Harlow Legal" }] }, as);
  assert.equal(held.error && held.error.code, "held_for_approval", "a key's import waits at the Gate: " + JSON.stringify(held).slice(0, 200));
  const th = await call("projects.threads", { project: "Harlow Legal" }, as);
  assert.ok(!JSON.stringify(th.data || "").includes(sid), "nothing was filed while the run waits for the person: " + JSON.stringify(th).slice(0, 200));

  // What stays the person's: connecting and revoking themselves, their keys, pairing, the vault, a face.
  for (const [tool, input] of [["mcpconn.connect", {}], ["mcpconn.revoke", { id }], ["pluginagent.grant", {}], ["vault.provider.set", { provider: "x" }], ["presence.keys", {}]]) {
    const r = await call(tool, input, as);
    assert.ok(r.error, `${tool} is not for a connected client: ${JSON.stringify(r).slice(0, 120)}`);
  }
  assert.ok(!(await request("GET", "/v1/tools", undefined, as)).error, "it lists tools");

  // An outward act is still held for it, like any model's: it does not run on the person's say-so alone.
  const sent = await call("mail.send", { to: ["x@example.com"], subject: "hi", body: "hi" }, as);
  assert.equal(sent.error && sent.error.code, "held_for_approval", "mail.send waits at the Gate: " + JSON.stringify(sent).slice(0, 200));

  // Each change is noted by tool name, never input.
  assert.ok(noted.some(n => n.payload.tool === "projects.create" && n.payload.ok === true && n.payload.says === "via Claude Code on laptop"), JSON.stringify(noted));
  assert.ok(noted.every(n => !JSON.stringify(n).includes("Harlow")), "no input in the note");

  const act = (await call("mcpconn.activity", {}, opts)).data;
  assert.ok(act.some((/** @type {any} */ a) => a.tool === "projects.create" && a.ok && a.name === "Claude Code on laptop" && a.says === "via Claude Code on laptop"), JSON.stringify(act).slice(0, 200));
  assert.ok(!JSON.stringify(act).includes("Harlow"), "the activity names tools, never input");

  // Revoke: the same key is refused at once.
  const rv = await call("mcpconn.revoke", { id }, opts);
  assert.ok(!rv.error, JSON.stringify(rv));
  assert.equal((await call("projects.list", {}, as)).error.code, "denied");
  assert.ok(!fs.existsSync(file), "the file went with it");
  assert.equal((await call("mcpconn.list", {}, opts)).data.find((/** @type {any} */ c) => c.id === id).revoked, true);

  const local2 = await call("mcpconn.connect", { name: "Codex" }, proof);
  const f2 = JSON.parse(fs.readFileSync(file, "utf8"));
  const as2 = { root, caller: "mcp", headers: { "x-vyre-mcp-id": f2.id, "x-vyre-mcp-key": f2.key } };
  assert.ok(!local2.error);
  // Hosted: a second key, named for another agent, over streamable HTTP with a Bearer key. Same tools as `vyre mcp`, run as the person; the name shows in Activity; a revoke is a 401 on the next call.
  const h = await call("mcpconn.connect", { name: "Zapier agent", hosted: true }, proof);
  assert.ok(!h.error, JSON.stringify(h));
  assert.equal(h.data.local, false);
  assert.match(h.data.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/, "on loopback until the public gate carries it");
  assert.match(h.data.snippets.claude, /claude mcp add --transport http vyre-zapier-agent .*\/mcp --header "Authorization: Bearer /);
  assert.ok(JSON.parse(h.data.snippets.json).mcpServers["vyre-zapier-agent"].headers.Authorization.startsWith("Bearer "));
  const post = (/** @type {any} */ msg, /** @type {string} */ token) => fetch(h.data.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(msg) });
  const rpc = async (/** @type {any} */ msg) => { const r = await post(msg, h.data.key); return { status: r.status, body: r.status === 200 ? await r.json() : null }; };
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" })).status, 401, "no key, no entry");
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, "mcn_x~nope")).status, 401, "a wrong key");
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, "vyre");
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, h.data.key)).status, 202);
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(list.body.result.tools.some((/** @type {any} */ x) => x.name === "tools_call"), "the same tool surface `vyre mcp` offers");
  const did = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tools_call", arguments: { tool: "projects.create", arguments: { name: "Northwind", home: path.join(work, "northwind") } } } });
  assert.equal(did.status, 200);
  assert.ok(!did.body.result.isError, JSON.stringify(did.body).slice(0, 300));
  const hostedAct = (await call("mcpconn.activity", {}, opts)).data;
  assert.ok(hostedAct.some((/** @type {any} */ a) => a.name === "Zapier agent" && a.tool === "projects.create" && a.says === "via Zapier agent"), JSON.stringify(hostedAct).slice(0, 300));
  const rows = (await call("mcpconn.list", {}, opts)).data;
  assert.deepEqual(rows.filter((/** @type {any} */ c) => !c.revoked && c.hosted).map((/** @type {any} */ c) => [c.name, c.where]), [["Zapier agent", "hosted"]]);
  assert.ok(rows.find((/** @type {any} */ c) => c.name === "Zapier agent").lastUsed, "last used is kept");
  // it cannot see beyond its person: the person's own face-and-key tools are out of reach over HTTP too
  const face = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tools_call", arguments: { tool: "mcpconn.connect", arguments: { name: "me too" } } } });
  assert.ok(face.body.result.isError || JSON.stringify(face.body).includes("denied") || JSON.stringify(face.body).includes("no_such_tool") || JSON.stringify(face.body).includes("not_in"), "a key cannot make keys: " + JSON.stringify(face.body).slice(0, 200));
  // A hosted key has an invisible deny-list, one test per category: code on the box, credentials and connections, devices, people and roles, keys. A local key keeps its reach.
  const { HOSTED_NEVER } = await import("../modules/agent-reach.js");
  const REP = { code: ["appmods.install", "term.open", "hooks.enable", "runner.start", "threads.shell", "agents.spawn", "learn.skill-install", "team.duties.run-now", "work.template.install", "flows.kit.propose", "mcp.add"], desktop: ["computer.use", "chrome.open", "chrome.type", "glass.take", "hands-desktop.act"], credentials: ["vault.list", "vault.delete", "google.add", "connectors.connect", "sessions.accounts.key", "github.connect", "settings.set", "onboard.passkey", "push.key"],
    devices: ["computers.list", "spaces.devices.remove", "relay.devices.remove", "link.unpair", "network.wink.join"], people: ["roles.list", "spaces.members.add", "spaces.invites.create", "projects.access.grant"], keys: ["mcpconn.list", "outside.token"] };
  assert.deepEqual(Object.keys(REP).sort(), Object.keys(HOSTED_NEVER).sort(), "a test for every category");
  let n = 0;
  for (const [cat, tools] of Object.entries(REP)) for (const tool of tools) {
    if (!d.registry.tools.has(tool)) continue;
    n++;
    const r = await rpc({ jsonrpc: "2.0", id: 100 + n, method: "tools/call", params: { name: "tools_call", arguments: { tool, arguments: {} } } });
    assert.ok(r.body.result.isError && /hosted key|that you may use/.test(JSON.stringify(r.body)), `${cat}: ${tool} is refused to a hosted key: ` + JSON.stringify(r.body).slice(0, 200));
  }
  // and the registry itself refuses them for a marked hosted key, whatever the server's catalog says
  const { markViaMcp } = await import("../modules/via-mcp.js");
  for (const [cat, tools] of Object.entries(REP)) for (const tool of tools) {
    if (!d.registry.tools.has(tool)) continue;
    const r = await d.registry.call(tool, {}, "mcp", markViaMcp({}, "mcn_x", true));
    assert.ok(r.error && /hosted key/.test(r.error.message || ""), `${cat}: ${tool} in the registry: ` + JSON.stringify(r).slice(0, 160));
  }
  assert.ok(n >= 20, "most representatives exist: " + n);
  // the allowlist is the first wall and the deny-list the second: no tool that can run code, drive a screen, install or make a key passes, however it is named
  const { hostedKeyMay } = await import("../modules/agent-reach.js");
  const risky = [...d.registry.tools.keys()].filter(t => /shell|exec|install|passkey|spawn|desktop|computer|chrome|glass|screen|hands/.test(t) && hostedKeyMay(t));
  assert.deepEqual(risky, [], "a hosted key reaches a tool that can run code or drive a screen");
  for (const ok of ["recall.search", "memory.ask", "records.list", "projects.list", "projects.create", "planner.agenda", "import.sessions.list", "threads.send"]) if (d.registry.tools.has(ok)) assert.ok(hostedKeyMay(ok), `${ok} is what a hosted key is for`);
  assert.ok(!hostedKeyMay("some.new-tool"), "a tool nobody placed is refused to a hosted key");
  // the same call on a LOCAL key is not refused for being hosted
  assert.ok(!JSON.stringify(await call("roles.list", {}, as2)).includes("hosted key"), "a local key keeps its reach");
  // revoke is one call, and the next request is a 401
  assert.ok(!(await call("mcpconn.revoke", { id: h.data.id }, opts)).error);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" })).status, 401, "the next call after a revoke is a 401");
});
