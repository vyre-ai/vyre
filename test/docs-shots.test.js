// @ts-check
// The docs-check `shots` rule (scripts/lib/docs/shots.js) on fixture trees: a screenshot older
// than the code it shows, a PNG nobody recorded, a record whose PNG is gone. No Chrome here:
// scripts/docs-shots takes the pictures, on testbox; this only checks what it wrote down.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkShots, entryFor, manifestText, filesOf, shotFiles, SHOTS, MANIFEST } from "../scripts/lib/docs/shots.js";
import { check } from "../scripts/lib/docs/check.js";
import { SCRATCH } from "./scratch.mjs";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

/** A tiny repository: a view, a stylesheet, one page, one shot of the view, and its record. */
function tree(t) {
  const root = fs.mkdtempSync(path.join(SCRATCH, "docs-shots-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  put("deck/views/now.js", "export default () => 'Two things need you.';\n");
  put("web/css/deck.css", ":root { --bg: #0E0D0C; }\n");
  put("docs/nav.json", JSON.stringify({ sections: [{ title: "Using", pages: ["using/deck.md"] }], unpublished: [] }));
  put("docs/using/deck.md", "---\ntitle: Deck\nsummary: The Deck.\naudience: users\nowner: docs\nstatus: draft\n---\n# Deck\n\n![Now in the Deck](shots/deck-now.png)\n");
  put("docs/using/shots/deck-now.png", PNG);
  const m = { "docs/using/shots/deck-now.png": entryFor(root, ["deck/views/now.js", "web/css/deck.css"]) };
  put(MANIFEST, manifestText(m));
  return { root, put };
}

test("shots: a tree whose shots match their code is clean", t => {
  const { root } = tree(t);
  assert.deepEqual(checkShots({ root }), []);
});

test("shots: a shot is older than the code it shows once that file's contents change", t => {
  const { root, put } = tree(t);
  put("deck/views/now.js", "export default () => 'One thing needs you.';\n");
  const p = checkShots({ root });
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, "shots");
  assert.equal(p[0].file, "docs/using/shots/deck-now.png");
  assert.match(p[0].problem, /older than deck\/views\/now\.js; run npm run docs:shots on testbox/);
});

test("shots: only contents count, not mtimes", t => {
  const { root } = tree(t);
  const f = path.join(root, "web/css/deck.css");
  fs.utimesSync(f, new Date(2030, 0, 1), new Date(2030, 0, 1));
  assert.deepEqual(checkShots({ root }), []);
});

test("shots: a shown file that is gone fails", t => {
  const { root } = tree(t);
  fs.rmSync(path.join(root, "web/css/deck.css"));
  const p = checkShots({ root });
  assert.equal(p.length, 1);
  assert.match(p[0].problem, /shows web\/css\/deck\.css, which no longer exists/);
});

test("shots: a PNG under a shots/ folder that shots.json does not list fails", t => {
  const { root, put } = tree(t);
  put("docs/get-started/shots/onboarding-you.png", PNG);
  put("docs/using/pictures/not-a-shot.png", PNG);
  const p = checkShots({ root });
  assert.deepEqual(p.map(x => x.file), ["docs/get-started/shots/onboarding-you.png"]);
  assert.match(p[0].problem, /not in docs\/shots\.json/);
});

test("shots: a shots.json entry whose PNG is gone fails, at its line", t => {
  const { root } = tree(t);
  fs.rmSync(path.join(root, "docs/using/shots/deck-now.png"));
  const p = checkShots({ root });
  assert.equal(p.length, 1);
  assert.equal(p[0].file, MANIFEST);
  assert.equal(p[0].line, 2);
  assert.match(p[0].problem, /docs\/using\/shots\/deck-now\.png is listed but there is no such file/);
});

test("shots: unreadable shots.json is one problem, not a crash", t => {
  const { root, put } = tree(t);
  put(MANIFEST, "{ not json");
  const p = checkShots({ root });
  assert.equal(p.length, 1);
  assert.match(p[0].problem, /unreadable/);
});

test("shots: no shots.json and no shots is clean", t => {
  const { root } = tree(t);
  fs.rmSync(path.join(root, MANIFEST));
  fs.rmSync(path.join(root, "docs/using/shots"), { recursive: true });
  assert.deepEqual(checkShots({ root }), []);
});

test("shots: docs-check runs the rule, as kind shots", async t => {
  const { root, put } = tree(t);
  assert.deepEqual((await check({ root, reference: false })).filter(p => p.kind === "shots"), []);
  put("deck/views/now.js", "changed\n");
  const p = (await check({ root, reference: false })).filter(p => p.kind === "shots");
  assert.equal(p.length, 1);
  assert.match(p[0].problem, /older than deck\/views\/now\.js/);
});

test("shots: the record is deterministic and hashes contents", t => {
  const { root } = tree(t);
  const a = entryFor(root, ["deck/views/now.js", "web/css/deck.css"]);
  const b = entryFor(root, ["web/css/deck.css", "deck/views/now.js", "web/css/deck.css"]);
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a.shows), ["deck/views/now.js", "web/css/deck.css"]);
  const text = manifestText({ "docs/z.png": a, "docs/a.png": b });
  assert.ok(text.indexOf("docs/a.png") < text.indexOf("docs/z.png"));
  assert.equal(text, manifestText(JSON.parse(text)));
  assert.throws(() => entryFor(root, ["deck/views/missing.js"]), /does not exist/);
});

test("shots: the shot list names real files, sensible places and one file per theme", () => {
  const names = new Set();
  for (const s of SHOTS) {
    assert.ok(!names.has(s.name), `${s.name} is listed twice`);
    names.add(s.name);
    assert.ok(s.alt && s.page && s.heading, `${s.name} has alt, page and heading`);
    assert.ok(["deck", "onboard", "fresh", "glass", "app"].includes(s.world), `${s.name}: world ${s.world}`);
    const files = filesOf(s);
    assert.equal(files.length, s.themes.length);
    assert.ok(files.every(f => f.startsWith(`docs/${s.dir}/shots/${s.name}`)));
    if (s.themes.length === 2) assert.deepEqual(files.map(f => path.basename(f)), [`${s.name}.png`, `${s.name}.dark.png`]);
    // A shot may show a file from a branch not merged yet only if it waits for it (needs).
    for (const f of s.shows) if (!(s.needs || []).includes(f)) assert.ok(fs.existsSync(path.resolve(import.meta.dirname, "..", f)), `${s.name} shows ${f}, which is not in the repo`);
  }
  assert.deepEqual(shotFiles(path.join(SCRATCH, "no-such-tree")), []);
});
