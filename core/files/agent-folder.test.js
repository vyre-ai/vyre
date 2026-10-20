// @ts-check
// Files > Agents > <agent>: the agent's folder on its computer, through the same Files calls as the Drive. The computer is stood in by the real helper (core/computers/image/agentd-fs.js, computerd's
// own path guard) on a temp home per agent, reached through vyred's real client (core/computers/agent-files.js), so a path is checked here the way the computer checks it.
// What this shows: the access rule (owner yes; a member with Can use reads and does not change; a member with no share and another agent are refused), list, read and write round-trips, path
// confinement through Files, what only the Drive does refused, the computer waking, and the move from the Drive and the sessions folder with nothing overwritten and nothing lost.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { registerSpaceDrive } from "./space-drive.js";
import { registerSpaceEdit } from "./space-edit.js";
import { registerSpaceLinks } from "./space-links.js";
import { registerAgentFolder, AGENT_FOLDER_RULE, KEPT_NOTE, entriesOf } from "./agent-folder.js";
import { makeAgentFiles } from "../computers/agent-files.js";
import { serveFs } from "../computers/image/agentd-fs.js";
import { validateFs } from "../computers/image/agentd.js";
import { SCRATCH } from "../../test/scratch.mjs";

/** agentd holds the operation only when it passes validateFs; a refusal comes back the way agentd-ctl.js words it. @param {any} spec */
const held = spec => { try { return validateFs(spec); } catch (e) { throw new Error(`the agent computer could not ticket (400: ${/** @type {Error} */ (e).message})`); } };

const SPACE = "spc_abcdefghijkl";
const A = "agt_writer", B = "agt_other";
const chainOf = (/** @type {string} */ who) => ({ space: SPACE, hops: [{ actor: { kind: "person", id: who, space: SPACE } }] });

/** The world: two agents with a home each on the "computer", a Drive, the people and their levels. */
function rig(t, o = /** @type {{ waking?: boolean, noComputer?: boolean }} */ ({})) {
  const top = fs.mkdtempSync(path.join(SCRATCH, "agent-folder-"));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const homes = /** @type {Record<string, string>} */ ({});
  for (const name of ["writer", "other"]) {
    const h = path.join(top, "computer", name);
    for (const f of ["Inbox", "Work", "Done", "Scripts", "Notes"]) fs.mkdirSync(path.join(h, f), { recursive: true });
    homes[name] = h;
  }
  fs.writeFileSync(path.join(homes.other, "Work", "theirs.txt"), "the other agent's");
  fs.symlinkSync(homes.other, path.join(homes.writer, "to-other"));
  // the Drive: a path -> bytes map, read under the caller's chain (everyone here may read it)
  /** @type {Map<string, Buffer>} */ const drive = new Map();
  const driveApi = {
    list: async (/** @type {any} */ _c, /** @type {string} */ prefix) => [...drive.keys()].filter(k => k.startsWith(prefix)).map(k => ({ path: k, size: drive.get(k)?.length })),
    listPage: async (/** @type {any} */ _c, /** @type {string} */ prefix) => ({ entries: [...drive.keys()].filter(k => k.startsWith(prefix)).map(k => ({ path: k })), next: null }),
    get: async (/** @type {any} */ _c, /** @type {string} */ p) => { const b = drive.get(p); if (!b) throw Object.assign(new Error("no"), { code: "not_found" }); return new Uint8Array(b); },
    put: async (/** @type {any} */ _c, /** @type {string} */ p, /** @type {Uint8Array} */ b) => { drive.set(p, Buffer.from(b)); return { version: 1 }; },
    stat: async () => { throw Object.assign(new Error("no"), { code: "not_found" }); },
    delete: async (/** @type {any} */ _c, /** @type {string} */ p) => { drive.delete(p); },
    history: async () => [],
  };
  const agentRows = [{ id: "rec_1", data: { uid: A, name: "writer", folder: `agents/${A}` } }, { id: "rec_2", data: { uid: B, name: "other", folder: `agents/${B}` } }];
  // who sees which agent record, and at what level (agents.level, asked as the person)
  const visible = /** @type {Record<string, any[]>} */ ({ per_owner: agentRows, per_user: agentRows.slice(0, 1), per_none: [] });
  const levels = /** @type {Record<string, Record<string, string>>} */ ({ per_owner: { writer: "edit", other: "edit" }, per_user: { writer: "use" }, per_none: {} });
  // the computer: the real client and helper, with tickets held in memory
  /** @type {Map<string, { agent: string, spec: any }>} */ const tickets = new Map();
  const files = makeAgentFiles({ ready: async () => {}, ticket: async (agent, hello, spec) => { tickets.set(hello, { agent, spec: held(spec) }); }, where: async () => ({ host: "-", port: 0 }),
    exchange: async (at, body) => {
      const got = /** @type {any} */ (tickets.get(at.hello.trim())); tickets.delete(at.hello.trim());
      const input = new PassThrough(), output = new PassThrough(); const chunks = /** @type {Buffer[]} */ ([]); output.on("data", c => chunks.push(c));
      input.end(Buffer.concat([Buffer.from(JSON.stringify(got.spec) + "\n"), body || Buffer.alloc(0)]));
      await serveFs({ root: homes[got.agent], input, output });
      const all = Buffer.concat(chunks), nl = all.indexOf(10), head = JSON.parse(all.subarray(0, nl).toString());
      return { status: head.status, headers: head.headers, body: all.subarray(nl + 1) };
    } });
  /** @type {string[]} */ const opened = [];
  let current = "", currentCaller = "";
  const computers = async (/** @type {any} */ i) => {
    if (o.noComputer) return { error: { code: "no_such_tool", message: "no tool computers.agent.files" } };
    try {
      switch (i.op) {
        case "open": opened.push(i.agent); if (o.waking) return { error: { code: "waking", message: "Opening this agent's computer… Wait a few seconds, then try again." } }; return { data: { state: "open" } };
        case "list": return { data: await files.list(i.agent, i.path) };
        case "read": { const b = await files.read(i.agent, i.path); return { data: { size: b.length, base64: b.toString("base64") } }; }
        case "write": return { data: await files.write(i.agent, i.path, Buffer.from(i.base64, "base64"), { overwrite: i.overwrite }) };
        case "mkdir": return { data: await files.mkdir(i.agent, i.path) };
        case "move": return { data: await files.move(i.agent, i.from, i.to) };
        case "trash": return { data: await files.trash(i.agent, i.path) };
        default: return { error: { code: "bad_input", message: "op" } };
      }
    } catch (e) { return { error: { code: /** @type {any} */ (e).code, message: /** @type {Error} */ (e).message } }; }
  };
  /** @type {Map<string, any>} */ const tools = new Map();
  const db = new DatabaseSync(":memory:"), ran = new Set();
  const ctx = {
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), route: () => {},
    call: async (/** @type {string} */ name, /** @type {any} */ i, /** @type {any} */ opts) => {
      // agents.level judges the relayed person and refuses a caller that is not a person's own surface (core/agents/config.js only())
      if (name === "agents.level") return opts && opts.relay === true && !/^(mcp|harness)/.test(currentCaller) ? { data: { agent: i.agent, level: (levels[current] || {})[i.agent] || "none" } } : { error: { code: "denied", message: "only a person" } };
      if (name === "computers.agent.files") return computers(i);
      return { error: { code: "no_such_tool", message: `no tool ${name}` } };
    },
    store: { db, migrate: (/** @type {string[]} */ steps) => { for (const s of steps) if (!ran.has(s)) { ran.add(s); db.exec(s); } } },
    config: { projectsDir: path.join(top, "plain", "projects") },
    kernel: { space: SPACE, owner: "per_owner", for: async () => ({ gateway: { drive: driveApi, records: { query: async (/** @type {any} */ c) => ({ rows: visible[c.hops[0].actor.id] || [] }) } }, surfaces: {} }),
      chainIn: async (/** @type {string} */ _s, /** @type {any} */ meta) => { if (!meta.who) throw Object.assign(new Error("no person"), { code: "denied" }); return chainOf(meta.who); } },
  };
  registerSpaceDrive(ctx); registerSpaceEdit(ctx); registerSpaceLinks(ctx); registerAgentFolder(ctx);
  /** Call a tool as a person (or a model or agent label) and get its data, or the refusal as { error }. */
  const as = (/** @type {string} */ who, /** @type {string} */ caller = "deck", /** @type {any} */ extra = {}) => async (/** @type {string} */ name, /** @type {any} */ i = {}) => {
    current = who; currentCaller = caller;
    try { return await tools.get(name).run(i, { caller, who, ...extra }); } catch (e) { return { error: { code: /** @type {any} */ (e).code, message: /** @type {Error} */ (e).message } }; }
  };
  return { homes, drive, tools, db, opened, plain: path.join(top, "plain", "agents", A), owner: as("per_owner"), user: as("per_user"), none: as("per_none"), as };
}

test("the rule is one table: see with Can use or Can edit, change with Can edit", () => {
  assert.deepEqual(AGENT_FOLDER_RULE, { see: ["use", "edit"], change: ["edit"] });
  assert.match(KEPT_NOTE, /^Kept on this agent's computer/);
});

test("the owner writes, lists and reads an agent's folder through Files, and the files are the ones on its computer", async t => {
  const r = rig(t);
  const up = await r.owner("files.drive.upload", { path: `agents/${A}/Inbox/brief.md`, base64: Buffer.from("# brief").toString("base64") });
  assert.equal(up.size, 7, JSON.stringify(up));
  assert.equal(fs.readFileSync(path.join(r.homes.writer, "Inbox", "brief.md"), "utf8"), "# brief", "the file is on the agent's computer");
  assert.equal(r.drive.size, 0, "and nothing went to the Drive");
  // a file the agent wrote on its computer (its terminal) is there in Files
  fs.writeFileSync(path.join(r.homes.writer, "Work", "from-terminal.txt"), "made in the terminal");
  const top = await r.owner("files.drive.space.list", { prefix: `agents/${A}` });
  assert.equal(top.agent_folder.note, KEPT_NOTE); assert.equal(top.agent_folder.can, "edit");
  for (const f of ["Inbox", "Work", "Done", "Scripts", "Notes"]) assert.ok(top.entries.some((/** @type {any} */ e) => e.path === `agents/${A}/${f}/.folder`), f);
  const work = await r.owner("files.drive.space.list", { prefix: `agents/${A}/Work/` });
  assert.deepEqual(work.entries.map((/** @type {any} */ e) => [e.path, e.size]), [[`agents/${A}/Work/from-terminal.txt`, 20]]);
  const read = await r.owner("files.drive.space.read", { path: `agents/${A}/Work/from-terminal.txt` });
  assert.equal(Buffer.from(read.base64, "base64").toString(), "made in the terminal");
  // an upload over an existing name replaces it only when the person had it open (base); otherwise it is a conflict
  assert.equal((await r.owner("files.drive.upload", { path: `agents/${A}/Inbox/brief.md`, base64: Buffer.from("x").toString("base64") })).error.code, "conflict");
  assert.equal((await r.owner("files.drive.upload", { path: `agents/${A}/Inbox/brief.md`, base64: Buffer.from("v2").toString("base64"), base: 1 })).size, 2);
  assert.equal(fs.readFileSync(path.join(r.homes.writer, "Inbox", "brief.md"), "utf8"), "v2");
  assert.deepEqual(await r.owner("files.drive.space.mkdir", { parent: `agents/${A}/Work`, name: "drafts" }), { path: `agents/${A}/Work/drafts` });
  assert.equal((await r.owner("files.drive.space.move", { from: `agents/${A}/Inbox/brief.md`, to: `agents/${A}/Work/drafts/brief.md` })).moved, 1);
  assert.equal((await r.owner("files.drive.space.rename", { path: `agents/${A}/Work/drafts/brief.md`, name: "final.md" })).moved, 1);
  assert.ok(fs.existsSync(path.join(r.homes.writer, "Work", "drafts", "final.md")));
  assert.equal((await r.owner("files.drive.space.delete", { path: `agents/${A}/Work/drafts/final.md` })).deleted, 1);
  assert.ok(!fs.existsSync(path.join(r.homes.writer, "Work", "drafts", "final.md")), "a delete moves it to the agent's trash");
  assert.ok(fs.readdirSync(path.join(r.homes.writer, ".vyre-trash")).length === 1, "where it can still be found");
});

test("the access rule: a member with Can use reads and changes nothing; a member with no share, another agent and a model are refused", async t => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.homes.writer, "Work", "plan.md"), "plan");
  const list = await r.user("files.drive.space.list", { prefix: `agents/${A}/Work` });
  assert.equal(list.agent_folder.can, "use"); assert.equal(list.entries.length, 1);
  assert.equal(Buffer.from((await r.user("files.drive.space.read", { path: `agents/${A}/Work/plan.md` })).base64, "base64").toString(), "plan");
  for (const [tool, input] of /** @type {[string, any][]} */ ([["files.drive.upload", { path: `agents/${A}/Work/x.md`, base64: "eA==" }], ["files.drive.space.mkdir", { parent: `agents/${A}/Work`, name: "x" }],
    ["files.drive.space.move", { from: `agents/${A}/Work/plan.md`, to: `agents/${A}/Done/plan.md` }], ["files.drive.space.delete", { path: `agents/${A}/Work/plan.md` }]])) {
    const x = await r.user(tool, input);
    assert.equal(x.error && x.error.code, "denied", `${tool} needs Can edit`); assert.match(x.error.message, /Can edit/);
  }
  assert.ok(fs.existsSync(path.join(r.homes.writer, "Work", "plan.md")));
  // a member the agent is not shared with: the agent's record is not shown to them, so its folder does not open
  const none = await r.none("files.drive.space.list", { prefix: `agents/${A}` });
  assert.equal(none.error && none.error.code, "not_found");
  assert.equal((await r.none("files.drive.space.read", { path: `agents/${A}/Work/plan.md` })).error.code, "not_found");
  // ...and a member who can see the record but has no level on it
  assert.equal((await r.user("files.drive.space.list", { prefix: `agents/${B}` })).error.code, "not_found");
  // another agent, however it calls: its own claim, or a verified agent behind a person's surface
  const otherAgent = await r.as("per_owner", "mcp:agent:other")("files.drive.space.read", { path: `agents/${A}/Work/plan.md` });
  assert.equal(otherAgent.error && otherAgent.error.code, "denied", "an agent never reads another agent's folder");
  const behind = await r.as("per_owner", "deck", { agent: "other" })("files.drive.space.list", { prefix: `agents/${A}` });
  assert.equal(behind.error && behind.error.code, "denied");
  // an unnamed model session is no person: agents.level refuses it, so it has no level
  const model = await r.as("per_owner", "mcp")("files.drive.space.read", { path: `agents/${A}/Work/plan.md` });
  assert.equal(model.error && model.error.code, "denied");
  assert.equal((await r.as("per_owner", "mcp:agent:other")("files.agent.open", { path: `agents/${A}` })).error.code, "denied");
});

test("paths stay in the agent's folder: dot segments, absolute paths and a link to another agent's home are refused through Files", async t => {
  const r = rig(t);
  for (const p of [`agents/${A}/../${B}/Work/theirs.txt`, `/agents/${A}/x`, `agents/${A}/Work/%2e%2e/x`]) {
    const x = await r.owner("files.drive.space.read", { path: p });
    assert.ok(x.error && ["bad_input", "not_found"].includes(x.error.code), `${p}: ${JSON.stringify(x)}`);
  }
  const link = await r.owner("files.drive.space.read", { path: `agents/${A}/to-other/Work/theirs.txt` });
  assert.equal(link.error && link.error.code, "denied", "a link to another agent's home leads nowhere");
  const up = await r.owner("files.drive.upload", { path: `agents/${A}/to-other/planted.txt`, base64: "eA==" });
  assert.equal(up.error && up.error.code, "denied");
  assert.ok(!fs.existsSync(path.join(r.homes.other, "planted.txt")));
  assert.ok(!(await r.owner("files.drive.space.list", { prefix: `agents/${A}` })).entries.some((/** @type {any} */ e) => /to-other/.test(e.path)), "a link out of the home is not listed");
  const across = await r.owner("files.drive.space.move", { from: `agents/${A}/Work`, to: `agents/${B}/Work/x` });
  assert.equal(across.error && across.error.code, "bad_input", "nothing moves from one agent's folder to another's");
  const out = await r.owner("files.drive.space.move", { from: `agents/${A}/Work`, to: "Notes/x" });
  assert.equal(out.error && out.error.code, "bad_input", "or between an agent's folder and the Drive");
});

test("what only the Drive does is refused for an agent's folder, in plain words", async t => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.homes.writer, "Work", "plan.md"), "plan");
  for (const [tool, input] of /** @type {[string, any][]} */ ([["files.drive.restore", { path: `agents/${A}/Work/plan.md`, version: 1 }], ["files.drive.link.create", { path: `agents/${A}/Work/plan.md` }]])) {
    const x = await r.owner(tool, input);
    assert.equal(x.error && x.error.code, "unavailable", tool); assert.match(x.error.message, /kept on its computer/);
  }
});

test("the computer waking, and a server with no agent computers, are said plainly", async t => {
  const w = rig(t, { waking: true });
  const open = await w.owner("files.agent.open", { path: `agents/${A}` });
  assert.equal(open.state, "waking"); assert.equal(open.message, "Opening this agent's computer…"); assert.deepEqual(w.opened, ["writer"]);
  const n = rig(t, { noComputer: true });
  const none = await n.owner("files.drive.space.list", { prefix: `agents/${A}` });
  assert.equal(none.error && none.error.code, "unavailable"); assert.match(none.error.message, /Agent computers are not set up on this server/);
  // the rest of the Drive is untouched by any of this
  n.drive.set("Notes/a.txt", Buffer.from("a"));
  assert.equal((await n.owner("files.drive.space.list", { prefix: "Notes" })).entries.length, 1);
});

test("the move from the Drive and the sessions folder: into Inbox at the old paths, never over a file, nothing lost, once", async t => {
  const r = rig(t);
  r.drive.set(`agents/${A}/work/report.txt`, Buffer.from("drive copy"));
  r.drive.set(`agents/${A}/context/notes.md`, Buffer.from("context"));
  r.drive.set(`agents/${A}/work/.folder`, Buffer.alloc(0));
  r.drive.set("Notes/elsewhere.txt", Buffer.from("not the agent's"));
  // the computer already has a different file at one of those places
  fs.mkdirSync(path.join(r.homes.writer, "Inbox", "work"), { recursive: true });
  fs.writeFileSync(path.join(r.homes.writer, "Inbox", "work", "report.txt"), "already on the computer");
  // the plain sessions folder: one file the same as the Drive's, one of its own
  fs.mkdirSync(path.join(r.plain, "work"), { recursive: true }); fs.mkdirSync(path.join(r.plain, "memory"), { recursive: true });
  fs.writeFileSync(path.join(r.plain, "work", "report.txt"), "drive copy");
  fs.writeFileSync(path.join(r.plain, "memory", "facts.md"), "facts");
  // a member with Can use opens it: the computer opens, nothing moves (moving needs Can edit)
  const looked = await r.user("files.agent.open", { path: `agents/${A}` });
  assert.equal(looked.state, "open"); assert.equal(looked.can, "use"); assert.equal(looked.moved, undefined);
  assert.ok(!fs.existsSync(path.join(r.homes.writer, "Inbox", "context")));
  const first = await r.owner("files.agent.open", { path: `agents/${A}` });
  assert.equal(first.state, "open"); assert.equal(first.note, KEPT_NOTE);
  assert.equal(first.moved.state, "done", JSON.stringify(first));
  const inbox = (/** @type {string} */ p) => fs.readFileSync(path.join(r.homes.writer, "Inbox", p), "utf8");
  assert.equal(inbox("work/report.txt"), "already on the computer", "nothing is overwritten");
  assert.equal(inbox("work/report (from before).txt"), "drive copy", "the Drive's file is kept beside it under a new name");
  assert.equal(inbox("context/notes.md"), "context");
  assert.equal(inbox("memory/facts.md"), "facts", "the sessions folder's own file came over");
  assert.ok(!fs.existsSync(path.join(r.homes.writer, "Inbox", "work", "report (from before 2).txt")), "the same bytes are not copied twice");
  assert.ok(!fs.existsSync(path.join(r.homes.writer, "Inbox", "work", ".folder")), "the Drive's folder marks are not files");
  // nothing was lost: the Drive copy and the sessions folder are as they were
  assert.equal(r.drive.get(`agents/${A}/work/report.txt`)?.toString(), "drive copy");
  assert.equal(r.drive.get("Notes/elsewhere.txt")?.toString(), "not the agent's");
  assert.equal(fs.readFileSync(path.join(r.plain, "memory", "facts.md"), "utf8"), "facts");
  assert.ok(fs.existsSync(path.join(r.plain, ".vyre-moved")), "the sessions folder is marked");
  const row = /** @type {any} */ (r.db.prepare("SELECT * FROM files_agent_moves WHERE agent_uid = ?").get(A));
  assert.equal(row.state, "done"); assert.equal(row.keep_until, "0.6.5"); assert.equal(row.by, "person:per_owner");
  // the old Drive copy stays readable by version, and restoring into it is refused (read-only)
  assert.equal((await r.owner("files.drive.restore", { path: `agents/${A}/work/report.txt`, version: 1 })).error.code, "unavailable");
  // once: a second open moves nothing again
  fs.rmSync(path.join(r.homes.writer, "Inbox", "context"), { recursive: true });
  const again = await r.owner("files.agent.open", { path: `agents/${A}` });
  assert.equal(again.moved.already, true);
  assert.ok(!fs.existsSync(path.join(r.homes.writer, "Inbox", "context")), "the move ran once");
});

test("a computer listing becomes Drive-shaped entries: folders by their mark, files with a size, links out of the home and dot names left out", () => {
  assert.deepEqual(entriesOf("agents/x", [{ name: "Work", kind: "dir", mtime: 5 }, { name: "a.txt", kind: "file", size: 3, mtime: 6 }, { name: "Downloads", kind: "dir", readOnly: true },
    { name: "out", kind: "link", to: null }, { name: "in", kind: "link", to: "file", size: 1, mtime: 7 }, { name: ".cache", kind: "dir" }, { name: ".notes.txt", kind: "file", size: 1 }]), [
    { path: "agents/x/Work/.folder", name: ".folder", size: 0, ver: 0, at: 5 }, { path: "agents/x/a.txt", name: "a.txt", size: 3, ver: 1, at: 6 },
    { path: "agents/x/Downloads/.folder", name: ".folder", size: 0, ver: 0, at: 0, read_only: true }, { path: "agents/x/in", name: "in", size: 1, ver: 1, at: 7 }]);
});
