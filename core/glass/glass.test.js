// @ts-check
// The glass module on the real registry: stand-ins for computers and threads written with
// writeModule (the real computers module has no shield or helper yet, and Glass only ever
// reaches it through ctx.call), the box on a temp folder, and a fake computerd for an agent's
// files. The byte routes are served by a small HTTP server that hands each request to the route
// the module registered, as vyred's router does; the last test runs the module inside a real
// vyred and fetches over its socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { start } from "../daemon/index.js";
import { HUMAN_ONLY, PERSON_ONLY } from "../presence/index.js";
import { call, request } from "../daemon/client.js";
import { tempHome, writeModule, present } from "../../test/helpers.js";
import { fakeComputerd } from "./providers/fake.js";
import { duration } from "./index.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Computers as Glass sees it through ctx.call. The helper's address and whether a shield exists
// come from config (stub.helper, stub.shield); every call is recorded, with the caller.
const COMPUTERS_SRC = `
export default { async start(ctx) {
  const s = ctx.config.stub || {};
  const calls = [];
  const held = new Map();
  const obj = { type: "object", properties: { agent: { type: "string" }, surface: { type: "string" }, on: { type: "boolean" } } };
  const t = (name, run) => ctx.tool(name, { input: obj, run: async (i, { caller }) => { calls.push({ tool: name, input: i, caller }); return run(i); } });
  t("computers.list", async () => ({ driver: "fake", screens: 2, computers: [
    { agent: "kit", state: "running", screen: 1, thread: "th-kit", viewers: 1, takeover: held.get("kit") || null },
    { agent: "pax", state: "frozen", screen: null, thread: null, viewers: 0, takeover: null } ] }));
  t("computers.get", async i => ({ agent: i.agent, state: "running", thread: i.agent === "kit" ? "th-kit" : null, takeover: held.get(i.agent) || null }));
  t("computers.watch", async i => ({ ticket: "watch-" + i.agent, path: "/v1/streams/computers/glass?ticket=watch-" + i.agent, width: 1280, height: 800 }));
  t("computers.takeover", async i => { held.set(i.agent, i.surface); return { agent: i.agent, surface: i.surface, thread: "th-kit", previous: null }; });
  t("computers.giveback", async i => { if (held.get(i.agent) !== i.surface) return { agent: i.agent, handed_back: false }; held.delete(i.agent); return { agent: i.agent, handed_back: true }; });
  if (s.shield) t("computers.shield", async i => ({ agent: i.agent, shielded: i.on }));
  if (s.helper) ctx.tool("computers.helper", { internal: true, input: obj, run: async (i, { caller }) => { calls.push({ tool: "computers.helper", input: i, caller }); return s.helper; } });
  return { calls, held, async stop() {} };
} };`;

const THREADS_SRC = `
export default { async start(ctx) {
  const sent = [];
  ctx.tool("threads.send", { input: { type: "object", required: ["thread", "text"], properties: { thread: { type: "string" }, text: { type: "string" } } },
    run: async (i, { caller }) => { sent.push({ ...i, caller }); return { sent: true }; } });
  return { sent, async stop() {} };
} };`;

// link.health as Glass sees it: the answer from config (stub.link), or an error, or one that never comes.
const LINK_SRC = `
export default { async start(ctx) {
  const asked = [];
  ctx.tool("link.health", { input: { type: "object", properties: { node: { type: "string" } } }, run: async (i, { caller }) => {
    asked.push({ input: i, caller });
    const a = ctx.config.stub.link;
    if (a === "throw") throw new Error("tailscale fell over");
    if (a === "hang") return new Promise(() => {});
    return a;
  } });
  return { asked, async stop() {} };
} };`;

/**
 * The glass module on a real Registry, beside the stand-ins.
 * @param {any} t
 * @param {{ shield?: boolean, helper?: boolean, threads?: boolean, maxUploadMb?: number, link?: any }} [o]
 */
async function boot(t, o = {}) {
  const root = tempHome(t);
  const files = path.join(root, "files");
  fs.mkdirSync(path.join(files, "docs"), { recursive: true });
  fs.writeFileSync(path.join(files, "docs", "readme.md"), "# hello\n");
  const agentHome = path.join(root, "agent-home");
  fs.mkdirSync(agentHome);
  fs.writeFileSync(path.join(agentHome, "todo.txt"), "buy milk\n");
  fs.mkdirSync(path.join(agentHome, ".ssh"));
  const cd = await fakeComputerd(agentHome);
  t.after(() => cd.close());

  const tools = ["computers.list", "computers.get", "computers.watch", "computers.takeover", "computers.giveback"];
  if (o.shield) tools.push("computers.shield");
  if (o.helper !== false) tools.push("computers.helper");
  const mods = path.join(root, "stubs");
  writeModule(mods, "computers", { does: { tools } }, COMPUTERS_SRC);
  if (o.threads !== false) writeModule(mods, "threads", { does: { tools: ["threads.send"] } }, THREADS_SRC);
  if (o.link !== undefined) writeModule(mods, "link", { does: { tools: ["link.health"] } }, LINK_SRC);

  const cfg = { role: "box", glass: { roots: [files], ...(o.maxUploadMb ? { maxUploadMb: o.maxUploadMb } : {}) },
    stub: { shield: Boolean(o.shield), helper: o.helper === false ? null : { url: cd.url, token: cd.token }, link: o.link } };
  const db = open(path.join(root, "vyre.db"));
  const events = new Events(db);
  /** @type {string[]} */
  const logs = [];
  const registry = new Registry({ db, events, config: cfg, paths: config.paths(root), log: m => logs.push(m) });
  const found = [...discover([mods]), ...discover([CORE]).filter(f => f.manifest && f.manifest.name === "glass")];
  await registry.start(found, { role: "box" });
  const g = registry.modules.get("glass");
  assert.equal(g?.state, "running", `glass did not start: ${g?.error}`);

  // The byte routes, handed requests the way vyred's router does.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://vyred");
    const fn = registry.routes.get(url.pathname);
    if (!fn) { res.writeHead(404); res.end(); return; }
    Promise.resolve(fn(req, res, { caller: String(req.headers["x-vyre-caller"] || "local"), url })).catch(e => { res.writeHead(500); res.end(e.message); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(r => server.close(() => r(undefined)));
    await registry.stop();
    db.close();
  });

  const as = caller => (tool, input = {}) => registry.call(tool, input, caller);
  return {
    root, files, agentHome, cd, registry, logs, base,
    h: g.handle, computers: registry.modules.get("computers")?.handle, threads: registry.modules.get("threads")?.handle, link: registry.modules.get("link")?.handle,
    deck: as("deck"), cli: as("cli"), kit: as("mcp:agent:kit"),
    events: (type = "") => events.since(0, { limit: 1000 }).filter(e => e.type.startsWith(type)),
  };
}

/** A plain HTTP request: resolves with status, headers and the body as a Buffer. */
function fetchRaw(url, { method = "GET", headers = {}, body } = /** @type {any} */ ({})) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body !== undefined) req.end(body); else req.end();
  });
}

// ------------------------------------------------------------ the module and its targets

test("glass: a tailnet viewer on a relay gets link facts and a slow ticket; a direct one does not", async t => {
  const relayed = await boot(t, { link: { path: "relay", relay: "fra", latencyMs: 80, lastHandshake: null, online: true, checkedAt: 1, cached: false } });
  const peer = { node: "alex-phone", stableId: "nPHONE", login: "alex@example.com" };
  const o = await relayed.registry.call("glass.open", { target: "computer:kit", surface: "phone:pocket" }, "tailnet:alex@example.com", { peer });
  assert.equal(o.error, undefined, o.error?.message);
  assert.deepEqual(o.data.link, { path: "relay", latencyMs: 80 });
  assert.deepEqual(relayed.link.asked, [{ input: { node: "nPHONE" }, caller: "module:glass" }]);
  assert.deepEqual(relayed.computers.calls.find(c => c.tool === "computers.watch").input, { agent: "kit", surface: "phone:pocket", slow: true });
  // Not a tailnet caller (the box's own socket): nothing is asked.
  const local = await relayed.deck("glass.open", { target: "computer:kit", surface: "deck:laptop" });
  assert.equal(local.data.link, undefined);
  assert.equal(relayed.link.asked.length, 1);

  const far = await boot(t, { link: { path: "direct", relay: null, latencyMs: 180, lastHandshake: null, online: true, checkedAt: 1, cached: true } });
  await far.registry.call("glass.open", { target: "computer:kit", surface: "phone:pocket" }, "tailnet:alex@example.com", { peer });
  assert.equal(far.computers.calls.find(c => c.tool === "computers.watch").input.slow, true, "over 150 ms is slow too");

  const direct = await boot(t, { link: { path: "direct", relay: null, latencyMs: 12, lastHandshake: null, online: true, checkedAt: 1, cached: false } });
  const d = await direct.registry.call("glass.open", { target: "computer:kit", surface: "phone:pocket" }, "tailnet:alex@example.com", { peer });
  assert.deepEqual(d.data.link, { path: "direct", latencyMs: 12 });
  assert.deepEqual(direct.computers.calls.find(c => c.tool === "computers.watch").input, { agent: "kit", surface: "phone:pocket" });
});

test("glass: open never fails for link.health, whether it errors or is slow to answer", async t => {
  const peer = { node: "alex-phone", stableId: "nPHONE", login: "alex@example.com" };
  const broken = await boot(t, { link: "throw" });
  const a = await broken.registry.call("glass.open", { target: "computer:kit", surface: "phone:pocket" }, "tailnet:alex@example.com", { peer });
  assert.equal(a.error, undefined);
  assert.equal(a.data.link, undefined);
  assert.ok(a.data.screen.ticket);
  const hung = await boot(t, { link: "hang" });
  const at = Date.now();
  const b = await hung.registry.call("glass.open", { target: "computer:kit", surface: "phone:pocket" }, "tailnet:alex@example.com", { peer });
  assert.equal(b.error, undefined);
  assert.ok(Date.now() - at < 5000, "the open waited only briefly");
  assert.ok(b.data.screen.ticket);
  // No link module at all.
  const none = await boot(t);
  const c = await none.registry.call("glass.open", { target: "computer:kit", surface: "phone:pocket" }, "tailnet:alex@example.com", { peer });
  assert.equal(c.error, undefined);
  assert.equal(c.data.link, undefined);
});

test("glass: the manifest's tools and events are the ones it registers", async t => {
  const s = await boot(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(CORE, "glass", "module.json"), "utf8"));
  // The person's own surface sees every tool; an agent sees only the ones whose reach is anyone.
  const mine = s.registry.listTools("cli").map(x => x.name).filter(n => n.startsWith("glass."));
  assert.deepEqual(mine.sort(), manifest.does.tools.map(x => x.name).sort());
  const agents = s.registry.listTools("mcp").map(x => x.name).filter(n => n.startsWith("glass."));
  assert.deepEqual(agents.sort(), manifest.does.tools.filter(x => x.reach === "anyone").map(x => x.name).sort());
  assert.deepEqual(manifest.roles, ["box"]);
  assert.deepEqual(manifest.requires, []);
  assert.ok(s.registry.routes.has("/v1/glass/raw") && s.registry.routes.has("/v1/glass/put"));
  const src = fs.readdirSync(path.join(CORE, "glass"), { recursive: true }).filter(f => String(f).endsWith(".js") && !String(f).endsWith(".test.js"));
  for (const f of src) assert.doesNotMatch(fs.readFileSync(path.join(CORE, "glass", String(f)), "utf8"), /setInterval\(/, `${f} runs a timer`);
});

test("glass: targets lists each agent's computer and the box, and survives computers missing", async t => {
  const s = await boot(t);
  const r = await s.deck("glass.targets");
  assert.deepEqual(r.data.map(x => [x.target, x.screen, x.files, x.state]), [
    ["computer:kit", true, true, "running"], ["computer:pax", true, true, "frozen"], ["box", false, true, "running"]]);
  assert.deepEqual(Object.keys(r.data[0]).sort(), ["files", "label", "screen", "state", "takeover", "target", "viewers"]);
  // Without computers, only the box.
  s.registry.tools.delete("computers.list");
  assert.deepEqual((await s.deck("glass.targets")).data.map(x => x.target), ["box"]);
});

test("glass: open returns the computers.watch ticket and records a session; close reports seconds", async t => {
  const s = await boot(t);
  const o = await s.deck("glass.open", { target: "computer:kit", surface: "deck:laptop" });
  assert.equal(o.error, undefined, o.error?.message);
  assert.deepEqual(o.data.screen, { ticket: "watch-kit", path: "/v1/streams/computers/glass?ticket=watch-kit", width: 1280, height: 800 });
  assert.deepEqual(o.data.roots, [{ name: "home", path: "" }]);
  const watch = s.computers.calls.find(c => c.tool === "computers.watch");
  assert.deepEqual([watch.input, watch.caller], [{ agent: "kit", surface: "deck:laptop" }, "module:glass"]);
  const row = /** @type {any} */ (s.registry.deps.db.prepare("SELECT * FROM glass_sessions WHERE id = ?").get(o.data.session));
  assert.deepEqual([row.target, row.surface, row.caller, row.closed], ["computer:kit", "deck:laptop", "deck", null]);
  const opened = s.events("glass.opened");
  assert.deepEqual(opened[0].payload, { session: o.data.session, target: "computer:kit", surface: "deck:laptop" });

  const b = await s.deck("glass.open", { target: "box", surface: "phone:pocket" });
  assert.equal(b.data.screen, undefined, "the box has no screen");
  assert.deepEqual(b.data.roots, [{ name: "files", path: "files" }]);

  assert.deepEqual((await s.deck("glass.close", { session: o.data.session })).data, { closed: true });
  assert.deepEqual((await s.deck("glass.close", { session: o.data.session })).data, { closed: false });
  const closed = s.events("glass.closed")[0].payload;
  assert.equal(closed.session, o.data.session);
  assert.equal(typeof closed.seconds, "number");
  assert.match((await s.deck("glass.open", { target: "computer:Kit!", surface: "deck:laptop" })).error.message, /not a target/);
  assert.match((await s.deck("glass.open", { target: "box", surface: "cli" })).error.message, /surface must name a person's screen/);
});

test("glass: an agent caller cannot name a person's surface", async t => {
  const s = await boot(t);
  for (const [tool, input] of /** @type {[string, any][]} */ ([
    ["glass.open", { target: "computer:kit", surface: "deck:laptop" }],
    ["glass.take", { target: "computer:kit", surface: "phone:pocket" }],
    ["glass.release", { target: "computer:kit", surface: "phone:pocket" }]])) {
    const r = await s.kit(tool, input);
    assert.match(r.error?.message || "", /not available to mcp callers/, tool);
  }
  assert.equal(s.computers.calls.filter(c => /watch|takeover|giveback/.test(c.tool)).length, 0, "nothing reached computers");
});

// ------------------------------------------------------------ take-over

test("glass: take calls takeover as the module; a private take undoes itself when the shield is missing", async t => {
  const s = await boot(t);
  const plain = await s.deck("glass.take", { target: "computer:kit", surface: "deck:laptop" });
  assert.equal(plain.error, undefined, plain.error?.message);
  assert.deepEqual([plain.data.target, plain.data.surface, plain.data.private], ["computer:kit", "deck:laptop", false]);
  assert.equal(typeof plain.data.since, "number");
  assert.deepEqual(s.events("glass.taken")[0].payload, { target: "computer:kit", surface: "deck:laptop", private: false });
  await s.deck("glass.release", { target: "computer:kit", surface: "deck:laptop" });

  const priv = await s.deck("glass.take", { target: "computer:kit", surface: "phone:pocket", private: true });
  assert.equal(priv.error?.message, "private sign-in needs the computers shield, which is not running");
  const seq = s.computers.calls.filter(c => /takeover|giveback/.test(c.tool)).slice(-2).map(c => [c.tool, c.input.surface, c.caller]);
  assert.deepEqual(seq, [["computers.takeover", "phone:pocket", "module:glass"], ["computers.giveback", "phone:pocket", "module:glass"]]);
  assert.equal(s.computers.held.get("kit"), undefined, "the take-over was left in place");
  assert.equal(s.events("glass.taken").length, 1, "a failed private take announced itself");
  assert.match((await s.deck("glass.take", { target: "box", surface: "deck:laptop" })).error.message, /no screen/);
});

test("glass: a private take with the shield raises it and lowers it on release", async t => {
  const s = await boot(t, { shield: true });
  const r = await s.deck("glass.take", { target: "computer:kit", surface: "deck:laptop", private: true });
  assert.equal(r.data.private, true);
  await s.deck("glass.release", { target: "computer:kit", surface: "deck:laptop" });
  assert.deepEqual(s.computers.calls.filter(c => c.tool === "computers.shield").map(c => c.input.on), [true, false]);
});

test("glass: release returns held_ms, emits, and notes the thread without anything typed", async t => {
  const s = await boot(t);
  await s.deck("glass.take", { target: "computer:kit", surface: "phone:pocket" });
  s.h.takes.get("kit").since -= 134_000;
  const r = await s.deck("glass.release", { target: "computer:kit", surface: "phone:pocket", note: "signed in to the bank portal" });
  assert.equal(r.data.released, true);
  assert.ok(r.data.held_ms >= 134_000 && r.data.held_ms < 140_000, String(r.data.held_ms));
  const ev = s.events("glass.released")[0].payload;
  assert.deepEqual([ev.target, ev.surface, ev.why], ["computer:kit", "phone:pocket", "gave back"]);
  assert.equal(ev.held_ms, r.data.held_ms);
  assert.equal(s.threads.sent.length, 1);
  assert.equal(s.threads.sent[0].thread, "th-kit");
  assert.match(s.threads.sent[0].text, /^Someone had your keyboard from phone for 2 min 1[4-9] s and handed it back\. The screen may have changed; look before acting\. Their note: signed in to the bank portal$/);
  // Releasing what you do not hold changes nothing and says so.
  assert.deepEqual((await s.deck("glass.release", { target: "computer:kit", surface: "phone:pocket" })).data, { released: false, held_ms: 0 });
  assert.equal(s.events("glass.released").length, 1);
  assert.equal(duration(40_000), "40 s");
  assert.equal(duration(3_780_000), "1 h 3 min");
});

test("glass: without threads.send the hand-back still works, silently", async t => {
  const s = await boot(t, { threads: false });
  await s.deck("glass.take", { target: "computer:kit", surface: "deck:laptop" });
  const r = await s.deck("glass.release", { target: "computer:kit", surface: "deck:laptop" });
  assert.equal(r.data.released, true);
  assert.equal(s.logs.filter(l => /could not note/.test(l)).length, 0);
});

// ------------------------------------------------------------ files on the box

test("glass: box list, stat, preview, mkdir, move and trash, with events that carry no content", async t => {
  const s = await boot(t);
  fs.writeFileSync(path.join(s.files, ".env"), "SHOULD_NOT_SHOW=1");
  fs.writeFileSync(path.join(s.files, "docs", "id_rsa"), "nope");
  fs.writeFileSync(path.join(s.files, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(s.files, "big.txt"), "a".repeat(300 * 1024));

  const top = await s.deck("glass.files.list", { target: "box" });
  assert.deepEqual(top.data.entries.map(e => [e.name, e.kind]), [["files", "dir"]]);
  const l = await s.deck("glass.files.list", { target: "box", path: "files" });
  assert.deepEqual(l.data.entries.map(e => e.name), ["docs", "big.txt", "photo.png"]);
  assert.deepEqual([l.data.root, l.data.path], ["files", "files"]);
  assert.deepEqual((await s.deck("glass.files.list", { target: "box", path: "files/docs" })).data.entries.map(e => e.name), ["readme.md"]);
  assert.match((await s.deck("glass.files.stat", { target: "box", path: "files/.env" })).error.message, /private place/);
  assert.match((await s.deck("glass.files.list", { target: "box", path: "files/../.." })).error.message, /climbs out/);
  assert.match((await s.deck("glass.files.list", { target: "box", path: "nope" })).error.message, /no root named/);

  const st = await s.deck("glass.files.stat", { target: "box", path: "files/docs/readme.md" });
  assert.deepEqual([st.data.name, st.data.kind, st.data.size, st.data.mime], ["readme.md", "file", 8, "text/markdown"]);

  assert.deepEqual((await s.deck("glass.files.preview", { target: "box", path: "files/docs/readme.md" })).data, { kind: "text", text: "# hello\n", truncated: false });
  const big = (await s.deck("glass.files.preview", { target: "box", path: "files/big.txt" })).data;
  assert.deepEqual([big.kind, big.text.length, big.truncated], ["text", 256 * 1024, true]);
  const img = (await s.deck("glass.files.preview", { target: "box", path: "files/photo.png" })).data;
  assert.equal(img.kind, "image");
  assert.match(img.path, /^\/v1\/glass\/raw\?ticket=[A-Za-z0-9_-]{43}$/);

  assert.deepEqual((await s.deck("glass.files.mkdir", { target: "box", path: "files/new" })).data, { created: true });
  assert.ok(fs.statSync(path.join(s.files, "new")).isDirectory());
  assert.match((await s.deck("glass.files.mkdir", { target: "box", path: "files/.ssh" })).error.message, /private/);
  assert.deepEqual((await s.deck("glass.files.move", { target: "box", from: "files/docs/readme.md", to: "files/new/readme.md" })).data, { moved: true });
  assert.ok(fs.existsSync(path.join(s.files, "new", "readme.md")));
  assert.match((await s.deck("glass.files.move", { target: "box", from: "files/new/readme.md", to: "files/big.txt" })).error.message, /already exists/);
  assert.match((await s.deck("glass.files.move", { target: "box", from: "files/new", to: "files/new/inner" })).error.message, /inside itself/);

  const tr = await s.deck("glass.files.trash", { target: "box", path: "files/new/readme.md" });
  assert.equal(tr.data.trashed, true);
  assert.match(tr.data.to, /^files\/\.vyre-trash\/\d{4}-\d\d-\d\dT[\d-]+Z-readme\.md$/);
  assert.equal(fs.readFileSync(path.join(s.files, tr.data.to.slice("files/".length)), "utf8"), "# hello\n");
  assert.ok(!(await s.deck("glass.files.list", { target: "box", path: "files" })).data.entries.some(e => e.name === ".vyre-trash"), "the trash is listed");
  assert.match((await s.deck("glass.files.trash", { target: "box", path: "files" })).error.message, /root cannot be trashed/);

  const ev = s.events("file.");
  assert.deepEqual(ev.map(e => e.type), ["file.created", "file.moved", "file.trashed"]);
  assert.deepEqual(ev[1].payload, { target: "box", from: "files/docs/readme.md", to: "files/new/readme.md", size: 8, by: "deck" });
  assert.deepEqual(ev[2].payload, { target: "box", path: "files/new/readme.md", to: tr.data.to, size: 8, by: "deck" });
  assert.ok(!JSON.stringify(ev).includes("hello"), "an event carried file content");
});

test("glass: a download ticket works once, carries the safe headers, and expires", async t => {
  const s = await boot(t);
  fs.writeFileSync(path.join(s.files, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  const d = await s.deck("glass.files.download", { target: "box", path: "files/photo.png" });
  assert.deepEqual([d.data.name, d.data.size], ["photo.png", 8]);
  const r = await fetchRaw(s.base + d.data.path);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 8);
  assert.equal(r.headers["content-type"], "image/png");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.match(String(r.headers["content-disposition"]), /^inline; filename="photo.png"/);
  assert.equal((await fetchRaw(s.base + d.data.path)).status, 403, "a ticket worked twice");

  // A range.
  const part = await s.deck("glass.files.download", { target: "box", path: "files/photo.png" });
  const pr = await fetchRaw(s.base + part.data.path, { headers: { range: "bytes=4-" } });
  assert.deepEqual([pr.status, pr.headers["content-range"], [...pr.body]], [206, "bytes 4-7/8", [1, 2, 3, 4]]);

  // Sixty seconds, then nothing.
  const late = await s.deck("glass.files.download", { target: "box", path: "files/photo.png" });
  const real = s.h.tickets.now;
  s.h.tickets.now = () => real() + 61_000;
  assert.equal((await fetchRaw(s.base + late.data.path)).status, 403, "an expired ticket worked");
  s.h.tickets.now = real;

  // A download ticket cannot upload, and an agent cannot spend a person's ticket.
  const other = await s.deck("glass.files.download", { target: "box", path: "files/photo.png" });
  assert.equal((await fetchRaw(s.base + other.data.path.replace("/raw?", "/put?"), { method: "PUT", body: "x" })).status, 403);
  const mine = await s.deck("glass.files.download", { target: "box", path: "files/photo.png" });
  assert.equal((await fetchRaw(s.base + mine.data.path, { headers: { "x-vyre-caller": "mcp:agent:kit" } })).status, 403);
  assert.match((await s.deck("glass.files.download", { target: "box", path: "files" })).error.message, /not a file/);
});

test("glass: svg and html download as attachments, with the name encoded", async t => {
  const s = await boot(t);
  fs.writeFileSync(path.join(s.files, "draw.svg"), "<svg onload=alert(1)></svg>");
  fs.writeFileSync(path.join(s.files, "page.html"), "<script>alert(1)</script>");
  fs.writeFileSync(path.join(s.files, "résumé \"final\".pdf"), "%PDF-1.4");
  for (const name of ["draw.svg", "page.html"]) {
    const d = await s.deck("glass.files.download", { target: "box", path: `files/${name}` });
    const r = await fetchRaw(s.base + d.data.path);
    assert.equal(r.headers["content-type"], "application/octet-stream", name);
    assert.match(String(r.headers["content-disposition"]), new RegExp(`^attachment; filename="${name.replace(".", "\\.")}"`), name);
    assert.equal(r.headers["content-security-policy"], "default-src 'none'; sandbox");
  }
  const pdf = await s.deck("glass.files.download", { target: "box", path: "files/résumé \"final\".pdf" });
  const r = await fetchRaw(s.base + pdf.data.path);
  assert.equal(r.headers["content-type"], "application/pdf");
  assert.equal(r.headers["content-disposition"], `inline; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`);
});

test("glass: an upload streams into place, refuses the wrong size and an overwrite, and emits without content", async t => {
  const s = await boot(t, { maxUploadMb: 1 });
  const body = Buffer.from("fresh bytes, 22 long!!");
  const u = await s.deck("glass.files.upload", { target: "box", dir: "files/docs", name: "note.txt", size: body.length });
  assert.equal(u.error, undefined, u.error?.message);
  const r = await fetchRaw(s.base + u.data.path, { method: "PUT", body });
  assert.equal(r.status, 200, r.body.toString());
  assert.equal(fs.readFileSync(path.join(s.files, "docs", "note.txt"), "utf8"), body.toString());
  const ev = s.events("file.uploaded");
  assert.deepEqual(ev.map(e => e.payload), [{ target: "box", path: "files/docs/note.txt", size: body.length, by: "deck" }]);
  assert.ok(!JSON.stringify(ev).includes("fresh"), "the event carried content");
  assert.equal((await fetchRaw(s.base + u.data.path, { method: "PUT", body })).status, 403, "an upload ticket worked twice");

  // Refuses to overwrite, at the tool and again at the route.
  assert.match((await s.deck("glass.files.upload", { target: "box", dir: "files/docs", name: "note.txt", size: 3 })).error.message, /already exists/);
  const race = await s.deck("glass.files.upload", { target: "box", dir: "files/docs", name: "late.txt", size: 3 });
  fs.writeFileSync(path.join(s.files, "docs", "late.txt"), "old");
  const rr = await fetchRaw(s.base + race.data.path, { method: "PUT", body: "new" });
  assert.equal(rr.status, 409);
  assert.equal(fs.readFileSync(path.join(s.files, "docs", "late.txt"), "utf8"), "old");
  const ow = await s.deck("glass.files.upload", { target: "box", dir: "files/docs", name: "late.txt", size: 3, overwrite: true });
  assert.equal((await fetchRaw(s.base + ow.data.path, { method: "PUT", body: "new" })).status, 200);
  assert.equal(fs.readFileSync(path.join(s.files, "docs", "late.txt"), "utf8"), "new");

  // The wrong size: announced, short in a chunked body, and long in a chunked body.
  const a = await s.deck("glass.files.upload", { target: "box", dir: "files/docs", name: "a.txt", size: 10 });
  assert.equal((await fetchRaw(s.base + a.data.path, { method: "PUT", body: "short" })).status, 400);
  const b = await s.deck("glass.files.upload", { target: "box", dir: "files/docs", name: "b.txt", size: 10 });
  const short = await fetchRaw(s.base + b.data.path, { method: "PUT", headers: { "transfer-encoding": "chunked" }, body: "short" });
  assert.equal(short.status, 400);
  const c = await s.deck("glass.files.upload", { target: "box", dir: "files/docs", name: "c.txt", size: 10 });
  const long = await fetchRaw(s.base + c.data.path, { method: "PUT", headers: { "transfer-encoding": "chunked" }, body: "x".repeat(50) }).catch(() => ({ status: "reset" }));
  assert.ok(long.status === 413 || long.status === "reset", String(long.status));
  for (const n of ["a.txt", "b.txt", "c.txt"]) assert.ok(!fs.existsSync(path.join(s.files, "docs", n)), `${n} was written`);
  assert.deepEqual(fs.readdirSync(path.join(s.files, "docs")).filter(n => n.startsWith(".vyre-upload-")), [], "a temp file was left behind");
  assert.equal(s.events("file.uploaded").length, 2);

  // Caps and names.
  assert.match((await s.deck("glass.files.upload", { target: "box", dir: "files", name: "huge.bin", size: 2 * 1024 * 1024 })).error.message, /larger than the 1 MB/);
  assert.match((await s.deck("glass.files.upload", { target: "box", dir: "files", name: "server.pem", size: 1 })).error.message, /private name/);
  assert.match((await s.deck("glass.files.upload", { target: "box", dir: "files", name: "../x", size: 1 })).error.message, /not a file name/);
  assert.match((await s.deck("glass.files.upload", { target: "box", dir: "", name: "x", size: 1 })).error.message, /which root/);
});

// ------------------------------------------------------------ files on an agent's computer

test("glass: files on an agent's computer go through computers.helper and computerd, behind the same guard", async t => {
  const s = await boot(t);
  const l = await s.deck("glass.files.list", { target: "computer:kit" });
  assert.equal(l.error, undefined, l.error?.message);
  assert.deepEqual(l.data.entries.map(e => e.name), ["todo.txt"], ".ssh is hidden");
  assert.equal(s.computers.calls.find(c => c.tool === "computers.helper").caller, "module:glass");
  assert.deepEqual((await s.deck("glass.files.preview", { target: "computer:kit", path: "todo.txt" })).data, { kind: "text", text: "buy milk\n", truncated: false });
  assert.match((await s.deck("glass.files.stat", { target: "computer:kit", path: ".ssh" })).error.message, /private place/);
  const before = s.cd.served.length;
  assert.match((await s.deck("glass.files.list", { target: "computer:kit", path: "../etc" })).error.message, /climbs out/);
  assert.equal(s.cd.served.length, before, "a refused path reached computerd");

  const d = await s.deck("glass.files.download", { target: "computer:kit", path: "todo.txt" });
  const r = await fetchRaw(s.base + d.data.path, { headers: { range: "bytes=4-7" } });
  assert.deepEqual([r.status, r.body.toString(), r.headers["content-disposition"]], [206, "milk", `attachment; filename="todo.txt"; filename*=UTF-8''todo.txt`]);

  const u = await s.deck("glass.files.upload", { target: "computer:kit", dir: "", name: "up.txt", size: 5 });
  assert.equal((await fetchRaw(s.base + u.data.path, { method: "PUT", body: "hello" })).status, 200);
  assert.equal(fs.readFileSync(path.join(s.agentHome, "up.txt"), "utf8"), "hello");
  assert.deepEqual((await s.deck("glass.files.mkdir", { target: "computer:kit", path: "work" })).data, { created: true });
  assert.deepEqual((await s.deck("glass.files.move", { target: "computer:kit", from: "up.txt", to: "work/up.txt" })).data, { moved: true });
  const tr = await s.deck("glass.files.trash", { target: "computer:kit", path: "work/up.txt" });
  assert.match(tr.data.to, /^\.vyre-trash\/.*-up\.txt$/);
  assert.deepEqual(s.events("file.").map(e => [e.type, e.payload.target]), [["file.uploaded", "computer:kit"], ["file.created", "computer:kit"],
    ["file.moved", "computer:kit"], ["file.trashed", "computer:kit"]]);
});

test("glass: an agent reaches only its own computer's files, never the box or another agent's", async t => {
  const s = await boot(t);
  assert.equal((await s.kit("glass.files.list", { target: "computer:kit" })).error, undefined);
  assert.match((await s.kit("glass.files.list", { target: "computer:pax" })).error.message, /only its own computer/);
  assert.match((await s.kit("glass.files.list", { target: "box" })).error.message, /only its own computer/);
  assert.match((await s.kit("glass.files.download", { target: "box", path: "files/docs/readme.md" })).error.message, /only its own computer/);
});

test("glass: through every files tool, in every spelling an agent can arrive as, only its own computer can be the target", async t => {
  const s = await boot(t);
  const calls = { "glass.files.list": {}, "glass.files.stat": { path: "a" }, "glass.files.preview": { path: "a" }, "glass.files.download": { path: "a" },
    "glass.files.upload": { dir: "home", name: "a", size: 1 }, "glass.files.move": { from: "a", to: "b" }, "glass.files.mkdir": { path: "a" }, "glass.files.trash": { path: "a" } };
  for (const caller of ["mcp:agent:kit", "harness:agent:kit", "cli:agent:kit", "mcp:thread:t1 agent:kit"]) {
    for (const [tool, input] of Object.entries(calls)) {
      for (const target of ["computer:pax", "computer:kit2", "computer:ki", "box"]) {
        const r = await s.registry.call(tool, { ...input, target }, caller);
        assert.ok(r.error && /only its own computer/.test(r.error.message), `${caller} ${tool} ${target}: ${r.error ? r.error.message : "it was allowed"}`);
      }
    }
  }
  // A person's screen is not so limited.
  assert.equal((await s.cli("glass.files.list", { target: "computer:pax" })).error, undefined);
});

test("glass: a private key is refused by its content, whatever its name, on the way out and on the way in", async t => {
  const s = await boot(t);
  // Split so the repository hygiene scan does not take the fixture for a real key.
  const pem = "-----BEGIN " + "OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END " + "OPENSSH PRIVATE KEY-----\n";
  fs.writeFileSync(path.join(s.files, "docs", "notes.txt"), pem);
  for (const tool of ["glass.files.preview", "glass.files.download"]) {
    assert.match((await s.deck(tool, { target: "box", path: "files/docs/notes.txt" })).error.message, /private key/, tool);
  }
  const u = await s.deck("glass.files.upload", { target: "box", dir: "files/docs", name: "harmless.txt", size: Buffer.byteLength(pem) });
  const r = await fetchRaw(s.base + u.data.path, { method: "PUT", body: pem });
  assert.equal(r.status, 403);
  assert.equal(fs.existsSync(path.join(s.files, "docs", "harmless.txt")), false);
  assert.deepEqual(fs.readdirSync(path.join(s.files, "docs")).filter(n => n.startsWith(".vyre-upload-")), [], "no temp file left behind");
  const ok = await s.deck("glass.files.upload", { target: "box", dir: "files/docs", name: "tiny.txt", size: 2 });
  assert.equal((await fetchRaw(s.base + ok.data.path, { method: "PUT", body: "hi" })).status, 200, "a file shorter than the sniff window still lands");
});

test("glass: without computers.helper, an agent's files say what is missing", async t => {
  const s = await boot(t, { helper: false });
  assert.equal((await s.deck("glass.files.list", { target: "computer:kit" })).error.message, "files on an agent's computer need computers.helper");
});

// ------------------------------------------------------------ inside a real vyred

test("glass: runs in vyred beside the real computers module, and serves raw bytes over the socket", async t => {
  const root = tempHome(t);
  const files = path.join(root, "shared");
  fs.mkdirSync(files);
  fs.writeFileSync(path.join(files, "hello.txt"), "hi there");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", glass: { roots: [files] } }));
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  assert.equal(d.registry.modules.get("glass")?.state, "running", d.registry.modules.get("glass")?.error);
  const targets = await call("glass.targets", {}, { root, caller: "deck" });
  assert.ok(targets.data.some(x => x.target === "box"), JSON.stringify(targets));
  const dl = await call("glass.files.download", { target: "box", path: "shared/hello.txt" }, { root, caller: "deck" });
  const raw = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: config.paths(root).socket, path: dl.data.path, method: "GET", agent: false }, res => {
      let b = ""; res.setEncoding("utf8"); res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b, type: res.headers["content-type"] }));
    });
    req.on("error", reject); req.end();
  });
  assert.deepEqual(raw, { status: 200, body: "hi there", type: "application/octet-stream" });
  const again = await request("GET", dl.data.path, undefined, { root });
  assert.equal(again.error.code, "bad_ticket");
});

test("glass: taking and handing back the keyboard need no passkey, private or not; an agent still cannot", async t => {
  const s = await boot(t, { shield: true });
  for (const tool of ["glass.take", "glass.release"]) {
    assert.ok(!s.registry.tools.get(tool).presence && !HUMAN_ONLY.has(tool), `${tool} asks for no passkey`);
    assert.ok(PERSON_ONLY.has(tool), `${tool} is still a person's`);
  }
  assert.equal((await s.deck("glass.take", { target: "computer:kit", surface: "deck:laptop" })).error, undefined);
  assert.equal((await s.deck("glass.release", { target: "computer:kit", surface: "deck:laptop" })).data.released, true);
  assert.equal((await s.deck("glass.take", { target: "computer:kit", surface: "deck:laptop", private: true })).data.private, true, "sign in privately follows the same rule");
  assert.equal((await s.deck("glass.release", { target: "computer:kit", surface: "deck:laptop" })).data.released, true);
  assert.match((await s.kit("glass.take", { target: "computer:kit", surface: "deck:laptop" })).error.message, /not available to mcp callers/);
});
