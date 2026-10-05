// @ts-check
// Find: the prefix, the sections, the notes and the preview, as pure functions.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const base = {
  sessions: [{ id: "s1", name: "Dana Wine intake", project: "dana", cwd: "/w/dana", last: 1 }, { id: "s2", name: "Tax notes", project: null, cwd: "/w/tax", last: 2 }],
  projects: [{ slug: "dana", name: "Dana Wine" }, { slug: "tax", name: "Taxes" }],
  agents: [{ name: "juno", kind: "agent", line: "Intake lead" }, { name: "kit", kind: "assistant", line: "" }],
};

test("a prefix narrows the box and strips itself; a word alone is not a prefix", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.deepEqual(m.parsePrefix("p dana"), { prefix: "p", scope: "projects", rest: "dana" });
  assert.equal(m.parsePrefix("T  hello there")?.scope, "chats");
  assert.equal(m.parsePrefix("u ")?.scope, "people");
  assert.equal(m.parsePrefix("plan"), null);
  assert.equal(m.parsePrefix("p"), null);
});

test("sessions merge by id, a thread's name wins, projects and agents read their shapes", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const s = m.sessionsOf({ sessions: [{ id: "a", name: "old", cwd: "/x" }] }, { threads: [{ id: "a", name: "new" }, { id: "b" }, {}] });
  assert.deepEqual(s.map((x) => [x.id, x.name, x.cwd]), [["a", "new", "/x"], ["b", "", ""]]);
  assert.deepEqual(m.projectsOf({ projects: [{ slug: "p" }, {}] }), [{ slug: "p", name: "p" }]);
  assert.deepEqual(m.agentsOf([{ name: "k", instructions: "line1\nline2" }]), [{ name: "k", kind: "agent", line: "line1" }]);
});

test("sections: names and said words join once, in the Deck's order; under two letters shows nothing", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.deepEqual(m.sectionsFor("d", base, { missing: [] }), []);
  const found = { missing: [], chats: [{ session: "s1", name: "x", snippet: "talked about dana", ts: null, cwd: "" }, { session: "s9", name: "Other", snippet: "dana again", ts: null, cwd: "/o" }],
    files: { results: [{ name: "dana.md", path: "/Users/me/work/dana.md", kind: "text", source: /** @type {const} */ ("box"), size: 4, mtime: null, repo: "" }], notes: [] }, memory: [{ text: "Dana prefers email", source: "Mail" }] };
  const all = m.sectionsFor("dana", base, found);
  assert.deepEqual(all.map((s) => s.id), ["chats", "files", "memory", "projects"]);
  assert.deepEqual(all[0].rows.map((r) => r.key), ["c:s1", "c:s9"]);
  assert.equal(all[0].rows[0].kind === "chat" && all[0].rows[0].href, "/session/s1");
  assert.equal(all[3].rows[0].kind === "project" && all[3].rows[0].href, "/u/project/dana");
  assert.deepEqual(m.sectionsFor("u intake", base, found).map((s) => s.id), ["people"]);
  assert.deepEqual(m.sectionsFor("p dana", base, found).map((s) => s.id), ["projects"]);
  assert.deepEqual(m.sectionsFor("dana", base, found, "files").map((s) => s.id), ["files"]);
  assert.equal(m.sectionsFor("dana", base, found, "files")[0].rows[0].sub, "~/work · Box");
});

test("notes name only what could not be searched; recent searches are newest first, no repeats, eight", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.deepEqual(m.missingNotes({}), []);
  assert.deepEqual(m.missingNotes({ files: "x", memory: "y" }), ["Files were not searched.", "Memory was not searched."]);
  let r = /** @type {string[]} */ ([]);
  for (const q of ["a1", "b2", "A1", "x", "c3"]) r = m.remember(r, q);
  assert.deepEqual(r, ["c3", "A1", "b2"]);
  for (let i = 0; i < 12; i++) r = m.remember(r, "q" + i);
  assert.equal(r.length, 8);
});

test("preview: text cut long, an image only as a checked data URI, otherwise a plain note", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.equal(m.previewOf({ text: "hi" }).kind, "text");
  assert.ok(/** @type {any} */ (m.previewOf({ text: "x".repeat(30000) })).text.length < 20002);
  assert.equal(/** @type {any} */ (m.previewOf({ kind: "image", mime: "image/jpeg", base64: "AAAA" })).uri, "data:image/jpeg;base64,AAAA");
  assert.equal(/** @type {any} */ (m.previewOf({ kind: "image", mime: "text/html", base64: "AAAA" })).uri, "data:image/png;base64,AAAA");
  assert.equal(m.previewOf({}).kind, "none");
  assert.equal(m.sizeWords(2048), "2 KB");
  assert.equal(m.sizeWords(null), "");
});
