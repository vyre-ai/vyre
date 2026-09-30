// @ts-check
// The `vyre` home. The list logic is pure and tested directly; the interactive flow is driven
// through streams that stand in for a terminal, against a real vyred in a temp home and a fake
// `claude` first on PATH that records how it was started.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeTerminal } from "../screen/testing.js";
import { stripAnsi } from "../screen/width.js";
import { tempHome, present } from "../../../test/helpers.js";
import { open } from "../../store/index.js";
import { SESSIONS, HOME, seedRecall } from "../../../test/fixtures/corpus.js";
import { homeItems, projectItems, step, initial, visible, keyName, render, plain, interactive } from "./home.js";

const projects = [
  { slug: "harlow-legal", name: "Harlow Legal", threads: 3, last: Date.now() - 3_600_000 },
  { slug: "northwind", name: "Northwind", threads: 2, last: 0 },
];

const press = (st, ...keys) => { let r = { st }; for (const k of keys) { r = step(r.st, k); if (r.pick || r.back || r.quit) return r; } return r; };

test("home: projects, then New session without a project, then agents; the folder's project is preselected", () => {
  const h = homeItems({ projects, agents: null, here: "northwind" });
  assert.deepEqual(h.items.map(i => i.kind), ["header", "project", "project", "new", "header", "note"]);
  assert.equal(h.items[5].label, "agents arrive with the switchboard");
  assert.equal(h.items[h.selected].value, "northwind");
  assert.match(h.items[h.selected].detail, /this folder/);
  assert.equal(homeItems({ projects, agents: null }).items[homeItems({ projects, agents: null }).selected].value, "harlow-legal");
  // Back from another project: that one is selected, and the folder's project is still marked.
  const back = homeItems({ projects, agents: null, here: "northwind", selected: "harlow-legal" });
  assert.equal(back.items[back.selected].value, "harlow-legal");
  assert.doesNotMatch(back.items[back.selected].detail, /this folder/);
  assert.match(back.items.find(i => i.value === "northwind").detail, /this folder/);
  const withAgents = homeItems({ projects: [], agents: [{ name: "juno", kind: "assistant", doing: "reading invoices" }] });
  assert.deepEqual(withAgents.items.map(i => i.kind), ["header", "note", "new", "header", "agent"]);
  assert.equal(withAgents.items[withAgents.selected].kind, "new", "a note was preselected");
  assert.equal(withAgents.items[4].detail, "reading invoices");
});

test("home: arrows skip headers and notes; Enter picks; Esc goes back; q quits", () => {
  const h = homeItems({ projects, agents: [{ name: "juno" }] });
  const st = initial(h.items, h.selected);
  assert.equal(press(st, "down", "down", "enter").pick.kind, "new");
  assert.equal(press(st, "down", "down", "down", "enter").pick.value, "juno", "the cursor stopped on the Agents header");
  assert.equal(press(st, "down", "down", "down", "down", "down", "enter").pick.value, "juno", "the cursor ran off the end");
  assert.equal(press(st, "up", "up", "enter").pick.value, "harlow-legal");
  assert.equal(press(st, "esc").back, true);
  assert.equal(press(st, "char:q").quit, true);
  assert.equal(press(st, "quit").quit, true);
});

test("home: typing filters, q is a letter while filtering, Esc clears the filter first", () => {
  const h = homeItems({ projects, agents: null });
  const st = initial(h.items, h.selected);
  assert.equal(press(st, "char:n", "char:o", "char:r", "enter").pick.value, "northwind");
  assert.equal(press(st, "char:w", "char:i", "char:t", "char:h", "char:o", "enter").pick.kind, "new");
  const typed = press(st, "char:n", "char:q");
  assert.equal(typed.quit, undefined);
  assert.equal(typed.st.filter, "nq");
  assert.deepEqual(visible(typed.st.items, typed.st.filter), []);
  assert.equal(press(st, "char:n", "char:q", "enter").pick, undefined, "Enter on an empty list picked something");
  const cleared = press(st, "char:x", "esc");
  assert.equal(cleared.back, undefined);
  assert.equal(cleared.st.filter, "");
  assert.equal(press(st, "char:x", "esc", "esc").back, true);
  assert.equal(press(st, "char:n", "char:x", "backspace", "char:o", "enter").pick.value, "northwind");
});

test("home: keys arrive in both arrow forms; drawing never wraps and scrolls to the selection", () => {
  assert.equal(keyName("\x1b[A"), "up");
  assert.equal(keyName("\x1bOB"), "down");
  assert.equal(keyName("\r"), "enter");
  assert.equal(keyName("\x1b"), "esc");
  assert.equal(keyName("\x7f"), "backspace");
  assert.equal(keyName("é"), "char:é");
  const threads = Array.from({ length: 60 }, (_, i) => ({ id: "t" + i, label: "a long session label that goes on and on " + i, last: Date.now(), how: ["folder"] }));
  const pi = projectItems({ name: "Harlow Legal", slug: "harlow-legal", home: "/w/h" }, threads);
  const st = { ...initial(pi.items, 0), cursor: 50 };
  const lines = render(st, { title: "Harlow Legal", columns: 70, rows: 12 });
  assert.ok(lines.length <= 12);
  for (const l of lines.slice(1)) assert.ok(l.replace(/\x1b\[[0-9;]*m/g, "").length < 70, "a line would wrap: " + l);
  for (const l of render(st, { title: "x", columns: 30, rows: 12 }).slice(1)) assert.ok(l.replace(/\x1b\[[0-9;]*m/g, "").length < 30, "a line would wrap: " + l);
  assert.ok(lines.some(l => l.includes("›") && l.includes("48")), "the selection scrolled out of view");
  assert.match(plain(homeItems({ projects, agents: null, here: "harlow-legal" })), /› Harlow Legal/);
});

// ------------------------------------------------------------ the interactive flow, end to end

async function world(t) {
  const { start } = await import("../../daemon/index.js");
  const root = fs.realpathSync(tempHome(t));
  const home = path.join(root, "alex");
  const moved = SESSIONS.map(s => ({ ...s, cwd: s.cwd.replace(HOME, home) }));
  for (const s of moved) fs.mkdirSync(s.cwd, { recursive: true });
  const db = open(path.join(root, "vyre.db"));
  seedRecall(db, moved);
  db.close();
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ projectsDir: path.join(root, "projects"),
    roots: [path.join(home, "Work")], transcripts: [], modules: { disable: ["recall", "memory"] } }));
  // `present`: making an agent needs a person (ADR 0004); these tests are about the screen after.
  const d = await start({ root, log: () => {}, presence: present });
  t.after(() => d.stop());
  const fake = path.join(root, "fakebin");
  fs.mkdirSync(fake);
  const log = path.join(root, "claude-calls.jsonl");
  fs.writeFileSync(path.join(fake, "claude"), `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, VYRE_HARNESS_DIR: process.env.VYRE_HARNESS_DIR, cwd: process.cwd() };
  process.env.PATH = fake + path.delimiter + process.env.PATH;
  process.env.VYRE_HARNESS_DIR = path.join(root, "no-harness");
  t.after(() => {
    process.env.PATH = saved.PATH;
    if (saved.VYRE_HARNESS_DIR === undefined) delete process.env.VYRE_HARNESS_DIR; else process.env.VYRE_HARNESS_DIR = saved.VYRE_HARNESS_DIR;
    process.chdir(saved.cwd);
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : []);
  return { root, work: path.join(home, "Work"), d, calls };
}

/**
 * Run the live screen on a stand-in terminal: wait for its first frame, type the keys, and
 * resolve to the exit code and the terminal (whose `raw` holds everything drawn).
 */
async function drive(keys) {
  const term = fakeTerminal({ columns: 100, rows: 30 });
  const done = interactive(term);
  await term.waitFor(/vyre/);
  term.type(...keys);
  const code = await done;
  return { code, term, drawn: stripAnsi(term.raw) };
}

test("home (interactive): New session without a project runs claude in this folder, with the Harness when there is one", async t => {
  const w = await world(t);
  process.chdir(w.root);
  assert.equal((await drive(["without", "\r"])).code, 0);
  const [c] = w.calls();
  assert.deepEqual(c.argv, [], "no brief and no plugin: plain claude");
  assert.equal(fs.realpathSync(c.cwd), w.root);

  const harness = path.join(w.root, "harness");
  fs.mkdirSync(path.join(harness, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(harness, ".claude-plugin", "plugin.json"), "{}");
  process.env.VYRE_HARNESS_DIR = harness;
  await drive(["without", "\r"]);
  assert.deepEqual(w.calls()[1].argv, ["--plugin-dir", harness]);
});

test("home (interactive): inside a project folder it is preselected; Enter opens it; a session resumes; Esc goes back", async t => {
  const w = await world(t);
  const harlow = path.join(w.work, "harlow-site");
  await w.d.registry.call("projects.create", { name: "Harlow Legal", home: harlow, threads: [SESSIONS[3].id] }, "cli");
  await w.d.registry.call("projects.create", { name: "Northwind", home: path.join(w.work, "northwind") }, "cli");
  process.chdir(harlow);
  // Enter on the preselected project; Esc back to the home; Enter again; down past "New
  // session in" and the header to the newest session; Enter resumes it.
  // The screen paints at most 30 times a second, so keys typed at once may never show every
  // step; what they chose is in the calls below.
  const { code } = await drive(["\r", "\x1b", "\r", "\x1b[B", "\r"]);
  assert.equal(code, 0);
  const [c] = w.calls();
  assert.deepEqual(c.argv.slice(0, 2), ["--resume", SESSIONS[3].id], "the newest session was not the one resumed");
  assert.equal(fs.realpathSync(c.cwd), w.work);
  assert.ok(c.argv.includes("--append-system-prompt"));
});

test("home (interactive): New session in a project starts claude in its home; the agents section lists agents", async t => {
  const w = await world(t);
  const harlow = path.join(w.work, "harlow-site");
  await w.d.registry.call("projects.create", { name: "Harlow Legal", home: harlow }, "cli");
  process.chdir(w.root);
  await drive(["\r", "\r"]);
  const [c] = w.calls();
  assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(harlow));
  assert.match(c.argv[c.argv.indexOf("--append-system-prompt") + 1], /"Harlow Legal"/);

  // The switchboard's agents.list answers: none yet, then the one made; q still quits.
  const first = await drive(["q"]);
  assert.equal(first.code, 0);
  assert.match(first.term.screen(), /Agents[^\n]*\n\s+none yet/);
  await w.d.registry.call("agents.create", { name: "juno", kind: "assistant" }, "local");
  const again = await drive(["q"]);
  assert.equal(again.code, 0);
  assert.match(again.term.screen(), /juno\s+not started/);
});
