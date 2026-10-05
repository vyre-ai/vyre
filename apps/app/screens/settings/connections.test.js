// @ts-check
// Connections (the Deck's connections.js, ported): what is drawn from mcp.servers, google.accounts and github.accounts, and the calls behind each button, over a fake box.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const SERVERS = [
  { name: "gmail", transport: "stdio", state: "running", tools: 12, lastUsed: 5, command: "npx", args: ["-y", "gmail-mcp"], auth: { type: "env" }, env: { TOKEN: { item: "gmail-token", field: "value" }, EMPTY: "" }, scope: { projects: "*", agents: "*" }, policy: { mode: { "gmail__send": "write", "gmail__x": "bogus" } } },
  { name: "docs", transport: "http", state: "weird", url: "https://docs.example/mcp", auth: { type: "bearer", item: "docs-key" }, scope: { assistant: true, agents: [], projects: [] }, error: "boom", secret: "never copied", tools: null },
  { nope: 1 }, null,
];
const TEST = { ok: true, ms: 40, tools: [{ tool: "gmail__send", outward: true, sends: true }, { tool: "gmail__read", outward: false }, { tool: "z", tool_extra: 1 }, { nothing: 1 }], stderr: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] };

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return o[tool] || { data: tool === "mcp.servers" ? SERVERS : tool === "mcp.test" ? TEST : {} }; };
  return { call, seen };
}

test("servers: only the drawn fields come through, a strange state is stopped, each line says what it is", { skip: !strip }, async () => {
  const m = await import("./connections-model.ts");
  const rows = m.pickServers(SERVERS);
  assert.deepEqual(rows.map((r) => [r.name, r.state]), [["gmail", "running"], ["docs", "stopped"]]);
  assert.ok(!JSON.stringify(rows).includes("never copied"), "a stray field in a reply never reaches the screen");
  assert.equal(m.authWords(rows[0]), "TOKEN from gmail-token.value");
  assert.equal(m.authWords(rows[1]), "Bearer token, from docs-key");
  assert.equal(m.scopeLine(rows[0]), "Every project · every agent");
  assert.equal(m.scopeLine(rows[1]), "Just you and the assistant");
  assert.equal(m.runsLine(rows[0]), "npx -y gmail-mcp");
  assert.equal(m.runsLine(rows[1]), "https://docs.example/mcp");
  assert.equal(m.toolsLine(rows[1]), "Not listed yet. Test lists them.");
  assert.deepEqual(rows[0].policy.mode, { gmail__send: "write" }, "a mode the hub does not know is dropped");
});

test("test: the tools come back with a mode each, a sender is held and never Read, a tool set Off stays listed", { skip: !strip }, async () => {
  const m = await import("./connections-model.ts");
  const t = m.pickTest(TEST);
  assert.deepEqual([t.ok, t.ms, t.tools.length, t.stderr.length], [true, 40, 3, 8], "the last eight stderr lines");
  const rows = m.toolModes(t.tools, { gmail__old: "off" });
  assert.deepEqual(rows.map((r) => [r.tool, r.mode, r.set, r.sends]), [["gmail__old", "off", true, false], ["gmail__read", "read", false, false], ["gmail__send", "write", false, true], ["z", "write", false, false]]);
  const [s] = m.pickServers(SERVERS);
  assert.deepEqual(m.modeUpdate(s, "gmail__read", "off"), { name: "gmail", tools: { mode: { gmail__send: "write", gmail__read: "off" } } });
});

test("calls: Test, Restart, Remove and a tool's mode are one call each", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./connections-source.ts");
  const { pickServers } = await import("./connections-model.ts");
  const b = box();
  const s = connectionsSource(b.call);
  const t = await s.test("gmail");
  await s.restart("gmail"); await s.remove("docs"); await s.setMode(pickServers(SERVERS)[0], "gmail__read", "off");
  assert.equal(t.ms, 40);
  assert.deepEqual(b.seen.map((x) => x.tool), ["mcp.test", "mcp.restart", "mcp.remove", "mcp.update"]);
  assert.deepEqual(b.seen[3].input, { name: "gmail", tools: { mode: { gmail__send: "write", gmail__read: "off" } } });
});

test("a section whose module is not running says why instead of failing the page", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./connections-source.ts");
  const b = box({ "google.accounts": { error: { code: "not_found", message: "no google module" } }, "github.accounts": { error: { code: "not_found", message: "no github module" } } });
  const s = connectionsSource(b.call);
  assert.deepEqual(await s.accounts(), { rows: [], error: "no google module" });
  assert.deepEqual(await s.github(), { rows: [], error: "" }, "no github module is not an error: the card just has no rows");
});

test("google: scopes read granted or refused; a service account says who it acts as", { skip: !strip }, async () => {
  const m = await import("./connections-model.ts");
  const [a, b] = m.pickAccounts([{ name: "me", email: "me@x.example", auth: { type: "oauth", item: "g1" } }, { name: "co", email: "co@x.example", auth: { type: "service-account", item: "g2", subject: "boss@x.example" } }, { x: 1 }]);
  assert.deepEqual([m.googleAuthLine(a), m.googleAuthLine(b)], ["OAuth", "Service account acting as boss@x.example"]);
  assert.deepEqual(m.pickGoogleTest({ ok: true, scopes: { mail: true, cal: false, odd: "yes" } }).scopes, { mail: true, cal: false, odd: false });
});

test("github: a device sign-in is a code and GitHub's own page, ended only by its own events for that flow; a token error never echoes the token", { skip: !strip }, async () => {
  const m = await import("./connections-model.ts");
  const { connectionsSource } = await import("./connections-source.ts");
  const b = box({ "github.connect": { data: { id: "f1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 600 } } });
  const s = connectionsSource(b.call);
  const f = await s.githubStart("work");
  assert.deepEqual(f, { id: "f1", name: "work", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", minutes: 10 });
  assert.equal(m.githubFlowOf({ id: "f", user_code: "" }, "x"), null, "no code means no panel");
  assert.equal(m.safeGithubUrl("https://github.com/login/device?user_code=A"), "https://github.com/login/device?user_code=A");
  for (const bad of ["http://github.com/x", "https://github.com.evil.example/x", "javascript:alert(1)", undefined]) assert.equal(m.safeGithubUrl(bad), "https://github.com/login/device", String(bad));
  assert.deepEqual(m.githubEnd({ type: "github.connected", payload: { id: "f1" } }, "f1"), { ok: true });
  assert.deepEqual(m.githubEnd({ type: "github.connect-failed", payload: { id: "f1", error: "expired" } }, "f1"), { ok: false, error: "expired" });
  assert.equal(m.githubEnd({ type: "github.connected", payload: { id: "other" } }, "f1"), null);
  assert.equal(m.githubEnd({ type: "mcp.added", payload: { id: "f1" } }, "f1"), null);
  const tok = "ghp_" + "a".repeat(30);
  assert.ok(!m.redact(`bad credentials ${tok} and sk-${"b".repeat(20)}`).includes("aaaa"));
  assert.equal(m.redact("echo mytoken123", ["mytoken123"]), "echo [hidden]");
  assert.equal(m.reachLine("octo", 1), "Connected octo, reaches 1 repo");
  assert.equal(m.reachLine("", null), "Connected the GitHub account.");
  await s.githubToken("work", "t0k3n-value"); await s.githubCancel("f1"); await s.githubRemove("work");
  assert.deepEqual(b.seen.slice(1).map((x) => [x.tool, x.input]), [["github.connect", { name: "work", token: "t0k3n-value" }], ["github.connect.cancel", { id: "f1" }], ["github.remove", { name: "work" }]]);
});
