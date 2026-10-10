// @ts-check
// Connections against a fake box: tool names and inputs, the shapes picked, the words, and that a typed token is never echoed back.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o.error?.[tool]) return { error: o.error[tool] };
    if (o.data?.[tool] !== undefined) return { data: o.data[tool] };
    switch (tool) {
      case "connectors.catalog": return { data: { presets: [
        { id: "google-api", label: "Gmail and Google Calendar for Flows and watchers", group: "google", who: "Anyone with a Google account.", setup: "app", connected: [{ name: "google-api", mode: "api", label: "Work", scope: { projects: "*", agents: "*" } }] },
        { id: "linear", label: "Linear", group: "work", setup: "none", connected: [] },
        { id: "slack-via", label: "Slack", group: "work", setup: "via", via: "linear", connected: [{ name: "slack" }] },
        { nope: true }] } };
      case "mcp.servers": return { data: [
        { name: "tracker", transport: "stdio", state: "running", tools: 4, lastUsed: 1, command: "npx", args: ["tracker-mcp"], auth: { type: "env" }, env: { TRACKER_TOKEN: { item: "tracker", field: "token" }, OTHER: "other-item" }, scope: { projects: ["juniper"], agents: "*" }, policy: { mode: { send: "off", list: "read", bad: "zzz" } }, token: "leak" },
        { name: "docs", transport: "http", url: "https://docs.example.com/mcp", state: "weird", auth: { type: "bearer", item: "docs-key" }, scope: { assistant: true, agents: [] } }, { nope: 1 }] };
      case "mcp.test": return { data: { ok: true, ms: 120, tools: [{ tool: "list", outward: false }, { tool: "send", outward: true, sends: true }], stderr: ["a", "b"] } };
      case "google.accounts": return { data: [{ name: "work", email: "a@x.com", auth: { type: "service-account", item: "sa", subject: "a@x.com" }, secret: "x" }, { name: "home", email: "h@x.com", auth: { type: "oauth", item: "client" } }] };
      case "google.test": return { data: { ok: true, scopes: { "https://www.googleapis.com/auth/calendar": true, "https://www.googleapis.com/auth/gmail.readonly": false }, client_id: "123456789012", admin_scopes: "https://www.googleapis.com/auth/calendar,https://evil.example/x" } };
      case "google.connect": return { data: o.googleConnect ?? { id: "g1", url: "https://accounts.google.com/o/oauth2/auth?x=1" } };
      case "google.connect.finish": return { data: { name: "work", email: "a@x.com" } };
      case "github.accounts": return { data: [{ name: "work", login: "octo", avatar_url: "https://a", token: "leak" }] };
      case "github.connect": return { data: o.github ?? { id: "d1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", verification_uri_complete: "https://github.com/login/device?user_code=ABCD-1234", expires_in: 900 } };
      case "github.repos": return { data: { repos: [{ full_name: "o/r", name: "r", private: true, description: "d", updated_at: "2026-10-01T00:00:00Z" }, { nope: 1 }], more: true, page: 1 } };
      case "vault.list": return { data: { items: [{ name: "client", kind: "env-set", fields: ["client_id"], grants: [{ module: "google" }] }, { name: "old", kind: "secret", state: "trashed" }, { name: "key", kind: "api-key" }] } };
      case "vault.connections.list": return { data: [{ id: "c1", provider: "google-oauth", account: "a@x.com", label: "Work", state: "ready", capabilities: ["mail"], surfaces: ["chat", "bogus", "agents"], last_used: 5, needs: [{ module: "gate", need: "x" }] }, { provider: "mcp" }] };
      case "projects.list": return { data: { projects: [{ slug: "juniper", name: "Juniper" }, { name: "no slug" }] } };
      default: return { data: {} };
    }
  };
  return { call, seen };
}

test("catalog: groups in the box's order, junk dropped, a connected row keeps its scope (or none recorded)", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const g = await connectionsSource(box().call).catalog();
  assert.deepEqual(g.map((x) => [x.group, x.presets.map((p) => p.id)]), [["google", ["google-api"]], ["work", ["linear", "slack-via"]]]);
  assert.deepEqual(g[0].presets[0].connected[0], { name: "google-api", mode: "api", label: "Work", scope: { projects: "*", agents: "*" } });
  assert.equal(g[1].presets[1].connected[0].scope, undefined);
});

test("connect: only what was chosen is sent; each answer becomes one step", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const b = box({ data: { "connectors.connect": { step: "open", id: "f1", url: "https://vendor.example/auth" } } });
  const s = connectionsSource(b.call);
  assert.deepEqual(await s.connect("linear", "Linear"), { step: "open", id: "f1", url: "https://vendor.example/auth" });
  await s.connect("linear", "Linear", { scope: { projects: ["juniper"], agents: "*" }, token: "tok", extra: { team: "x" }, client: "c" });
  await s.connect("linear", "Linear", { scope: null, extra: {} });
  await s.connect("slack", "Slack", { app: { client_id: "id", client_secret: "sec" } });
  assert.deepEqual(b.seen.map((x) => x.input), [{ preset: "linear" }, { preset: "linear", scope: { projects: ["juniper"], agents: "*" }, token: "tok", extra: { team: "x" }, client: "c" }, { preset: "linear" }, { preset: "slack", app: { client_id: "id", client_secret: "sec" } }]);
});

test("steps: connected line, open with an https-only link, token, client, via", { skip: !strip }, async () => {
  const { stepOf } = await import("./model.ts");
  assert.deepEqual(stepOf({ step: "connected", tools: [1, 2, 3], warning: "Read only" }, "Linear"), { step: "connected", line: "Linear is connected, 3 tools. Read only" });
  assert.deepEqual(stepOf({ step: "connected" }, "Linear"), { step: "connected", line: "Linear is connected." });
  assert.deepEqual(stepOf({ step: "open", id: "f", url: "javascript:alert(1)" }, "x"), { step: "open", id: "f", url: null });
  assert.deepEqual(stepOf({ step: "needs", needs: "token", label: "API key", extra: [{ name: "team", required: true }, { label: "no name" }] }, "x"), { step: "token", label: "API key", help: "", guide: null, extra: [{ name: "team", label: "team", required: true }] });
  const two = [{ name: "client_id", label: "Client ID", secret: false, required: true }, { name: "client_secret", label: "Client secret", secret: true, required: true }];
  const c = stepOf({ step: "needs", needs: "client", help: "Make an app", redirect: "http://127.0.0.1/cb", fields: two, guide: { steps: ["Open the console", "Make an app"], links: [{ label: "Make it", url: "https://api.slack.com/apps?new_app=1" }, { label: "bad", url: "javascript:x" }] } }, "x");
  assert.deepEqual(c, { step: "client", help: "Make an app", redirect: "http://127.0.0.1/cb", fields: two, guide: { steps: ["Open the console", "Make an app"], links: [{ label: "Make it", url: "https://api.slack.com/apps?new_app=1" }] } });
  const bare = /** @type {any} */ (stepOf({ step: "needs", needs: "client" }, "x"));
  assert.deepEqual(bare.fields.map((/** @type {any} */ x) => x.name), ["client_id", "client_secret"]);
  assert.equal(bare.guide, null);
  assert.deepEqual(stepOf({ step: "via", via: "linear" }, "x"), { step: "via", message: "Connect this through linear." });
  assert.deepEqual(stepOf(null, "x"), { step: "none" });
});

test("cancel, finish, disconnect, scope: tool names and inputs", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const b = box();
  const s = connectionsSource(b.call);
  await s.connectCancel("f1"); await s.connectFinish("f1", "http://127.0.0.1/cb?code=1"); await s.disconnect("google-api"); await s.setScope("google-api", null); await s.setScope("google-api", { projects: "*", agents: "*" });
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [["connectors.connect.cancel", { id: "f1" }], ["connectors.connect.finish", { id: "f1", url: "http://127.0.0.1/cb?code=1" }], ["connectors.disconnect", { name: "google-api" }],
    ["connectors.scope", { name: "google-api", scope: null }], ["connectors.scope", { name: "google-api", scope: { projects: "*", agents: "*" } }]]);
});

test("who can use it: lines, choice to scope, scope to choice", { skip: !strip }, async () => {
  const { scopeLine, scopeOf, whoFrom } = await import("./model.ts");
  assert.equal(scopeLine(undefined), "Scope not recorded");
  assert.equal(scopeLine(null), "Just you and the assistant");
  assert.equal(scopeLine({ projects: "*", agents: "*" }), "All projects, every agent");
  assert.equal(scopeLine({ projects: "*", agents: ["kit"] }), "All projects, kit");
  assert.equal(scopeLine({ projects: ["a", "b"], agents: "*" }), "a, b");
  assert.equal(scopeLine({ projects: ["a"], agents: ["kit"] }), "a, kit");
  assert.equal(scopeOf({ mode: "me", projects: [] }), null);
  assert.deepEqual(scopeOf({ mode: "all", projects: [] }), { projects: "*", agents: "*" });
  assert.deepEqual(scopeOf({ mode: "some", projects: ["a"] }), { projects: ["a"], agents: "*" });
  assert.equal(scopeOf({ mode: "some", projects: [] }), undefined);
  assert.deepEqual(whoFrom({ projects: ["a"] }), { mode: "some", projects: ["a"] });
  assert.deepEqual(whoFrom({ projects: "*" }), { mode: "all", projects: [] });
  assert.deepEqual(whoFrom(null), { mode: "me", projects: [] });
});

test("MCP servers: only named fields, a bad state is stopped, env refs with fields, scope lines, tool modes", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const { authWords, serverScopeLine, serverHow, itemsOf, toolModes, testedLine } = await import("./model.ts");
  const b = box();
  const s = connectionsSource(b.call);
  const [t, d] = await s.servers();
  assert.equal(JSON.stringify([t, d]).includes("leak"), false);
  assert.equal(d.state, "stopped");
  assert.equal(authWords(t), "TRACKER_TOKEN from tracker.token, OTHER from other-item");
  assert.equal(authWords(d), "Bearer token, from docs-key");
  assert.equal(serverScopeLine(t), "juniper, every agent");
  assert.equal(serverScopeLine(d), "Just you and the assistant");
  assert.equal(serverHow(t), "npx tracker-mcp");
  assert.equal(serverHow(d), "https://docs.example.com/mcp");
  assert.deepEqual(itemsOf(t), ["tracker", "other-item"]);
  assert.deepEqual(t.policy.mode, { send: "off", list: "read" });
  const tested = await s.testServer("tracker");
  assert.deepEqual(toolModes(tested.tools, { ...t.policy.mode, gone: "off" }), [{ tool: "gone", mode: "off", sends: false }, { tool: "list", mode: "read", sends: false }, { tool: "send", mode: "off", sends: true }]);
  assert.deepEqual(toolModes(tested.tools).map((r) => [r.tool, r.mode]), [["list", "read"], ["send", "write"]]);
  assert.equal(testedLine(tested, 2), "Answered in 120 ms with 2 tools. A held tool waits at the Gate for you before anything reaches the server.");
  await s.restartServer("tracker"); await s.removeServer("tracker"); await s.setPolicy("tracker", { mode: { send: "write" } });
  assert.deepEqual(b.seen.slice(-3).map((x) => [x.tool, x.input]), [["mcp.restart", { name: "tracker" }], ["mcp.remove", { name: "tracker" }], ["mcp.update", { name: "tracker", tools: { mode: { send: "write" } } }]]);
});

test("a new server: the first thing wrong in words, else the exact input", { skip: !strip }, async () => {
  const { serverInput, itemsNeeded } = await import("./model.ts");
  const base = { name: "tracker", transport: /** @type {"stdio"} */ ("stdio"), command: " npx ", args: "tracker-mcp  --x", url: "", auth: /** @type {"none"} */ ("none"), item: "", env: [], who: { mode: /** @type {"me"} */ ("me"), projects: [] } };
  assert.deepEqual(serverInput(base), { input: { name: "tracker", transport: "stdio", command: "npx", args: ["tracker-mcp", "--x"], auth: { type: "none" } } });
  assert.deepEqual(serverInput({ ...base, name: "Tracker" }), { error: "A name is lowercase letters, digits and dashes." });
  assert.deepEqual(serverInput({ ...base, name: "" }), { error: "Give the server a name." });
  assert.deepEqual(serverInput({ ...base, command: "" }), { error: "Say the command that starts it." });
  assert.deepEqual(serverInput({ ...base, transport: "http", url: "ftp://x" }), { error: "A web address that starts with https://." });
  assert.deepEqual(serverInput({ ...base, transport: "http", url: "https://x.example/mcp", auth: "bearer" }), { error: "Choose the vault item this server uses." });
  assert.deepEqual(serverInput({ ...base, transport: "http", url: "https://x.example/mcp", auth: "bearer", item: "k", who: { mode: "all", projects: [] } }), { input: { name: "tracker", transport: "http", url: "https://x.example/mcp", auth: { type: "bearer", item: "k" }, scope: { projects: "*", agents: "*" } } });
  assert.deepEqual(serverInput({ ...base, auth: "env", env: [{ var: "T", item: "", field: "" }] }), { error: "Each variable needs a name and a vault item." });
  assert.deepEqual(serverInput({ ...base, auth: "env", env: [] }), { error: "Name at least one variable and its vault item, or choose None." });
  const e = serverInput({ ...base, auth: "env", env: [{ var: "T", item: "tok", field: "token" }, { var: "U", item: "u", field: "" }, { var: "", item: "", field: "" }] });
  assert.deepEqual(/** @type {any} */ (e).input.env, { T: { item: "tok", field: "token" }, U: "u" });
  assert.deepEqual(itemsNeeded(/** @type {any} */ (e).input), ["tok", "u"]);
  assert.deepEqual(serverInput({ ...base, who: { mode: "some", projects: [] } }), { error: "Choose at least one project." });
});

test("add server: the first test result comes back when the box ran one", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const b = box({ data: { "mcp.add": { test: { ok: false, error: "no", ms: 3 } } } });
  const r = await connectionsSource(b.call).addServer({ name: "x" });
  assert.deepEqual(r.test && { ok: r.test.ok, error: r.test.error }, { ok: false, error: "no" });
  assert.equal((await connectionsSource(box({ data: { "mcp.add": {} } }).call).addServer({ name: "x" })).test, null);
});

test("Google: accounts, a scope check that keeps only Google scope URLs, sign-in start and finish", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const { accountAuthLine, scopeLines, accountInput } = await import("./model.ts");
  const b = box();
  const s = connectionsSource(b.call);
  const [w, h] = await s.accounts();
  assert.equal(JSON.stringify(w).includes("secret"), false);
  assert.equal(accountAuthLine(w), "Service account acting as a@x.com");
  assert.equal(accountAuthLine(h), "OAuth");
  const t = await s.testAccount("work");
  assert.deepEqual(scopeLines(t), [{ scope: "https://www.googleapis.com/auth/calendar", ok: true }, { scope: "https://www.googleapis.com/auth/gmail.readonly", ok: false }]);
  assert.equal(t.adminScopes, "https://www.googleapis.com/auth/calendar");
  assert.equal(t.clientId, "123456789012");
  assert.deepEqual(await s.googleConnect("work", "client"), { id: "g1", url: "https://accounts.google.com/o/oauth2/auth?x=1" });
  await assert.rejects(connectionsSource(box({ googleConnect: { id: "g", url: "http://not-https" } }).call).googleConnect("w", "c"), /did not return Google's address/);
  assert.deepEqual(await s.googleFinish("g1", "http://127.0.0.1/cb?code=1"), { name: "work", email: "a@x.com" });
  await s.googleCancel("g1"); await s.removeAccount("home"); await s.addAccount({ name: "x" });
  assert.deepEqual(b.seen.filter((x) => /^google\.(connect|remove|add)/.test(x.tool)).map((x) => [x.tool, x.input]), [["google.connect", { name: "work", client: "client" }], ["google.connect.finish", { id: "g1", url: "http://127.0.0.1/cb?code=1" }], ["google.connect.cancel", { id: "g1" }], ["google.remove", { name: "home" }], ["google.add", { name: "x" }]]);
  assert.deepEqual(accountInput({ name: " work ", email: " a@x.com ", type: "service-account", item: "sa", subject: " b@x.com " }), { input: { name: "work", email: "a@x.com", auth: { type: "service-account", item: "sa", subject: "b@x.com" } } });
  assert.deepEqual(accountInput({ name: "w", email: "", type: "oauth", item: "i", subject: "" }), { error: "Give the account a name and its address." });
  assert.deepEqual(accountInput({ name: "w", email: "a@x.com", type: "oauth", item: "", subject: "" }), { error: "Choose the vault item this account uses." });
});

test("GitHub: accounts without a token, the device code with GitHub's own link only, a token connect, repos", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const b = box();
  const s = connectionsSource(b.call);
  const a = await s.githubAccounts();
  assert.deepEqual(a, [{ name: "work", login: "octo", avatar: "https://a" }]);
  assert.deepEqual(await s.githubDevice("work"), { id: "d1", code: "ABCD-1234", uri: "https://github.com/login/device", open: "https://github.com/login/device?user_code=ABCD-1234", minutes: 15 });
  const evil = await connectionsSource(box({ github: { id: "d", user_code: "X", verification_uri: "https://evil.example/x", expires_in: 30 } }).call).githubDevice("w");
  assert.equal(evil.open, "https://github.com/login/device");
  assert.equal(evil.minutes, 1);
  await assert.rejects(connectionsSource(box({ github: {} }).call).githubDevice("w"), /did not return a code/);
  assert.deepEqual(await connectionsSource(box({ github: { login: "octo", repos: 12 } }).call).githubToken("w", TOKEN), { login: "octo", repos: 12 });
  const r = await s.githubRepos({ account: "work", q: "r", page: 2 });
  assert.deepEqual(r.repos, [{ full: "o/r", name: "r", private: true, description: "d", updated: Date.parse("2026-10-01T00:00:00Z") }]);
  assert.equal(r.more, true);
  await s.githubRepos({}); await s.githubCancel("d1"); await s.githubRemove("work");
  assert.deepEqual(b.seen.filter((x) => x.tool.startsWith("github.")).slice(-4).map((x) => [x.tool, x.input]), [["github.repos", { account: "work", q: "r", page: 2, limit: 30 }], ["github.repos", { page: 1, limit: 30 }], ["github.connect.cancel", { id: "d1" }], ["github.remove", { name: "work" }]]);
});

test("a typed token is never echoed: masked in an error, and by exact match", { skip: !strip }, async () => {
  const { words, redact } = await import("./model.ts");
  assert.equal(words({ code: "bad", message: `Bad credentials for ${TOKEN}` }), "Bad credentials for [hidden]");
  assert.equal(words({ code: "bad", message: "the key is hunter22 here" }, ["hunter22"]), "the key is [hidden] here");
  assert.equal(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), "Authorization: Bearer [hidden]");
  assert.equal(redact("short", ["abc"]), "short");
  assert.equal(words({ code: "no_such_tool" }), "Connectors are not running on your server yet.");
  assert.equal(words(null), "That did not go through.");
});

test("vault items, grants and connections by surface", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const { itemsFor, since } = await import("./model.ts");
  const b = box();
  const s = connectionsSource(b.call);
  const items = await s.vaultItems();
  assert.deepEqual(items.map((i) => i.name), ["client", "key"]);
  assert.deepEqual(itemsFor(items, "signin").map((i) => i.name), ["client"]);
  assert.deepEqual(itemsFor(items, "bearer").map((i) => i.name), ["key"]);
  await s.grantItem("client", "google");
  const c = await s.connections();
  assert.deepEqual(c.map((x) => [x.id, x.word, x.label, x.ready, x.surfaces]), [["c1", "Google", "Work", true, ["chat", "agents"]]]);
  await s.grantSurface("c1", "agents"); await s.revokeSurface("c1", "chat");
  assert.deepEqual(b.seen.filter((x) => x.tool !== "vault.list" && x.tool !== "vault.connections.list").map((x) => [x.tool, x.input]), [["vault.grant", { name: "client", module: "google" }], ["vault.connections.grant", { id: "c1", surface: "agents" }], ["vault.connections.revoke", { id: "c1", surface: "chat" }]]);
  assert.deepEqual(await s.projects(), [{ slug: "juniper", name: "Juniper" }]);
  const now = Date.parse("2026-10-05T12:00:00Z");
  assert.deepEqual([since(null, now), since(now - 30_000, now), since(now - 5 * 60_000, now), since(now - 3 * 3600_000, now), since(now - 3 * 86400_000, now)], ["never", "just now", "5 min ago", "3 h ago", "3 days ago"]);
});

test("errors keep their code", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  await assert.rejects(connectionsSource(box({ error: { "mcp.servers": { code: "no_such_tool", message: "gone" } } }).call).servers(), (e) => /** @type {any} */ (e).code === "no_such_tool");
});

test("any app: the form's problems are said in words, the GoHighLevel form becomes the create input, and the key is only ever named", { skip: !strip }, async () => {
  const { emptyForm, formProblem, toCreate } = await import("./any-app.ts");
  const ghl = () => ({ ...emptyForm(), label: "GoHighLevel Sales", baseUrl: "https://services.leadconnectorhq.com/", how: /** @type {const} */ ("bearer"), item: "ghl-sales-pat",
    headers: [{ name: "Version", value: "2021-07-28" }, { name: "", value: "" }], vars: [{ name: "locationId", value: "abc123" }], checkPath: "/locations/{locationId}" });
  assert.equal(formProblem(ghl()), null);
  assert.deepEqual(toCreate(ghl()), { label: "GoHighLevel Sales", base_url: "https://services.leadconnectorhq.com", send: { how: "bearer" }, credential: { item: "ghl-sales-pat" },
    headers: { Version: "2021-07-28" }, vars: { locationId: "abc123" }, check: { path: "/locations/{locationId}" } });
  const bad = (/** @type {any} */ o, /** @type {RegExp} */ re) => assert.match(String(formProblem({ ...ghl(), ...o })), re);
  bad({ label: " " }, /Give the connection a name/);
  bad({ baseUrl: "http://x.example.com" }, /API address with no path/);
  bad({ baseUrl: "https://x.example.com/api" }, /no path/);
  bad({ how: "header", name: "" }, /Name the header/);
  bad({ how: "query", name: "" }, /Name the query parameter/);
  bad({ item: "" }, /Pick the Vault item/);
  bad({ checkPath: "locations" }, /one request that proves the key works/);
  bad({ checkPath: "/locations/{other}" }, /uses \{other\}/);
  bad({ vars: [{ name: "locationId", value: "" }] }, /fixed value needs a name and a value|Each fixed value/);
  bad({ headers: [{ name: "Authorization", value: "Bearer x" }] }, /key is added for you/);
  bad({ headers: [{ name: "Version", value: "" }] }, /fixed header needs/);
  assert.deepEqual(toCreate({ ...ghl(), how: "query", name: "api_key" }).send, { how: "query", name: "api_key" });
});

test("any app: the list is picked from the box's answer, and a new connection is created and then checked once", { skip: !strip }, async () => {
  const { pickMade, lightWords } = await import("./any-app.ts");
  const { connectionsSource } = await import("./source.ts");
  const list = { connections: [
    { id: "ghl", label: "GoHighLevel Sales", host: "services.leadconnectorhq.com", light: "green", reason: "connected", checked_at: 5, operations: [{ name: "contacts.get", label: "Get", kind: "read" }, { name: "contacts.search", kind: "read", relabeled: true }] },
    { id: "x", label: "Odd", light: "weird" }, { nope: true }] };
  const picked = pickMade(list);
  assert.deepEqual(picked.map((c) => [c.id, c.light]), [["ghl", "green"], ["x", "unknown"]]);
  assert.deepEqual(picked[0].operations.map((o) => [o.name, o.relabeled]), [["contacts.get", false], ["contacts.search", true]]);
  assert.equal(lightWords(picked[0]), "Working");
  assert.equal(lightWords({ light: "red", reason: "the key was refused (401)" }), "the key was refused (401)");
  assert.equal(lightWords({ light: "out_of_step", reason: "" }), "Needs saving again");
  assert.equal(lightWords(picked[1]), "Not checked yet");
  const b = box({ data: { "connectors.connection.list": list, "connectors.connection.create": { id: "ghl", credential: "conn-ghl" }, "connectors.connection.check": { id: "ghl", light: "red", words: "the key was refused (401)" } } });
  const s = connectionsSource(b.call);
  assert.equal((await s.madeList()).length, 2);
  const { emptyForm } = await import("./any-app.ts");
  const r = await s.madeCreate({ ...emptyForm(), label: "GoHighLevel Sales", baseUrl: "https://services.leadconnectorhq.com", item: "ghl-sales-pat", checkPath: "/me" });
  assert.deepEqual(r, { id: "ghl", light: "red", words: "the key was refused (401)" });
  assert.deepEqual(b.seen.slice(-2).map((x) => x.tool), ["connectors.connection.create", "connectors.connection.check"]);
  assert.deepEqual(b.seen.at(-1)?.input, { id: "ghl" });
});

test("any app: an assistant's proposal is shown as the card the person is asked, and yes or no are one call each", { skip: !strip }, async () => {
  const { pickProposals } = await import("./any-app.ts");
  const { connectionsSource } = await import("./source.ts");
  const raw = { proposals: [{ proposal: "prop_1", by: "mcp", why: "from their docs", form: { label: "x" }, card: { title: "Connect Acme?", lines: ["It can reach api.acme.example and nothing else."] } }, { proposal: "bad" }, { nope: 1 }] };
  assert.deepEqual(pickProposals(raw), [{ id: "prop_1", by: "mcp", why: "from their docs", title: "Connect Acme?", lines: ["It can reach api.acme.example and nothing else."] }]);
  const b = box({ data: { "connectors.connection.proposals": raw } });
  const s = connectionsSource(b.call);
  assert.equal((await s.madeProposals()).length, 1);
  await s.madeApprove("prop_1"); await s.madeDecline("prop_2");
  assert.deepEqual(b.seen.slice(1).map((x) => [x.tool, x.input]), [["connectors.connection.approve", { proposal: "prop_1" }], ["connectors.connection.decline", { proposal: "prop_2" }]]);
});

test("one list of what is connected: apps and MCP servers together, each with a plain word, sorted, each opening its own tab", { skip: !strip }, async () => {
  const { unifyConnected, pickMade } = await import("./any-app.ts");
  const made = pickMade({ connections: [{ id: "ghl", label: "GoHighLevel Sales", host: "services.leadconnectorhq.com", light: "green", reason: "connected" }, { id: "x", label: "Acme", host: "api.acme.example", light: "red", reason: "the key was refused (401)" }] });
  const servers = [{ name: "tracker", state: "running", error: "", tools: 4, url: "https://tracker.example.com/mcp", command: "" }, { name: "docs", state: "failed", error: "it would not start", tools: null, url: "", command: "npx" }];
  const all = unifyConnected(made, servers);
  assert.deepEqual(all.map((c) => [c.label, c.kind, c.status]), [["Acme", "api", "bad"], ["docs", "mcp", "bad"], ["GoHighLevel Sales", "api", "ok"], ["tracker", "mcp", "ok"]]);
  assert.equal(all.find((c) => c.label === "tracker")?.words, "Running, 4 tools");
  assert.equal(all.find((c) => c.label === "tracker")?.where, "tracker.example.com");
  assert.equal(all.find((c) => c.label === "docs")?.words, "it would not start");
  assert.equal(all.find((c) => c.label === "Acme")?.words, "the key was refused (401)");
  assert.deepEqual(unifyConnected([], []), []);
});
