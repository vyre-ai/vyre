// @ts-check
// Find's command grammar (shared with the Mac Lumen and the native apps), its prefixes, and the session merge: ported with the code from the Deck's tests.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const agents = [{ name: "juno" }, { name: "kit" }];
const sessions = [{ id: "s1", name: "Juniper intake form" }, { id: "s2", name: "Northwind invoices" }, { id: "s3", name: "intake" }, { id: "s4", name: "Weekly planning" }];
const world = { agents, sessions };

test("commands: @agent asks that agent, and an unknown @name is just a question", { skip: !strip }, async () => {
  const { parseCommand } = await import("./commands.js");
  assert.deepEqual(parseCommand("@Kit write the ad for Northwind", world), { kind: "agent", agent: "kit", text: "write the ad for Northwind" });
  assert.deepEqual(parseCommand("@dana hello", world), { kind: "ask", text: "@dana hello" });
  assert.equal(parseCommand("@kit", world).kind, "ask", "a bare mention has nothing to say");
});

test("commands: tell me when, tell/ask ... to, and watch find their session", { skip: !strip }, async () => {
  const { parseCommand } = await import("./commands.js");
  const w = /** @type {any} */ (parseCommand("tell me when the intake thread is done", world));
  assert.equal(w.kind, "watch");
  assert.equal(w.until, "finished");
  assert.equal(w.candidates[0].id, "s3", "an exact name first");
  assert.equal(/** @type {any} */ (parseCommand("notify me when intake asks", world)).until, "asks");
  const d = /** @type {any} */ (parseCommand("Tell northwind invoices to check the March total", world));
  assert.deepEqual([d.kind, d.text, d.candidates[0].id], ["drive", "check the March total", "s2"]);
  const m = /** @type {any} */ (parseCommand("watch weekly planning and tell me", world));
  assert.deepEqual([m.kind, m.until, m.candidates[0].id], ["watch", "either", "s4"]);
});

test("commands: no matching session leaves the words for the assistant", { skip: !strip }, async () => {
  const { parseCommand } = await import("./commands.js");
  assert.deepEqual(parseCommand("tell the bakery site to deploy", world), { kind: "ask", text: "tell the bakery site to deploy" });
  assert.deepEqual(parseCommand("what is left this week?", world), { kind: "ask", text: "what is left this week?" });
});

test("commands: sessions rank exact, then punctuation dropped, then words, then letters in order", { skip: !strip }, async () => {
  const { rankSessions } = await import("./commands.js");
  const rows = [{ id: "a", name: "Juniper-site rebuild" }, { id: "b", name: "juniper site" }, { id: "c", name: "Juniper site" }, { id: "d", name: "harbour log" }];
  assert.deepEqual(rankSessions("juniper site", rows).map((r) => r.id), ["b", "c", "a"]);
  assert.deepEqual(rankSessions("junipersite", rows).map((r) => r.id), ["b", "c", "a"]);
  assert.deepEqual(rankSessions("hbrlg", rows).map((r) => r.id), ["d"]);
  assert.deepEqual(rankSessions("", rows), []);
});

test("commands: the line under the box says what Enter does", { skip: !strip }, async () => {
  const { parseCommand, plan } = await import("./commands.js");
  assert.equal(plan(parseCommand("@kit hi", world), "", "juno"), "Enter asks kit.");
  assert.equal(plan(parseCommand("tell intake to add a phone field", world), "intake", "juno"), "Enter types into intake, then watches it.");
  assert.equal(plan(parseCommand("hello", world), "", "juno"), "Enter asks juno.");
  assert.equal(plan({ kind: "watch", query: "x", until: "asks", candidates: [] }, "intake", "juno"), "Enter watches intake and tells you when it asks.");
  assert.equal(plan({ kind: "watch", query: "x", until: "finished", candidates: [] }, "intake", "juno"), "Enter watches intake and tells you when it is done.");
  assert.equal(plan({ kind: "watch", query: "x", until: "either", candidates: [] }, "intake", "juno"), "Enter watches intake. You hear when it finishes or asks.");
});

test("parsePrefix: a letter and a space narrows; the words after it are the query; a word that starts with the letter is not a prefix", { skip: !strip }, async () => {
  const { parsePrefix } = await import("./find-prefix.js");
  assert.deepEqual(parsePrefix("p juniper"), { prefix: "p", scope: "projects", rest: "juniper" });
  assert.deepEqual(parsePrefix("t  invoice run"), { prefix: "t", scope: "chats", rest: "invoice run" });
  assert.deepEqual(parsePrefix("U juno"), { prefix: "u", scope: "people", rest: "juno" });
  assert.deepEqual(parsePrefix("  p juniper"), { prefix: "p", scope: "projects", rest: "juniper" }, "leading space is forgiven");
  assert.deepEqual(parsePrefix("p "), { prefix: "p", scope: "projects", rest: "" });
  for (const q of ["park", "pt juniper", "p", "tuesday", "u", "x juniper", "", "a p b"]) assert.equal(parsePrefix(q), null, q);
});

const catalog = [
  { id: "s-site", label: "Juniper site rebuild", cwd: "/w/juniper-site", last: 300, turns: 4, human: true, projects: ["juniper-studio"] },
  { id: "s-plan", name: "Weekly planning", title: "What is left this week?", cwd: "/w", last: 500, turns: 2, human: true, projects: ["juniper-studio", "northwind-bakery"] },
  { id: "s-loose", title: "Try the new CLI", cwd: "/w/scratch", last: 100, turns: 1, human: true, projects: [] },
  { id: "s-bot", title: "Summarise invoices", cwd: "/w/tmp", last: 50, turns: 2, human: false, projects: [] },
];
const threads = [
  { id: "s-site", name: "Juniper site rebuild", project: "juniper-studio", agent: null, status: "running", last: 900, turns: 5, asks: 1, holder: "deck" },
  { id: "t-kit", name: "Hero copy", project: null, agent: "kit", status: "waiting", last: 700, turns: 1, asks: 0, holder: null },
];

test("sessions: one row per session, the live fields win, newest first, titles fall back to the id", { skip: !strip }, async () => {
  const { mergeSessions, title } = await import("../../src/chat/core/sessions.js");
  const rows = mergeSessions(catalog, threads);
  assert.deepEqual(rows.map((r) => r.id), ["s-site", "t-kit", "s-plan", "s-loose", "s-bot"]);
  const site = rows[0];
  assert.deepEqual([site.status, site.asks, site.turns, site.live, site.projects], ["running", 1, 5, true, ["juniper-studio"]]);
  assert.equal(rows.find((r) => r.id === "s-plan")?.live, false);
  assert.equal(title(/** @type {any} */ (rows.find((r) => r.id === "s-plan"))), "Weekly planning");
  assert.equal(title({ ...rows[0], name: "" }), "s-site");
  assert.equal(mergeSessions([], threads).length, 2);
  assert.equal(mergeSessions(catalog, []).length, 4);
  assert.deepEqual(mergeSessions(null, undefined), []);
});
