// @ts-check
// The 0.2.9 docs rulings, kept true by a test (lead, 5 Oct 2026): spaces are Personal, My Cloud and Cloud, never "Basic" or "Pro" in anything people read; private chats and their file names are
// encrypted to the people in the chat; times follow the person's zone and the space's; replies are quoted in the same timeline.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(REPO, f), "utf8");
const EXEMPT = /^docs\/(adr|design|work|proposals|releases|reference)\//;

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out); else if (e.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

test("no 'Basic' or 'Pro' tier name in the docs or on the site", () => {
  const files = [...walk("docs", []).filter(f => !EXEMPT.test(f)), "scripts/gen-site.mjs"];
  const hits = [];
  for (const f of files) read(f).split("\n").forEach((l, i) => { if (/\b(Basic|Pro)\b/.test(l.replace(/MacBook Pro/g, ""))) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 80)}`); });
  assert.deepEqual(hits, [], "the names are Personal, My Cloud and Cloud");
});

test("the spaces page names Personal, My Cloud and Cloud and what each keeps", () => {
  const t = read("docs/using/spaces.md");
  for (const w of ["**Personal**", "**My Cloud**", "**Cloud**", "Set up My Cloud", "This needs a Cloud space", "Backed up, encrypted, to"]) assert.ok(t.includes(w), w);
});

test("the private chats page says chats, files and file names are encrypted to the people in the chat", () => {
  const t = read("docs/using/private-chats.md");
  assert.match(t, /encrypted to the people in that chat/);
  assert.match(t, /owners and admins cannot read chats they are not in/);
  assert.match(t, /File names are encrypted too/);
  assert.match(t, /server's operator could see that chat in use/);
});

test("the time zones page covers the person's zone, the space's home zone and daylight saving", () => {
  const t = read("docs/using/time-zones.md");
  for (const w of ["Your zone", "Home time zone", "9:00 am PT · 9:00 pm your time", "UTC", "spring-forward"]) assert.ok(t.includes(w), w);
});

test("the chat page explains quoted replies", () => {
  const t = read("docs/using/chat.md");
  assert.match(t, /## Reply to a message/);
  assert.match(t, /same timeline/);
  assert.match(t, /never makes a side thread/);
});

test("the new pages are in the docs navigation", () => {
  const nav = JSON.parse(read("docs/nav.json"));
  const pages = nav.sections.flatMap((/** @type {any} */ s) => s.pages);
  for (const p of ["using/spaces.md", "using/private-chats.md", "using/time-zones.md"]) assert.ok(pages.includes(p), p);
});

test("the sample world is not a law firm: no Harlow in the docs, the README or the site", () => {
  const files = [...walk("docs", []).filter(f => !EXEMPT.test(f)), "README.md", "scripts/gen-site.mjs"];
  const hits = [];
  for (const f of files) read(f).split("\n").forEach((l, i) => { if (/harlow/i.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 80)}`); });
  assert.deepEqual(hits, [], "use a neutral example space, such as Juniper Studio and juniper.vyre.run");
  for (const f of fs.readdirSync(path.join(REPO, "site"), { recursive: true }).map(String).filter(f => /\.(html|txt|md)$/.test(f) && !/^(box|setup)\//.test(f) && !/CHANGELOG/.test(f))) assert.ok(!/harlow/i.test(read(`site/${f}`)), `site/${f}`);
});
