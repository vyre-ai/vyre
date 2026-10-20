// An agent's Routines and Watchers: one list from its own (watchers.list) and its duties (team.duties.list), shown on its panel beside a chat and on its page,
// with only the person's acts (Pause, Resume, Run now, Delete) and no form anywhere: a Routine or a Watcher is made by asking the agent in chat.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routineRows, rowLine, detailLines, actCall, emptyLine, dutyKind, SAMPLE_ROWS } from "./routines-model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, "..", "..");
const read = (p) => fs.readFileSync(path.join(app, p), "utf8");

const OWN = { watchers: [
  { name: "northwind-invoices", agent: "scout", kind: "watcher", state: "on", title: "Tells you when an invoice from Northwind arrives", every: "every 15 minutes", person: "per_me", next: "2026-10-20T10:15:00", lastRun: "2026-10-20T10:00:00", items: 3, failures: 0 },
  { name: "morning-inbox", agent: "scout", kind: "routine", state: "on", instruction: "Check my inbox and tell me what needs me", every: "every weekday at 09:00", person: "per_other1", lastRun: "2026-10-20T09:00:00", lastError: "the inbox answered 500", failures: 2 },
  { name: "status-page", agent: "scout", kind: "watcher", state: "paused", waiting: true, title: "Tells you about an outage", person: "per_me" },
  { name: "a-person-watcher", state: "on", title: "Not an agent's" },
] };
const DUTIES = { duties: [{ id: "d1", watcher: "duty-scout-d1", trigger: "daily 17:00", title: "Sum up the day", enabled: true, run_as: "per_me" }, { id: "d2", watcher: "duty-scout-d2", trigger: "thread.finished", instruction: "Review the thread", enabled: false, started: true }] };

test("one list: the agent's own Routines and Watchers and its duties, Routines first, each with its schedule or what it watches, its state and whom it runs for", () => {
  const rows = routineRows(OWN, DUTIES, "per_me");
  assert.deepEqual(rows.map((r) => [r.kind, r.source, r.title, r.word]), [
    ["routine", "own", "Check my inbox and tell me what needs me", "On"],
    ["routine", "duty", "Sum up the day", "On"],
    ["watcher", "duty", "Review the thread", "Paused"],
    ["watcher", "own", "Tells you about an outage", "Testing"],
    ["watcher", "own", "Tells you when an invoice from Northwind arrives", "On"],
  ], "a watcher no agent owns is not in an agent's list");
  assert.equal(rowLine(rows[0]), "Runs every weekday at 09:00 · For member other1");
  assert.equal(rowLine(rows[4]), "Tells you when an invoice from Northwind arrives · For you");
  assert.equal(rowLine(rows[1]), "Runs daily 17:00 · For you");
  assert.equal(rowLine(rows[2]), "When thread.finished");
  assert.deepEqual([dutyKind("weekdays 09:30"), dutyKind("15 7 * * 1-5"), dutyKind("push gmail"), dutyKind("goal.stale")], ["routine", "routine", "watcher", "watcher"]);
});

test("the page's detail: next run, last run with its result, items found, failures; a waiting Watcher says so", () => {
  const rows = routineRows(OWN, null, "per_me");
  const by = (t) => rows.find((r) => r.title.startsWith(t));
  assert.deepEqual(detailLines(by("Tells you when")).map((l) => l.replace(/\d+ Oct(?: \d{4})?, \S+(?: [ap]m)?/, "T")), ["Next run T", "Last run T: Ran", "3 items found"]);
  assert.deepEqual(detailLines(by("Check my inbox")).map((l) => l.replace(/\d+ Oct(?: \d{4})?, \S+(?: [ap]m)?/, "T")), ["Last run T: Failed: the inbox answered 500", "2 failures in a row"]);
  assert.deepEqual(detailLines(by("Tells you about")), ["Waiting for its first test to pass"]);
});

test("only the acts the server allows the person: Run now, Pause and Delete when on; Resume and Delete when paused; only Delete while testing; each the right tool", () => {
  const rows = routineRows(OWN, DUTIES, "per_me");
  const by = (t) => rows.find((r) => r.title.startsWith(t));
  assert.deepEqual(by("Tells you when").actions, ["run", "pause", "delete"]);
  assert.deepEqual(by("Tells you about").actions, ["delete"]);
  assert.deepEqual(by("Review").actions, ["resume", "delete"]);
  assert.deepEqual(actCall(by("Tells you when"), "pause"), { tool: "watchers.pause", input: { name: "northwind-invoices" } });
  assert.deepEqual(actCall(by("Tells you when"), "run"), { tool: "watchers.run", input: { name: "northwind-invoices" } });
  assert.deepEqual(actCall(by("Tells you when"), "delete"), { tool: "watchers.delete", input: { name: "northwind-invoices" } });
  assert.deepEqual(actCall(by("Review"), "resume"), { tool: "team.duties.enable", input: { id: "d2" } });
  assert.deepEqual(actCall(by("Sum up"), "run"), { tool: "team.duties.run-now", input: { id: "d1" } });
  assert.deepEqual(actCall(by("Sum up"), "pause"), { tool: "team.duties.disable", input: { id: "d1" } });
  assert.equal(emptyLine("scout"), "Ask scout to set one up, for example \"every morning at 9, check my inbox and tell me what needs me\".");
  assert.equal(SAMPLE_ROWS.length, 4);
});

test("both places read the same list: the agent's panel beside a chat and its page under Apps, Agents", () => {
  assert.match(read("src/chat/ChatPanel.tsx"), /<AgentRoutines agent=\{agents\[0\]\.name\} \/>/, "an agent chat's panel");
  assert.match(read("src/chat/ChatPanel.tsx"), /<AgentRoutines agent=\{name\} \/>/, "an agent opened in a group's panel");
  assert.match(read("screens/assistants/AgentPage.tsx"), /<AgentRoutines agent=\{a\.name\} detail \/>/, "the agent's page, with detail");
  assert.match(read("screens/assistants/AgentRoutines.tsx"), /routinesSource\(callT\)/);
});

test("no form makes a Routine or a Watcher anywhere in the app, and Flows show no watchers", () => {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === "node_modules" || e.name.startsWith(".")) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p); } })(path.join(app, "screens"));
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p); } })(path.join(app, "ui", "flows"));
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(s, /label="New (watcher|routine)"|"New (watcher|routine)"|NewWatcherSheet|watchers\.preset"|watchers\.write"|watchers\.routine\.create"/i, `${path.relative(app, f)} offers a way to make one`);
  }
  for (const gone of ["screens/flows/WatchersTab.tsx", "screens/flows/NewWatcherSheet.tsx"]) assert.equal(fs.existsSync(path.join(app, gone)), false, gone);
  assert.doesNotMatch(read("screens/flows/RealFlows.tsx"), /Watchers/);
  assert.doesNotMatch(read("ui/flows/TriggerFields.tsx"), /Which watcher|New watcher/);
});
