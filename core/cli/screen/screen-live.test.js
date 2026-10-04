// @ts-check
// The live screen end to end: a real vyred in a temp home (with the test presence verifier, so
// no dialog can appear), the fake Claude behind the switchboard, and a stand-in terminal. A
// headless thread streams into the right pane, a send waits on another surface's keyboard until
// ctrl-l takes it, an ask is allowed with `a`, a held draft is rejected with `r`, and quitting
// gives the terminal back and releases the keyboard.
//
// VYRE_SCREEN_CAPTURES=<dir> saves the screen as text at each step, for a report.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome, upPresent } from "../../../test/helpers.js";
import { SCRATCH } from "../../../test/scratch.mjs";
import { call } from "../../daemon/client.js";
import { fakeTerminal } from "./testing.js";
import { interactive } from "../commands/home.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "switchboard", "testing", "fake-claude.js");
const UP = "\x1b[A", DOWN = "\x1b[B", HOME = "\x1b[H", END = "\x1b[F";

function capture(name, text) {
  const dir = process.env.VYRE_SCREEN_CAPTURES;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + ".txt"), text + "\n");
}

test("screen (live): a thread streams in, the keyboard is taken, an ask is allowed, a draft rejected, and quit restores the terminal", { timeout: 60_000 }, async t => {
  // Not realpath: vyred-present only runs in a home under os.tmpdir() as spelled.
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    projectsDir: path.join(root, "projects"), roots: [], transcripts: [], modules: { disable: ["recall", "memory"] },
    gate: { senders: { mail: { type: "gmail", vault: "work-mail-token", from: "alex@example.com", base: "http://127.0.0.1:9" } } },
  }));
  const saved = { bin: process.env.VYRE_CLAUDE_BIN, cwd: process.cwd() };
  process.env.VYRE_CLAUDE_BIN = FAKE;
  t.after(() => { if (saved.bin === undefined) delete process.env.VYRE_CLAUDE_BIN; else process.env.VYRE_CLAUDE_BIN = saved.bin; process.chdir(saved.cwd); });
  const up = await upPresent(root);
  assert.equal(up.code, 0, "vyred did not start");
  t.after(() => { try { process.kill(/** @type {number} */ (up.pid), "SIGTERM"); } catch {} });

  // Another surface starts a thread and so holds its keyboard; an agent asks to send an email.
  // The thread works outside the home: the security floor treats everything in VYRE_HOME as Vyre's
  // own state and refuses a write there before anyone is asked, as on a real machine.
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const started = await call("threads.start", { cwd: work, prompt: "hello from alex", surface: "deck:phone" });
  assert.ok(started.data, JSON.stringify(started));
  const thread = started.data.id;
  const held = await call("gate.request", { kind: "send", via: "mail", to: "dana@harlowlegal.com", content: { subject: "Intake follow-up", body: "Dana, the intake notes are ready." } }, { caller: "mcp" });
  assert.ok(held.data, JSON.stringify(held));

  process.chdir(root);
  const term = fakeTerminal({ columns: 100, rows: 30 });
  const done = interactive(term);
  // A failed step must not leave the screen running: its stream would keep this process alive.
  t.after(async () => { term.type("\x03"); await done; });
  await term.waitFor(/Inbox \(1\)/);
  // The draft is the first item, so it opens selected, its content loaded.
  const home = await term.waitFor(/subject {2}Intake follow-up/);
  assert.match(home, /✉ send to dana@harlowlegal\.com/);
  assert.equal(term.modes.alt, true);
  assert.equal(term.input.raw, true);
  capture("01-home-with-inbox", home);

  // The headless thread is the last item: its reply is already there from the backlog.
  term.type(END);
  capture("02-streaming-thread", await term.waitFor(/echo: hello from alex/));

  // Tab to type; the phone holds the keyboard, so the send waits and says how to take it.
  const file = path.join(work, "notes.md");
  term.type("\t", "write " + file, "\r");
  assert.match(await term.waitFor(/deck:phone has the keyboard · ctrl-l takes it/), /notes\.md▏/, "the typed line was lost");
  term.type("\x0c");
  await term.waitFor(/keyboard: this terminal · taken from deck:phone/);
  term.type("\r");
  // The ask shows in the thread and in the Inbox.
  await term.waitFor(/\? Write: /);
  await term.waitFor(/Inbox \(2\)/);
  term.type("\x1b");
  await new Promise(r => setTimeout(r, 60));
  term.type(HOME);
  const ask = await term.waitFor(/a allows · d denies · enter asks/);
  assert.match(ask, /› \? Write/);
  capture("03-ask-selected", ask);
  term.type("a");
  await term.waitFor(/allowed · Write/);
  await term.waitFor(/Inbox \(1\)/);
  assert.equal(fs.readFileSync(file, "utf8"), "hi", "the allowed write did not happen");

  // The draft: its content shows, r rejects it, and nothing is sent.
  term.type(HOME);
  const draft = await term.waitFor(/subject {2}Intake follow-up/);
  assert.match(draft, /Dana, the intake notes are ready\./);
  term.type("r");
  await term.waitFor(/rejected · nothing was sent/);
  await term.waitFor(/nothing is waiting on you/);

  term.type("?");
  capture("04-help", await term.waitFor(/any key closes this/));
  term.type(" ");
  await term.waitFor(/type to filter · \? keys/);

  term.type(END);
  term.resize(60, 20);
  capture("05-narrow-60x20", await term.waitFor(/Wrote it\./));
  for (const l of term.screen().split("\n")) assert.ok(l.length <= 60, "a line is wider than the terminal: " + l);

  term.type("q");
  assert.equal(await done, 0);
  assert.deepEqual(term.modes, { alt: false, cursor: true, paste: false }, "the terminal was not given back");
  assert.equal(term.input.raw, false);
  assert.ok(term.raw.endsWith("\x1b[?2004l\x1b[?25h\x1b[?1049l"), "the restore sequence was not the last thing written");
  const after = await call("threads.get", { thread, limit: 1 });
  assert.equal(after.data.thread.holder, null, "the screen kept the keyboard after it quit");
  const answered = await call("threads.get", { thread, limit: 200 });
  assert.ok(answered.data.events.some(e => e.type === "ask.answered" && e.payload.decision === "allow"));
});
