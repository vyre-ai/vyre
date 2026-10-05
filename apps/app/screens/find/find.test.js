// @ts-check
// Find against a fake box: what is loaded once, what each query asks, how results are sectioned and worded, and what Enter runs.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const NOW = Date.parse("2026-10-05T12:00:00Z");

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o.error?.[tool]) return { error: o.error[tool] };
    switch (tool) {
      case "agents.list": return { data: [{ name: "kit", kind: "agent", instructions: "Reviews contracts\nmore" }, { name: "juno", kind: "assistant", instructions: "" }, { nope: 1 }] };
      case "projects.catalog": return { data: { sessions: [{ id: "s1", label: "Juniper intake call", projects: ["juniper"], last: NOW - 3600_000, cwd: "/Users/x/work/juniper" }, { id: "s2", label: "", last: 5 }] } };
      case "threads.list": return { data: [{ id: "s3", name: "Probate checklist", project: "juniper", agent: "kit" }] };
      case "projects.list": return { data: { projects: [{ slug: "juniper", name: "Juniper Studio" }, { slug: "bare" }, { name: "no slug" }] } };
      case "agents.ask": return { data: o.ask ?? { thread: "t9" } };
      case "threads.send": return { data: o.send ?? { sent: true } };
      case "threads.watch": return { data: {} };
      default: return { data: [] };
    }
  };
  return { call, seen };
}

test("load: agents (the assistant first), sessions merged from the catalog and the threads, projects named", { skip: !strip }, async () => {
  const { findSource } = await import("./source.ts");
  const b = box();
  const l = await findSource(b.call, "web").load();
  assert.deepEqual(l.agents.map((a) => a.name), ["juno", "kit"]);
  assert.equal(l.assistant, "juno");
  assert.deepEqual(l.sessions.map((s) => s.id).sort(), ["s1", "s2", "s3"]);
  assert.deepEqual(l.projects, [{ slug: "juniper", name: "Juniper Studio" }, { slug: "bare", name: "bare" }]);
  assert.deepEqual(b.seen.map((s) => s.tool).sort(), ["agents.list", "projects.catalog", "projects.list", "threads.list"]);
  assert.deepEqual(b.seen.find((s) => s.tool === "projects.catalog")?.input, { limit: 300 });
  assert.deepEqual(b.seen.find((s) => s.tool === "threads.list")?.input, { all: true });
  const none = await findSource(box({ error: { "agents.list": { code: "no_such_tool", message: "x" }, "threads.list": { code: "no_such_tool", message: "x" } } }).call, "web").load();
  assert.deepEqual([none.agents, none.assistant], [[], null]);
});

test("search: five tools per query, only from two characters, the files tool sends its source only when it is the mac or the box", { skip: !strip }, async () => {
  const { findSource } = await import("./source.ts");
  const b = box();
  const s = findSource(b.call, "web");
  const got = [];
  const on = { recall: () => got.push("r"), files: () => got.push("f"), memory: () => got.push("m"), mentions: () => got.push("x"), drive: () => got.push("d") };
  s.search("a", on);
  assert.equal(b.seen.length, 0);
  s.search("juniper", on);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [["recall.search", { q: "juniper", limit: 20 }], ["files.search", { q: "juniper", limit: 20 }], ["memory.relevant", { text: "juniper", limit: 5 }], ["mentions.search", { q: "juniper", limit: 8 }], ["files.drive.space.search", { q: "juniper", limit: 20 }]]);
  assert.deepEqual(got.sort(), ["d", "f", "m", "r", "x"]);
  await s.preview("/a/b.txt", "mac"); await s.preview("/a/c.txt", "other");
  assert.deepEqual(b.seen.slice(-2).map((x) => x.input), [{ path: "/a/b.txt", source: "mac" }, { path: "/a/c.txt" }]);
});

const base = async () => {
  const { findSource } = await import("./source.ts");
  const { recordRows } = await import("./model.ts");
  const l = await findSource(box().call, "web").load();
  const types = [{ name: "contact", label: "Contact", view: { titleField: "name" }, fields: [{ name: "name", kind: "text" }, { name: "email", kind: "email" }, { name: "ssn", kind: "sealed" }, { name: "notes", kind: "text", seal: { x: 1 } }] },
    { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text" }, { name: "stage", kind: "choice" }] }];
  const records = recordRows(types, { contact: [{ id: "c1", data: { name: "Dana Reyes", email: "dana@x.com", ssn: "123-45-6789", notes: "secret" } }], matter: [{ id: "m1", data: { title: "Reyes estate", stage: "open" } }] });
  return { ...l, records, places: [{ id: "memory", label: "Memory", href: "/u/memory" }, { id: "vault", label: "Vault", href: "/u/vault" }] };
};

test("records are searched by their title and text values, never a sealed field", { skip: !strip }, async () => {
  const b = await base();
  assert.deepEqual(b.records.map((r) => [r.id, r.title, r.person]), [["c1", "Dana Reyes", true], ["m1", "Reyes estate", false]]);
  assert.equal(b.records[0].sub, "dana@x.com");
  assert.equal(JSON.stringify(b.records).includes("123-45"), false);
  assert.equal(JSON.stringify(b.records).includes("secret"), false);
});

test("sections in the fixed order, a name match before what recall found, projects and people and records by word", { skip: !strip }, async () => {
  const { sections } = await import("./model.ts");
  const b = await base();
  const s = sections(b, "reyes", "all", { recall: [{ session: "s1", snippet: "Dana Reyes called", ts: NOW }] });
  assert.deepEqual(s.map((x) => x.key), ["chats", "people", "records"]);
  assert.equal(s[0].rows[0].snippet, "Dana Reyes called");
  assert.deepEqual(s[1].rows.map((r) => r.href), ["/u/record/c1"]);
  assert.deepEqual(s[2].rows.map((r) => r.title), ["Reyes estate"]);
  const s2 = sections(b, "juniper", "all", {});
  assert.deepEqual(s2.map((x) => x.key), ["chats", "projects"]);
  assert.deepEqual(s2[0].rows.map((r) => r.session), ["s1"]);
  assert.equal(s2[1].rows[0].href, "/u/project/juniper");
  const s3 = sections(b, "mem", "all", {});
  assert.deepEqual(s3.map((x) => x.key), ["places"]);
  assert.equal(s3[0].rows[0].href, "/u/memory");
  assert.deepEqual(sections(b, "", "all", {}), []);
  const s4 = sections(b, "kit", "all", {});
  assert.deepEqual(s4.find((x) => x.key === "people")?.rows.map((r) => [r.title, r.sub]), [["kit", "Reviews contracts"]]);
});

test("prefixes narrow the scope and are stripped: p projects, t chats, u people", { skip: !strip }, async () => {
  const { sections, queryOf } = await import("./model.ts");
  const b = await base();
  assert.deepEqual(queryOf("p juniper", "all"), { scope: "projects", q: "juniper" });
  assert.deepEqual(queryOf("t juniper", "all"), { scope: "chats", q: "juniper" });
  assert.deepEqual(queryOf("u kit", "all"), { scope: "people", q: "kit" });
  assert.deepEqual(queryOf("park", "all"), { scope: "all", q: "park" });
  assert.deepEqual(queryOf("juniper", "files"), { scope: "files", q: "juniper" });
  assert.deepEqual(sections(b, "p juniper", "all", {}).map((x) => x.key), ["projects"]);
  assert.deepEqual(sections(b, "u reyes", "all", {}).map((x) => x.key), ["people"]);
  assert.deepEqual(sections(b, "reyes", "projects", {}).map((x) => x.key), []);
});

test("files: results with where they are, a note for a machine that did not answer, the Mac note unless it answered; nothing until the tool answers", { skip: !strip }, async () => {
  const { sections, fileHits } = await import("./model.ts");
  const b = await base();
  const d = { results: [{ name: "plan.md", path: "/Users/x/work/site/docs/plan.md", kind: "text", source: "box" }, { path: "/Users/x/a/b/c/d/e.txt", name: "e.txt", source: "mac" }, { name: "nopath" }], sources: [{ source: "box", ok: true }, { source: "mac", ok: false, error: "asleep" }] };
  const f = fileHits(d);
  assert.deepEqual(f.rows.map((r) => [r.title, r.sub, r.right]), [["plan.md", "…/site/docs", "box"], ["e.txt", "…/c/d", "mac"]]);
  assert.deepEqual(f.notes, ["The Mac did not answer: asleep"]);
  assert.deepEqual(fileHits({ results: [], sources: [] }).notes, ["Files on your Mac are not searched from here."]);
  assert.deepEqual(sections(b, "plan", "all", {}).map((x) => x.key), []);
  assert.deepEqual(sections(b, "plan", "files", { files: d }).map((x) => x.key), ["files"]);
  assert.deepEqual(sections(b, "zzz", "files", { files: { results: [], sources: [] } }).map((x) => x.key), []);
});

test("memory facts: only ones with text; a tap goes to Memory", { skip: !strip }, async () => {
  const { factHits, sections } = await import("./model.ts");
  const b = await base();
  const rows = factHits([{ text: "Dana prefers email", ref: { name: "Intake call" } }, { text: "" }, { x: 1 }, { text: "Kit owns intake", source: "flows" }]);
  assert.deepEqual(rows.map((r) => [r.title, r.sub, r.href]), [["Dana prefers email", "Intake call", "/u/memory"], ["Kit owns intake", "flows", "/u/memory"]]);
  assert.deepEqual(sections(b, "dana", "memory", { memory: [{ text: "Dana prefers email" }] }).map((x) => x.key), ["memory"]);
});

test("idle: the last searches (one of each, newest first, at most 8), recent chats, the places", { skip: !strip }, async () => {
  const { addRecent, idle } = await import("./model.ts");
  let l = [];
  for (const q of ["a", "dana", "juniper", "Dana", "x"]) l = addRecent(l, q);
  assert.deepEqual(l, ["Dana", "juniper"]);
  for (let i = 0; i < 12; i++) l = addRecent(l, `query ${i}`);
  assert.equal(l.length, 8);
  assert.equal(l[0], "query 11");
  const b = await base();
  const i = idle(b, l);
  assert.equal(i.recents.length, 8);
  assert.deepEqual(i.chats.map((c) => c.session).sort(), ["s1", "s3"]);
  assert.deepEqual(i.places.map((p) => p.href), ["/u/memory", "/u/vault"]);
});

test("commands: @agent asks it, tell types then watches, watch watches, anything else asks the assistant; the plan line says which", { skip: !strip }, async () => {
  const { readCommand, planLine, doneLine } = await import("./model.ts");
  const b = await base();
  const a = readCommand("@kit review the lease", b, null);
  assert.deepEqual(a.cmd, { kind: "agent", agent: "kit", text: "review the lease" });
  assert.equal(planLine(a.cmd, "", "juno"), "Enter asks kit.");
  const d = readCommand("tell juniper intake to call dana", b, null);
  assert.equal(d.cmd.kind, "drive");
  assert.equal(d.chosen?.id, "s1");
  assert.equal(planLine(d.cmd, "Juniper intake call", "juno"), "Enter types into Juniper intake call, then watches it.");
  assert.equal(readCommand("tell juniper intake to call dana", b, "s3").chosen?.id, "s1");
  const w = readCommand("tell me when probate checklist is done", b, null);
  assert.equal(w.cmd.kind, "watch");
  assert.equal(w.chosen?.id, "s3");
  assert.equal(doneLine(w.cmd, "Probate checklist"), "Watching Probate checklist. You will hear when it is done.");
  assert.equal(readCommand("what is the status", b, null).cmd.kind, "ask");
  assert.equal(planLine(readCommand("what is the status", b, null).cmd, "", "juno"), "Enter asks juno.");
  assert.equal(doneLine(a.cmd, ""), "Sent to kit.");
  assert.equal(doneLine(d.cmd, "Juniper intake call"), "Sent to Juniper intake call. You will hear when it finishes or asks.");
});

test("running a command: ask goes to the agent without waiting, drive sends then watches, a busy keyboard sends nothing", { skip: !strip }, async () => {
  const { findSource } = await import("./source.ts");
  const b = box();
  const s = findSource(b.call, "web");
  assert.deepEqual(await s.ask("kit", "review the lease"), { thread: "t9", note: "" });
  assert.deepEqual(b.seen[0], { tool: "agents.ask", input: { agent: "kit", text: "review the lease", surface: "web", wait: false } });
  const drive = { kind: /** @type {const} */ ("drive"), query: "x", text: "call dana", candidates: [] };
  assert.deepEqual(await s.run(drive, { id: "s1" }, "Juniper intake"), { done: true, note: "" });
  assert.deepEqual(b.seen.slice(1).map((x) => [x.tool, x.input]), [["threads.send", { thread: "s1", text: "call dana", surface: "web" }], ["threads.watch", { thread: "s1", until: "either", notify: "web", note: "Tell Juniper intake: call dana" }]]);
  const busy = findSource(box({ send: { sent: false, note: "Your phone has the keyboard." } }).call, "web");
  assert.deepEqual(await busy.run(drive, { id: "s1" }, "Juniper intake"), { done: false, note: "Your phone has the keyboard." });
  const watch = { kind: /** @type {const} */ ("watch"), query: "x", until: /** @type {const} */ ("asks"), candidates: [] };
  const w = box();
  await findSource(w.call, "web").run(watch, { id: "s3" }, "Probate");
  assert.deepEqual(w.seen.map((x) => [x.tool, x.input]), [["threads.watch", { thread: "s3", until: "asks", notify: "web", note: "Watch Probate" }]]);
});

test("a file preview: an image from base64 with a checked type, text with its truncation, else why not", { skip: !strip }, async () => {
  const { previewOf } = await import("./model.ts");
  assert.deepEqual(previewOf({ kind: "image" }, { kind: "image", base64: "AAAA", mime: "image/jpeg" }), { kind: "image", uri: "data:image/jpeg;base64,AAAA" });
  assert.deepEqual(previewOf({ kind: "image" }, { kind: "image", base64: "AAAA", mime: "text/html;x" }), { kind: "image", uri: "data:image/png;base64,AAAA" });
  assert.deepEqual(previewOf({ kind: "text" }, { text: "hi", truncated: true }), { kind: "text", text: "hi", truncated: true });
  assert.deepEqual(previewOf({ kind: "pdf" }, {}), { kind: "none", note: "No preview for this kind of file." });
  assert.deepEqual(previewOf({ kind: "other" }, { note: "too big" }), { kind: "none", note: "No preview: too big." });
  assert.deepEqual(previewOf({ kind: "other" }, null), { kind: "none", note: "No preview for this file." });
});

test("words: ago, short folders, missing tool", { skip: !strip }, async () => {
  const { ago, shortDir, missingNote, hasAll, words } = await import("./model.ts");
  assert.deepEqual([ago(NOW - 30_000, NOW), ago(NOW - 5 * 60_000, NOW), ago(NOW - 3 * 3600_000, NOW), ago(NOW - 30 * 3600_000, NOW), ago(NOW - 5 * 86400_000, NOW)], ["just now", "5 min ago", "3 h ago", "yesterday", "5 days ago"]);
  assert.equal(shortDir("/Users/x/work/site/app/page.tsx"), "…/site/app");
  assert.equal(shortDir("/Users/x/work/page.tsx"), "~/work");
  assert.equal(shortDir("/etc/hosts"), "/etc");
  assert.equal(missingNote({ code: "no_such_tool" }), "That is not available on your server yet.");
  assert.equal(missingNote({ message: "Nope" }), "Nope");
  assert.equal(hasAll("Juniper Studio", words("studio junip")), true);
  assert.equal(hasAll("Juniper", words("legal")), false);
});

test("mentions: vault names, Drive, artifacts and GitHub as their own sections; records and sessions left to Find; a late provider is named", { skip: !strip }, async () => {
  const { mentionSections, sections, mentionRoute } = await import("./model.ts");
  const b = await base();
  const d = { groups: [{ kind: "record", label: "Records", items: [{ id: "r1", name: "dup" }] }, { kind: "session", label: "Sessions", items: [{ id: "s1", name: "dup" }] },
    { kind: "vault", label: "Vault", items: [{ id: "v1", name: "Gmail", hint: "login" }, { name: "no id" }] }, { kind: "github", label: "GitHub", items: [{ id: "g1", name: "acme/site", hint: "repo" }] }, { kind: "drive", label: "Drive", items: [] }], unavailable: ["artifacts", 3] };
  const m = mentionSections(d);
  assert.deepEqual(m.sections.map((x) => [x.key, x.rows.map((r) => [r.title, r.sub, r.href])]), [["m:vault", [["Gmail", "login", "/u/vault"]]], ["m:github", [["acme/site", "repo", undefined]]]]);
  assert.equal(m.note, "artifacts did not answer in time.");
  assert.equal(mentionRoute("drive"), "/u/drive");
  assert.equal(mentionRoute("github"), null);
  assert.deepEqual(mentionSections(null), { sections: [], note: "" });
  assert.deepEqual(sections(b, "gmail", "all", { mentions: d }).map((x) => x.key), ["m:vault", "m:github"]);
  assert.deepEqual(sections(b, "gmail", "chats", { mentions: d }).map((x) => x.key), []);
  assert.deepEqual(sections(b, "gmail", "all", {}).map((x) => x.key), []);
});

test("arrow keys: rows in drawn order (a section's first five unless open, else the idle list), Down from nothing is the first, Up from the first is the box", { skip: !strip }, async () => {
  const { flatRows, stepHi } = await import("./model.ts");
  const rows = (/** @type {string} */ p, /** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ key: `${p}${i}`, title: `${p}${i}`, kind: "chat" }));
  const secs = [{ key: "a", label: "A", rows: rows("a", 7) }, { key: "b", label: "B", rows: rows("b", 2) }];
  assert.deepEqual(flatRows(secs, {}).map((r) => r.key), ["a0", "a1", "a2", "a3", "a4", "b0", "b1"]);
  assert.equal(flatRows(secs, { a: true }).length, 9);
  assert.deepEqual(flatRows([], {}, rows("i", 2)).map((r) => r.key), ["i0", "i1"]);
  assert.deepEqual([stepHi(-1, "ArrowDown", 3), stepHi(0, "ArrowDown", 3), stepHi(2, "ArrowDown", 3), stepHi(0, "ArrowUp", 3), stepHi(2, "ArrowUp", 3), stepHi(-1, "ArrowDown", 0)], [0, 1, 2, -1, 1, -1]);
});

test("Drive file names: a chat's file opens its chat and says so; a Drive file opens the Drive; nothing is shown until the tool answers or when it has nothing", { skip: !strip }, async () => {
  const { driveHits, sections } = await import("./model.ts");
  const b = await base();
  const d = { results: [{ path: "Clients/A/retainer.txt", name: "retainer.txt", size: 3 }, { path: "Projects/p1/chat/chat_abc1234/notes.txt", name: "notes.txt", chat: "chat_abc1234" }, { name: "no path" }] };
  assert.deepEqual(driveHits(d).map((r) => [r.title, r.sub, r.href]), [["retainer.txt", "Clients/A", "/u/drive"], ["notes.txt", "In a chat you are in, …/chat/chat_abc1234", "/u/chats/chat_abc1234"]]);
  assert.deepEqual(sections(b, "retainer", "all", {}).map((x) => x.key), []);
  assert.deepEqual(sections(b, "retainer", "all", { drive: d }).map((x) => x.key), ["drive"]);
  assert.deepEqual(sections(b, "retainer", "chats", { drive: d }).map((x) => x.key), [], "only in the all and files scopes");
  assert.deepEqual(sections(b, "retainer", "files", { drive: { results: [] } }).map((x) => x.key), []);
  assert.deepEqual(driveHits(null), []);
});
