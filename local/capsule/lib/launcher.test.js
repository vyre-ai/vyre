// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Apps, Frecency } from "./local.js";
import { Launcher, defineWord, SEND_TIMEOUT } from "./launcher.js";
import { rank, intent, questionLike } from "./route.js";
import { SCRATCH } from "../../../test/scratch.mjs";

function appsIn(t, names) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-apps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const n of names) fs.mkdirSync(path.join(dir, n + ".app"));
  return new Apps({ dirs: [dir] });
}

const cat = { agents: [{ name: "juno", kind: "assistant" }], projects: [{ slug: "harlow", name: "Harlow Legal", threads: 3, last: 1 }], threads: [] };

function fakeHelper(status, contacts = []) {
  const calls = [];
  return { calls, status: async () => (calls.push("status"), { status }), define: async w => (calls.push("define:" + w), { word: w, definition: w === "serendipity" ? "serendipity | ˌserənˈdipədē | noun the occurrence of events by chance in a happy way." : null }),
    contacts: async q => (calls.push("contacts:" + q), status === "notDetermined" ? { error: "asking", status } : { contacts: contacts.filter(c => c.name.toLowerCase().includes(q.toLowerCase())) }), close() {} };
}

test("route: one ranked list, where a strong local name outranks a weak Vyre match and a sum comes first", () => {
  const local = [{ kind: "app", id: "app:/A/Safari.app", label: "Safari", sub: "", last: 0, target: "/A/Safari.app", score: 0.9 }];
  const r = rank("sa", { local, cat });
  assert.equal(r[0].label, "Safari");
  const h = rank("harlow", { local: [], cat });
  assert.equal(h[0].kind, "project");
  const c = rank("2+2", { local, extra: [{ kind: "calc", id: "calc:2+2", label: "4", sub: "2 + 2", score: 2 }], cat });
  assert.equal(c[0].kind, "calc");
  assert.deepEqual(rank("", { local, cat }), []);
});

test("route: a question goes to the assistant even when an app matches; a name opens", () => {
  const top = [{ kind: "app", id: "a", label: "Notes", sub: "", score: 0.9 }];
  assert.equal(intent("notes", top), "open");
  assert.equal(intent("what notes did Dana send?", top), "ask");
  assert.equal(intent("no", [{ kind: "file", id: "f", label: "piano.txt", sub: "", score: 0.3 }]), "ask", "a weak match does not open");
  assert.equal(intent("anything", []), "ask");
  assert.ok(questionLike("how do I rotate the keys"));
  assert.ok(!questionLike("safari"));
});

test("launcher: apps, settings and the calculator answer offline, ranked", async t => {
  const l = new Launcher({ apps: appsIn(t, ["Safari", "Slack", "Notes"]), files: async () => [] });
  await l.warm();
  const a = await l.quick("saf", null);
  assert.equal(a.results[0].label, "Safari");
  assert.equal(a.intent, "open");
  const w = await l.quick("wifi", null);
  assert.equal(w.results[0].kind, "setting");
  const c = await l.quick("12 * 3.5", null);
  assert.equal(c.results[0].kind, "calc");
  assert.equal(c.results[0].label, "42");
  assert.equal(c.intent, "open");
});

test("launcher: frecency lifts what the user picks, from a file under the Capsule's own home", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-frec-"));
  const frecency = new Frecency(path.join(dir, "frecency.json"));
  // pick() saves on a 500 ms debounce; write it now, or the timer fires after the rm and makes the folder again.
  t.after(() => { frecency.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const opened = [];
  const l = new Launcher({ apps: appsIn(t, ["Notes", "Notability"]), frecency,
    open: async r => (opened.push(r.target), { ok: true }), files: async () => [] });
  await l.warm();
  const before = await l.quick("not", null);
  assert.equal(before.results[0].label, "Notes", "shorter label first on a tie");
  const nb = before.results.find(r => r.label === "Notability");
  for (let i = 0; i < 3; i++) assert.deepEqual(await l.pick(/** @type {any} */ (nb), "not"), { ok: true, close: true });
  const after = await l.quick("not", null);
  assert.equal(after.results[0].label, "Notability");
  assert.equal(opened.length, 3);
});

test("launcher: files arrive in full(), and a newer query cancels the older mdfind", async t => {
  let aborted = 0;
  const files = (q, { signal }) => new Promise(res => {
    signal.addEventListener("abort", () => { aborted++; res([]); });
    setTimeout(() => res([{ kind: "file", id: "file:/h/" + q + ".md", label: q + ".md", sub: "~", last: 1, target: "/h/" + q + ".md" }]), 20);
  });
  const l = new Launcher({ apps: appsIn(t, []), files });
  const first = l.full("budget", null);
  const second = await l.full("budgets", null);
  assert.equal(await first, null, "the older answer is dropped");
  assert.equal(aborted, 1);
  assert.equal(second?.results[0].label, "budgets.md");
});

test("launcher: contacts never ask from typing; picking the offer is what asks", async t => {
  const h = fakeHelper("notDetermined");
  const l = new Launcher({ apps: appsIn(t, []), helper: h, files: async () => [] });
  await l.warm();
  const r = await l.quick("dana", null);
  assert.deepEqual(r.results.map(x => x.kind), ["grant"]);
  assert.ok(!h.calls.some(c => c.startsWith("contacts:")), "typing did not ask macOS");
  const p = await l.pick(r.results[0], "dana");
  assert.match(String(p.note), /macOS is asking/);
  assert.ok(h.calls.includes("contacts:"));

  const ok = fakeHelper("authorized", [{ id: "A1:ABPerson", name: "Dana Reyes", org: "Harlow", emails: [], phones: [] }]);
  const l2 = new Launcher({ apps: appsIn(t, []), helper: ok, files: async () => [] });
  await l2.warm();
  const found = await l2.quick("dana", null);
  assert.equal(found.results[0].label, "Dana Reyes");
  assert.equal(found.results[0].target, "addressbook://A1:ABPerson");
  assert.deepEqual((await l2.quick("12 + 4", null)).results.filter(x => x.kind === "contact"), [], "sums are not names");

  const no = fakeHelper("denied");
  const l3 = new Launcher({ apps: appsIn(t, []), helper: no, files: async () => [] });
  await l3.warm();
  assert.deepEqual((await l3.quick("dana", null)).results, []);
});

test("launcher: define looks a word up only when asked to", async t => {
  assert.equal(defineWord("define serendipity"), "serendipity");
  assert.equal(defineWord("serendipity meaning"), "serendipity");
  assert.equal(defineWord("what does serendipity mean?"), "serendipity");
  assert.equal(defineWord("serendipity"), null);
  const h = fakeHelper("denied");
  const l = new Launcher({ apps: appsIn(t, []), helper: h, files: async () => [] });
  const r = await l.quick("define serendipity", null);
  assert.equal(r.results[0].kind, "define");
  assert.match(r.results[0].sub, /by chance/);
});

test("launcher: pick opens only what it made, and copies a sum", async t => {
  const ran = [], copied = [];
  const l = new Launcher({ apps: appsIn(t, []), files: async () => [], run: /** @type {any} */ ((f, a, cb) => { ran.push([f, ...a]); cb(null); }), copy: s => copied.push(s) });
  assert.deepEqual(await l.pick({ kind: "calc", id: "calc:x", label: "1,000", copy: "1000", sub: "" }, "x"), { ok: true, note: "Copied 1000", close: true });
  assert.deepEqual(copied, ["1000"]);
  assert.deepEqual(await l.pick({ kind: "define", id: "define:x", label: "x", sub: "", target: "dict://serendipity" }, "x"), { ok: true, close: true });
  assert.deepEqual(ran, [["/usr/bin/open", "dict://serendipity"]]);
  assert.ok((await l.pick({ kind: "contact", id: "c", label: "x", sub: "", target: "addressbook://x --args" }, "x")).error);
  assert.ok((await l.pick({ kind: "define", id: "d", label: "x", sub: "", target: "https://example.com" }, "x")).error);
  assert.equal(ran.length, 1);
});

/** A fake vyred: `answers[tool]` is a value or (input) => value, each after `delay[tool]` ms. */
function fakeVyred(answers, delay = {}) {
  const calls = [];
  const fn = (tool, input, opts) => {
    calls.push(opts ? [tool, input, opts] : [tool, input]);
    const a = answers[tool];
    const v = typeof a === "function" ? a(input) : a ?? { error: { code: "unknown_tool", message: tool } };
    return new Promise(res => setTimeout(() => res(v), delay[tool] || 0));
  };
  return { fn, calls };
}
const LINKED = { data: { linked: true, box: { address: "10.0.0.2", name: "studio" }, reachable: true } };
const boxRows = n => ({ data: { results: Array.from({ length: n }, (_, i) => ({ source: "box", path: `/home/me/docs/budget ${i}.pdf`, name: `budget ${i}.pdf`,
  kind: "file", size: 10, mtime: "2026-09-20T10:00:00Z" })).concat([{ source: "mac", path: "/Users/x/budget.pdf", name: "budget.pdf", kind: "file", size: 1, mtime: "" },
  { source: "box", path: "/home/me/p/node_modules/budget/index.js", name: "index.js", kind: "file", size: 1, mtime: "" }]),
  sources: [{ source: "box", ok: true, count: n }] } });

test("launcher: box files join full(), never quick(), mapped and capped at three", async t => {
  const v = fakeVyred({ "link.status": LINKED, "files.search": boxRows(5) });
  // mdfind takes a few hundred ms; the box, on a LAN, usually less.
  const l = new Launcher({ apps: appsIn(t, []), files: () => new Promise(res => setTimeout(() => res([]), 300)), vyred: v.fn });
  await l.quick("budget", null);
  assert.equal(v.calls.length, 0, "the keystroke path never asks the box");
  const r = await l.full("budget", null);
  const box = r?.results.filter(x => x.kind === "boxfile") || [];
  assert.equal(box.length, 3);
  assert.deepEqual(box[0], { kind: "boxfile", id: "box:/home/me/docs/budget 0.pdf", label: "budget 0.pdf", sub: "studio · ~/docs",
    last: Date.parse("2026-09-20T10:00:00Z"), target: "/home/me/docs/budget 0.pdf", source: "box", fileKind: "file", score: box[0].score });
  assert.deepEqual(v.calls.find(c => c[0] === "files.search")?.[1], { q: "budget", where: "box", limit: 20 });
  await l.full("budgets", null);
  assert.equal(v.calls.filter(c => c[0] === "link.status").length, 1, "link.status is remembered");
});

test("launcher: a slow box never holds up this Mac's files; late rows come through onMore", async t => {
  const v = fakeVyred({ "link.status": LINKED, "files.search": boxRows(2) }, { "files.search": 150 });
  const mac = [{ kind: "file", id: "file:/h/budget.md", label: "budget.md", sub: "~", last: 1, target: "/h/budget.md" }];
  const l = new Launcher({ apps: appsIn(t, []), files: async () => mac, vyred: v.fn });
  const more = [];
  const t0 = Date.now();
  const r = await l.full("budget", null, m => more.push(m));
  assert.ok(Date.now() - t0 < 120, "answered before the box");
  assert.deepEqual(r?.results.map(x => x.kind), ["file"]);
  await new Promise(res => setTimeout(res, 250));
  assert.equal(more.length, 1);
  assert.equal(more[0].results.filter(x => x.kind === "boxfile").length, 2);

  const slow = fakeVyred({ "link.status": LINKED, "files.search": boxRows(2) }, { "files.search": 400 });
  const l2 = new Launcher({ apps: appsIn(t, []), files: async () => mac, vyred: slow.fn, boxTimeoutMs: 50 });
  const late = [];
  await l2.full("budget", null, m => late.push(m));
  await new Promise(res => setTimeout(res, 450));
  assert.deepEqual(late, [], "past its timeout the box is dropped");
});

test("launcher: no box work while hidden, unlinked, or with vyred down", async t => {
  const hidden = fakeVyred({ "link.status": LINKED, "files.search": boxRows(2) });
  const l = new Launcher({ apps: appsIn(t, []), files: async () => [], vyred: hidden.fn, visible: () => false });
  await l.full("budget", null);
  assert.equal(hidden.calls.length, 0);
  const unlinked = fakeVyred({ "link.status": { data: { linked: false, box: null, reachable: false } }, "files.search": boxRows(2) });
  const l2 = new Launcher({ apps: appsIn(t, []), files: async () => [], vyred: unlinked.fn });
  assert.equal((await l2.full("budget", null))?.results.length, 0);
  assert.deepEqual(unlinked.calls.map(c => c[0]), ["link.status"]);
  const down = new Launcher({ apps: appsIn(t, []), files: async () => [], vyred: async () => { throw new Error("socket gone"); } });
  assert.deepEqual((await down.full("budget", null))?.results, []);
});

test("launcher: picking a box file fetches it, then opens the local copy", async t => {
  const opened = [];
  const v = fakeVyred({ "link.status": LINKED, "files.fetch": { data: { local: "/Users/x/.vyre/files/fetched/budget 0.pdf" } } });
  const l = new Launcher({ apps: appsIn(t, []), files: async () => [], vyred: v.fn, boxName: "studio", open: async r => (opened.push(r.target), { ok: true }) });
  const row = { kind: "boxfile", id: "box:/home/me/docs/budget 0.pdf", label: "budget 0.pdf", sub: "", last: 0, target: "/home/me/docs/budget 0.pdf", source: "box" };
  assert.deepEqual(await l.pick(row, "bud"), { ok: true, close: true, note: "Fetched from studio." });
  assert.deepEqual(v.calls.at(-1), ["files.fetch", { path: "/home/me/docs/budget 0.pdf", source: "box" }]);
  assert.deepEqual(opened, ["/Users/x/.vyre/files/fetched/budget 0.pdf"]);
  const off = new Launcher({ apps: appsIn(t, []), files: async () => [], vyred: fakeVyred({ "files.fetch": { error: { code: "unreachable", message: "box did not answer" } } }).fn });
  assert.deepEqual(await off.pick(row, "bud"), { error: "The box is not reachable right now." });
  const gone = new Launcher({ apps: appsIn(t, []), files: async () => [], boxName: "studio", vyred: fakeVyred({ "files.fetch": { error: { code: "not_found", message: "no such file" } } }).fn });
  assert.deepEqual(await gone.pick(row, "bud"), { error: "Could not fetch it from studio: no such file." });
});

test("launcher: a box file inside a mounted VyreDrive share opens there, without fetching", async t => {
  const opened = [];
  const v = fakeVyred({ "files.drive.local": { data: { local: "/Users/x/Vyre/Box/projects/docs/budget 0.pdf", share: "projects" } } });
  const l = new Launcher({ apps: appsIn(t, []), files: async () => [], vyred: v.fn, boxName: "studio", open: async r => (opened.push(r.target), { ok: true }) });
  const row = { kind: "boxfile", id: "box:/work/docs/budget 0.pdf", label: "budget 0.pdf", sub: "", last: 0, target: "/work/docs/budget 0.pdf", source: "box" };
  assert.deepEqual(await l.pick(row, "bud"), { ok: true, close: true });
  assert.deepEqual(v.calls, [["files.drive.local", { path: "/work/docs/budget 0.pdf" }]]);
  assert.deepEqual(opened, ["/Users/x/Vyre/Box/projects/docs/budget 0.pdf"]);
  // The mounted copy will not open (the share dropped): fetch as before.
  const w = fakeVyred({ "files.drive.local": { data: { local: "/Users/x/Vyre/Box/projects/a.pdf" } }, "files.fetch": { data: { local: "/Users/x/.vyre/files/fetched/a.pdf" } } });
  const tried = [];
  const l2 = new Launcher({ apps: appsIn(t, []), files: async () => [], vyred: w.fn, boxName: "studio",
    open: async r => (tried.push(r.target), r.target.includes("/Vyre/Box/") ? { error: "gone" } : { ok: true }) });
  assert.deepEqual(await l2.pick({ ...row, target: "/work/a.pdf" }, "a"), { ok: true, close: true, note: "Fetched from studio." });
  assert.deepEqual(tried, ["/Users/x/Vyre/Box/projects/a.pdf", "/Users/x/.vyre/files/fetched/a.pdf"]);
});

test("launcher: preview reads a text file's first 4 kB, asks the box for box files, else null", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-prev-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "a.txt"), "é".repeat(3000));
  fs.writeFileSync(path.join(dir, "b.bin"), Buffer.from([1, 0, 2]));
  const v = fakeVyred({ "files.preview": { data: { kind: "text", mime: "text/plain", text: "hi", truncated: false } } });
  const l = new Launcher({ apps: appsIn(t, []), files: async () => [], vyred: v.fn });
  const p = await l.preview({ kind: "file", id: "f", label: "a.txt", sub: "", target: path.join(dir, "a.txt") });
  assert.equal(p?.truncated, true);
  assert.equal(p?.text, "é".repeat(2048), "cut on a whole character");
  assert.equal(await l.preview({ kind: "file", id: "f", label: "b.bin", sub: "", target: path.join(dir, "b.bin") }), null);
  assert.equal(await l.preview({ kind: "folder", id: "d", label: "x", sub: "", target: dir }), null);
  assert.deepEqual(await l.preview({ kind: "boxfile", id: "box:/a", label: "a", sub: "", target: "/a" }), { kind: "text", mime: "text/plain", text: "hi", truncated: false });
  assert.deepEqual(v.calls, [["files.preview", { path: "/a", source: "box" }]]);
});

test("launcher: send hands a Mac file to files.send and says what vyred said", async t => {
  const v = fakeVyred({ "files.send": ({ path: p }) => p.endsWith(".env") ? { error: { code: "not_available", message: "not available" } }
    : { data: { sent: path.basename(p), bytes: 5, to: "box.tail0000.ts.net" } } });
  const l = new Launcher({ apps: appsIn(t, []), files: async () => [], vyred: v.fn });
  const file = { kind: "file", id: "file:/h/budget.md", label: "budget.md", sub: "~", last: 1, target: "/h/budget.md" };
  assert.deepEqual(await l.send(file), { ok: true, note: "Sent budget.md to box.tail0000.ts.net." });
  assert.deepEqual(v.calls.find(c => c[0] === "files.send")?.[1], { path: "/h/budget.md" });
  assert.match((await l.send({ ...file, target: "/h/.env" })).error || "", /not available/);
  assert.match((await l.send({ ...file, kind: "boxfile" })).error || "", /only a file on this Mac/);
  assert.equal(v.calls.filter(c => c[0] === "files.send").length, 2, "a box file never reaches files.send");
  assert.deepEqual(v.calls.find(c => c[0] === "files.send")?.[2], { timeout: SEND_TIMEOUT }, "a send waits as long as vyre send does");
  assert.ok(SEND_TIMEOUT > 60 * 60_000, "longer than files.send's own hour for Taildrop");
});
