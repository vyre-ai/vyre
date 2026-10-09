// @ts-check
// The Vault MCP (core/vault/passmcp.js), the six gate tests of team/0.3/DESIGN-vaults-named.md R031-77: a pass sees only its items; it cannot reveal; an ended, expired or leaked pass opens nothing; a
// call through a use pass is the relay (a read runs, a write is held, nothing outside the credential's rules, never the credential back); the pass cannot exceed its issuer; every use is on record and
// no value, username or token is in any of it. A real grants store behind core/vault/kernel-rig.js, the real relay (request.js) over a fake network and a fake Gate.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Access } from "./access.js";
import { register } from "./request.js";
import { PassMcp, mcpLines, LOCKOUT } from "./passmcp.js";
import { kernelRig } from "./kernel-rig.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const json = (status, body) => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
const GRAPH = { auth: { type: "bearer" }, hosts: ["graph.example.test"] };

async function mk(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-passmcp-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const rig = await kernelRig();
  const events = /** @type {any[]} */ ([]);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "box", vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), log: () => {}, clock: rig.clock });
  v.access = new Access(v, rig.ctx);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const net = { calls: /** @type {any[]} */ ([]), script: /** @type {(r: any) => any} */ (() => json(200, { ok: true })) };
  const gate = { items: new Map() };
  const call = async (tool, input) => {
    if (tool === "gate.offer") return { data: { name: input.name } };
    if (tool === "gate.request") { const id = `h${gate.items.size + 1}`; gate.items.set(id, { id, input }); return { data: { id, state: "held", message: `Held as ${id}` } }; }
    return { error: { code: "no_such_tool", message: tool } };
  };
  const tools = new Map();
  const reg = (name, _c, _d, _i, run) => tools.set(name, { run });
  const api = register({ vault: v, tool: reg, internal: (n, _d, _i, run) => tools.set(n, { run }), call, said: { match: async () => null }, deps: { lookup: async () => [{ address: "93.184.216.10", family: 4 }], transport: async r => { net.calls.push({ host: r.url.hostname, path: r.url.pathname + r.url.search, method: r.method, headers: r.headers }); return net.script(r); } } });
  v.mcp = new PassMcp(v, { requests: api, url: () => "https://box.example.test/vault-mcp" });
  const secrets = {};
  for (const n of ["graph", "other"]) { secrets[n] = fake(n); await v.put({ name: `${n}-api`, kind: "api-credential", fields: { config: JSON.stringify(n === "graph" ? GRAPH : { ...GRAPH, hosts: ["other.example.test"] }), secret: secrets[n] } }, "cli"); }
  const rpc = async (token, method, params, source = "198.51.100.7") => (await v.mcp.handle({ method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }), source }));
  const tool = async (token, name, args, source) => { const r = await rpc(token, "tools/call", { name, arguments: args }, source); return r.body && r.body.result ? { ...r.body.result, data: r.body.result.content ? JSON.parse(r.body.result.content[0].text.startsWith("{") ? r.body.result.content[0].text : "{}") : null, text: r.body.result.content && r.body.result.content[0].text } : r; };
  return { v, db, rig, events, net, gate, secrets, rpc, tool, mk: i => v.mcp.create({ name: "Dana's Claude", items: ["graph-api"], ...i }, "cli") };
}

test("gate 1: a pass sees only its items, by name and kind; another item is absent, not refused", async t => {
  const { mk: make, tool, rpc } = await mk(t);
  const p = await make();
  assert.deepEqual((await rpc(p.token, "tools/list")).body.result.tools.map(x => x.name), ["vault_list", "vault_request"]);
  assert.deepEqual((await tool(p.token, "vault_list", {})).data.items, [{ name: "graph-api", kind: "api-credential", hosts: ["graph.example.test"] }]);
  const other = await tool(p.token, "vault_request", { item: "other-api", method: "GET", path: "/x" });
  const nothing = await tool(p.token, "vault_request", { item: "no-such-api", method: "GET", path: "/x" });
  assert.equal(other.isError, true);
  assert.equal(other.text.replace("other-api", "X"), nothing.text.replace("no-such-api", "X"), "an item that is not on the pass reads the same as one that does not exist");
});

test("gate 2: a pass cannot hold reveal; reveal-ask is only on a pass that allows it, raises an ask for the owner and sends nothing", async t => {
  const { mk: make, tool, rpc, v, rig, net, secrets } = await mk(t);
  const plain = await make();
  assert.equal((await tool(plain.token, "vault_reveal_ask", { item: "graph-api" })).isError, true);
  const p = await make({ reveal: true });
  assert.ok((await rpc(p.token, "tools/list")).body.result.tools.some(x => x.name === "vault_reveal_ask"));
  const r = await tool(p.token, "vault_reveal_ask", { item: "graph-api", why: "to debug" });
  assert.equal(r.data.asked, true);
  assert.deepEqual(v.pending().mcpReveals.map(x => [x.item, x.why]), [["graph-api", "to debug"]]);
  assert.ok(!JSON.stringify(r).includes(secrets.graph) && net.calls.length === 0, "nothing was released or called");
  // the grants a pass holds are read and call on its items: never reveal, edit, share or fill
  const mine = (await rig.gw.grants.list(rig.owner(), {})).filter(g => g.source.startsWith("vault:pass:"));
  assert.ok(mine.length === 2 && mine.every(g => g.actions.join() === "vault.read,vault.call" && g.subject.actor.id.startsWith("ext_")));
});

test("gate 3: an ended or expired pass opens nothing; a leaked token for it opens nothing; a source sending wrong tokens is locked out", async t => {
  const { mk: make, rpc, v, events } = await mk(t);
  const live = await make(), gone = await make({ name: "Eli" });
  assert.equal((await rpc(live.token, "tools/list")).status, 200);
  assert.deepEqual(await v.mcp.revoke(gone.id, "cli"), { revoked: true });
  assert.equal((await rpc(gone.token, "tools/list", undefined, "203.0.113.5")).status, 401, "an ended pass");
  assert.equal((await rpc("vmcp_wrong", "tools/list", undefined, "203.0.113.6")).status, 401);
  for (let i = 0; i < LOCKOUT.bad; i++) await rpc(`vmcp_bad${i}`, "tools/list", undefined, "203.0.113.9");
  assert.equal((await rpc(live.token, "tools/list", undefined, "203.0.113.9")).status, 429, "locked out, even with a good token");
  assert.ok(events.some(e => e.type === "vault.mcp-refused" && e.p.reason === "locked out"));
  assert.ok(events.filter(e => e.type === "vault.mcp-refused").length >= 6, "every refusal is an event");
  assert.equal((await rpc(live.token, "tools/list", undefined, "198.51.100.8")).status, 200);
});

test("gate 3b: a pass past its expiry opens nothing (the clock decides), and a revoked one has no grants left in the kernel", async t => {
  const { mk: make, rpc, v, rig } = await mk(t);
  const p = await make({ days: 1 });
  assert.equal((await rpc(p.token, "tools/list")).status, 200);
  const real = v.clock; const t0 = real();
  v.clock = () => t0 + 2 * 86_400_000;
  assert.equal((await rpc(p.token, "tools/list", undefined, "203.0.113.20")).status, 401);
  v.clock = real;
  const q = await make({ name: "Q" });
  await v.mcp.revoke(q.id, "cli");
  assert.equal((await rig.gw.grants.list(rig.owner(), {})).filter(g => g.status === "active" && g.source === `vault:pass:ext_${q.id.replace(/^vp_/, "")}`).length, 0);
});

test("gate 4: through a use pass a read runs with the key added at home, a write is held for the owner, a host the pass was narrowed away from is refused, and the key never comes back", async t => {
  const { mk: make, tool, net, gate, secrets } = await mk(t);
  const p = await make();
  net.script = r => json(200, { value: [1], echoed: `Bearer ${secrets.graph}`, token: secrets.graph });
  const read = await tool(p.token, "vault_request", { item: "graph-api", method: "GET", path: "/v1/me/messages", query: { $top: 3 } });
  assert.equal(read.data.status, 200);
  assert.equal(net.calls[0].host, "graph.example.test");
  assert.ok(!read.text.includes(secrets.graph), "the key does not come back");
  const write = await tool(p.token, "vault_request", { item: "graph-api", method: "POST", path: "/v1/me/sendMail", body: { message: { subject: "hi", toRecipients: [{ emailAddress: { address: "dana@example.test" } }] } } });
  assert.ok(write.data.held, JSON.stringify(write));
  assert.equal(gate.items.size, 1);
  assert.equal(net.calls.length, 1, "the write was not sent");
  for (const path of ["//evil.test/x", "/a?b=1", "x"]) assert.equal((await tool(p.token, "vault_request", { item: "graph-api", method: "GET", path })).isError, true, path);
  const narrow = await make({ name: "Narrow", hosts: ["elsewhere.example.test"] });
  assert.match((await tool(narrow.token, "vault_request", { item: "graph-api", method: "GET", path: "/x" })).text, /no host this pass may reach/);
});

test("gate 5: the pass is inside its issuer: take the owner's manage of the vault away and the pass stops at the next call", async t => {
  const { mk: make, tool, rig, net } = await mk(t);
  const p = await make();
  assert.equal((await tool(p.token, "vault_request", { item: "graph-api", method: "GET", path: "/v1/a" })).data.status, 200);
  const manage = (await rig.gw.grants.list(rig.owner(), {})).find(g => g.source === "vault:create");
  await rig.gw.grants.revoke(rig.owner(), manage.id, "no longer", { presence: { n: 1 } });
  const after = await tool(p.token, "vault_request", { item: "graph-api", method: "GET", path: "/v1/a" });
  assert.equal(after.isError, true);
  assert.equal(net.calls.length, 1);
});

test("gate 6: every use is on record with the pass, and no key, username or token is in any event, audit row, answer or error", async t => {
  const { mk: make, tool, rpc, v, db, events, secrets, net } = await mk(t);
  const p = await make();
  net.script = () => json(200, { ok: true });
  const answers = [];
  answers.push(await tool(p.token, "vault_list", {}), await tool(p.token, "vault_request", { item: "graph-api", method: "GET", path: "/v1/a" }), await tool(p.token, "vault_request", { item: "graph-api", method: "POST", path: "/v1/b", body: { a: 1 } }),
    await tool(p.token, "vault_request", { item: "other-api", method: "GET", path: "/v1/a" }), await rpc("vmcp_nope", "tools/list"));
  const uses = db.prepare("SELECT * FROM vault_audit WHERE action = 'pass-mcp-use'").all();
  assert.ok(uses.length >= 2 && uses.every(u => u.who.startsWith(`pass:${p.id}:`)), "each use is on record with the pass");
  assert.equal(v.mcp.list()[0].uses, 2);
  const text = JSON.stringify([answers, events, db.prepare("SELECT * FROM vault_audit").all(), v.mcp.list()]);
  for (const s of [secrets.graph, secrets.other, p.token, crypto.createHash("sha256").update(p.token).digest("hex")]) assert.ok(!text.includes(s), "a secret or the token leaked");
  assert.match(mcpLines({ url: p.url, token: p.token }).claude, /^claude mcp add --transport http .* --header "Authorization: Bearer vmcp_/);
});

test("the endpoint: POST /vault-mcp with a pass token answers MCP; any other path, method or token is a bare refusal", async t => {
  const { mk: make, v } = await mk(t);
  const { listenMcp } = await import("./passmcp-listener.js");
  const l = await listenMcp({ host: "127.0.0.1", port: 0, handle: q => v.mcp.handle(q) });
  t.after(() => l.close());
  const p = await make();
  const post = (body, headers = {}, url = l.url) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const ok = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), { authorization: `Bearer ${p.token}` });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.serverInfo.name, "vyre-vault");
  assert.equal((await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).status, 401, "no token");
  assert.equal((await fetch(l.url)).status, 405);
  assert.equal((await post("{}", { authorization: `Bearer ${p.token}` }, l.url.replace("/vault-mcp", "/other"))).status, 404);
  assert.equal((await post("x".repeat(70_000), { authorization: `Bearer ${p.token}` }).catch(() => ({ status: 0 }))).status === 200, false, "a body over 64 KB is cut off");
});
