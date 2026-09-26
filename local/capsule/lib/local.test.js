// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { Apps, files, mdQuery, noise, settings, match, Frecency, open, tilde, PANES, taste, filenameLike, mdLine } from "./local.js";

const DAY = 86_400_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vyre-local-"));

/** A fake spawn: records its args and streams `lines` as mdfind would, one chunk each. */
function fakeRun(lines, { hang = false } = {}) {
  const calls = [];
  const run = (file, args) => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; child.stdout.end(); setImmediate(() => child.emit("close", null)); };
    calls.push({ file, args, child });
    setImmediate(() => {
      for (const l of lines) if (!child.killed) child.stdout.write(l + "\n");
      if (!hang && !child.killed) { child.stdout.end(); child.emit("close", 0); }
    });
    return child;
  };
  return { run: /** @type {any} */ (run), calls };
}
const fakeStat = dirs => async p => ({ isDirectory: () => dirs.includes(p), mtimeMs: 1000 });

test("match: tiers keep route.js's order", () => {
  assert.equal(match("safari", "Safari"), 1);
  assert.equal(match("saf", "Safari"), 0.9);
  assert.equal(match("code", "Visual Studio Code"), 0.8);
  assert.equal(match("vsc", "Visual Studio Code"), 0.8, "initials");
  assert.equal(match("studio", "VisualStudio"), 0.8, "camelCase words");
  assert.equal(match("ari", "Safari"), 0.5);
  assert.equal(match("sfr", "Safari"), 0.3);
  assert.equal(match("xyz", "Safari"), 0);
  assert.equal(match("", "Safari"), 0);
  assert.equal(match("wifi", "Wi-Fi"), 1, "punctuation does not count");
  assert.ok(match("volume", "Sound", ["volume"]) < 1 && match("volume", "Sound", ["volume"]) > 0.9, "a synonym is a shade under the label");
});

test("apps: scans one and two levels deep, dedupes, and searches from the cache", async () => {
  const root = tmp();
  const a = path.join(root, "Applications"), u = path.join(a, "Utilities"), home = path.join(root, "home");
  for (const d of [a, u, path.join(a, "Adobe Thing"), path.join(a, "Adobe Thing", "Adobe Photo Editor.app"),
    path.join(a, "Visual Studio Code.app"), path.join(a, "Safari.app", "Contents", "Inner.app"), path.join(u, "Terminal.app"), path.join(a, ".Hidden.app")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  let t = 0;
  const apps = new Apps({ dirs: [a, u, path.join(root, "missing")], now: () => t, home: root });
  assert.deepEqual(apps.search("saf"), [], "nothing cached yet, and it does not wait");
  const list = await apps.list();
  assert.deepEqual(list.map(r => r.label).sort(), ["Adobe Photo Editor", "Safari", "Terminal", "Visual Studio Code"]);
  const saf = list.find(r => r.label === "Safari");
  assert.deepEqual(saf, { kind: "app", id: `app:${path.join(a, "Safari.app")}`, label: "Safari", sub: "~/Applications", last: 0, target: path.join(a, "Safari.app") });
  assert.equal(apps.search("vsc")[0].label, "Visual Studio Code");
  assert.equal(apps.search("photo")[0].label, "Adobe Photo Editor");

  fs.mkdirSync(path.join(a, "Notes.app"));
  t += 30_000;
  assert.equal((await apps.list()).length, 4, "cached for 60 s");
  t += 31_000;
  assert.equal((await apps.list()).length, 5, "rescanned after 60 s");
  fs.mkdirSync(path.join(a, "Mail.app"));
  assert.equal((await apps.refresh()).length, 6, "refresh() rescans now");
  void home;
});

test("apps: frecency boost reorders close matches", async () => {
  const root = tmp();
  for (const n of ["Notes.app", "Notion.app"]) fs.mkdirSync(path.join(root, n));
  const apps = new Apps({ dirs: [root] });
  await apps.list();
  assert.equal(apps.search("no")[0].label, "Notes");
  const boost = id => (id.endsWith("Notion.app") ? 0.3 : 0);
  assert.equal(apps.search("no", 6, boost)[0].label, "Notion");
});

test("files: builds a display-name query, skips noise, types folders, tildes the home", async () => {
  const home = "/Users/someone";
  const { run, calls } = fakeRun([
    `${home}/Library/Caches/report.txt`, `${home}/code/app/node_modules/report/index.js`, `${home}/code/.git/report`,
    `${home}/Apps/Foo.app/Contents/report.plist`, `${home}/.config/report`,
    `${home}/Documents/report.pdf`, `${home}/Documents/Reports`, `${home}/Documents/report.pdf`,
  ]);
  const out = await files("report", { run, stat: fakeStat([`${home}/Documents/Reports`]), home, onlyin: home });
  assert.equal(calls[0].file, "/usr/bin/mdfind");
  assert.deepEqual(calls[0].args, ["-onlyin", home, "-attr", "kMDItemLastUsedDate", "-attr", "kMDItemContentType", 'kMDItemDisplayName == "*report*"cd']);
  assert.deepEqual(out.map(r => [r.kind, r.label, r.sub]), [["file", "report.pdf", "~/Documents"], ["folder", "Reports", "~/Documents"]]);
  assert.equal(out[0].id, `file:${home}/Documents/report.pdf`);
  assert.equal(out[0].target, `${home}/Documents/report.pdf`);
});

test("files: stops reading at the limit and kills mdfind", async () => {
  const { run, calls } = fakeRun(Array.from({ length: 50 }, (_, i) => `/x/f${i}.txt`), { hang: true });
  const out = await files("f1", { run, stat: fakeStat([]), limit: 3 });
  assert.equal(out.length, 3);
  assert.equal(calls[0].child.killed, true);
});

test("files: killed on timeout and on abort, returning what it had", async () => {
  const slow = fakeRun(["/x/a1.txt"], { hang: true });
  const t0 = Date.now();
  const out = await files("a1", { run: slow.run, stat: fakeStat([]), timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(slow.calls[0].child.killed, true);
  assert.deepEqual(out.map(r => r.label), ["a1.txt"]);

  const ac = new AbortController();
  const hung = fakeRun([], { hang: true });
  const p = files("zz", { run: hung.run, stat: fakeStat([]), signal: ac.signal, timeoutMs: 10_000 });
  ac.abort();
  assert.deepEqual(await p, []);
  assert.equal(hung.calls[0].child.killed, true);
});

test("files: short queries and gone files return nothing", async () => {
  const { run, calls } = fakeRun(["/x/ab"]);
  assert.deepEqual(await files("a", { run }), []);
  assert.deepEqual(await files("  a \n", { run }), []);
  assert.equal(calls.length, 0, "no mdfind for one character");
  const gone = await files("ab", { run, stat: async () => { throw new Error("ENOENT"); } });
  assert.deepEqual(gone, []);
});

test("files: hostile input stays inside the quotes", () => {
  assert.equal(mdQuery('a"b'), 'kMDItemDisplayName == "*a\\"b*"cd');
  assert.equal(mdQuery("a*b"), 'kMDItemDisplayName == "*a\\*b*"cd');
  assert.equal(mdQuery("a\\b"), 'kMDItemDisplayName == "*a\\\\b*"cd');
  assert.equal(mdQuery('x"cd || kMDItemFSName == "*'), 'kMDItemDisplayName == "*x\\"cd || kMDItemFSName == \\"\\**"cd');
  assert.equal(mdQuery("two\nlines\r\t"), 'kMDItemDisplayName == "*two lines*"cd');
  // Every quote in the query is either one of the two structural ones or escaped.
  for (const q of ['"', '\\"', '"\\', '*"cd', '\\\\"', "\"\n\"", '$time.now"']) {
    const body = mdQuery(q).slice('kMDItemDisplayName == "'.length, -'"cd'.length);
    assert.doesNotMatch(body.replace(/\\./g, ""), /["\n]/, `unescaped quote from ${JSON.stringify(q)}`);
  }
});

test("files: noise filter", () => {
  assert.ok(noise("/Users/a/Library/Mail/x"));
  assert.ok(noise("/Users/a/p/node_modules/x"));
  assert.ok(noise("/Users/a/Foo.app/Contents/Info.plist"));
  assert.ok(noise("/Users/a/.ssh/config"));
  assert.ok(!noise("/Users/a/Documents/Library notes.txt"));
  assert.ok(!noise("/Users/a/Documents/app plan.md"));
  for (const p of ["/Users/a/google-cloud-sdk/lib/zoneinfo/Asia/Calcutta", "/Users/a/p/vendor/x", "/Users/a/p/build/out.pdf", "/Users/a/p/dist",
    "/Users/a/p/target/debug/x", "/Users/a/p/.next/x", "/Users/a/py/lib/python3/site-packages/x", "/Users/a/p/third_party/x", "/Users/a/p/third-party/x",
    "/Users/a/ios/Pods/x", "/Users/a/p/venv/x", "/Users/a/p/.venv/x", "/Users/a/p/coverage/x", "/Users/a/tmp/x", "/Users/a/p/out/x",
    "/Users/a/Library/Caches/x", "/Users/a/x/Foo.xcodeproj/y"]) assert.ok(noise(p), p);
  for (const p of ["/Users/a/Documents/Build notes.pdf", "/Users/a/Documents/outline.md", "/Users/a/Desktop/Target receipts", "/Users/a/Documents/sdk.pdf",
    "/Users/a/Downloads/distances.xlsx"]) assert.ok(!noise(p), p);
});

test("files: reads last-used date and type from the same mdfind line, and marks files in a git repo", async () => {
  const home = "/Users/someone";
  const { run } = fakeRun([
    `${home}/Documents/Q3 invoice.pdf   kMDItemLastUsedDate = 2026-08-26 15:02:24 +0000   kMDItemContentType = com.adobe.pdf`,
    `${home}/code/site/docs/invoice.md   kMDItemLastUsedDate = (null)   kMDItemContentType = net.daringfireball.markdown`,
  ]);
  const exists = async p => { if (p !== `${home}/code/site/.git`) throw new Error("ENOENT"); };
  const out = await files("invoice", { run, stat: fakeStat([]), exists, home, onlyin: home });
  assert.deepEqual(out.map(r => [r.label, r.used, r.uti, r.repo]), [
    ["Q3 invoice.pdf", Date.UTC(2026, 7, 26, 15, 2, 24), "com.adobe.pdf", false],
    ["invoice.md", 0, "net.daringfireball.markdown", true]]);
  assert.deepEqual(mdLine("/a b/c   d.txt"), { path: "/a b/c   d.txt", used: 0, uti: "" }, "a plain line is all path");
  assert.equal(mdLine("/x   kMDItemLastUsedDate = 2026-01-02 03:04:05 -0500   kMDItemContentType = public.png").used, Date.UTC(2026, 0, 2, 8, 4, 5));
});

test("taste: name start before substring, documents before code, recent use rises, apps win a tie", () => {
  const home = "/Users/a", now = Date.UTC(2026, 8, 26);
  const t = (label, dir, extra = {}) => taste({ kind: "file", label, target: `${dir}/${label}`, ...extra }, extra.q || "invoice", { now, home });
  const doc = t("Invoice March.pdf", `${home}/Documents`);
  const word = t("March invoice.pdf", `${home}/Documents`);
  const sub = t("Reinvoiced.pdf", `${home}/Documents`);
  const code = t("invoice.ts", `${home}/code/app/src`, { repo: true });
  const recent = t("March invoice.pdf", `${home}/Documents`, { used: now - 3_600_000 });
  assert.ok(doc > word && word > sub, "prefix, then word start, then substring");
  assert.ok(sub <= 0.3, "a substring alone is low");
  assert.ok(code < word && code < doc - 0.2, "a repo file sits below documents");
  assert.ok(recent > word, "opened an hour ago rises");
  assert.equal(t("Calcutta", `${home}/x`, { q: "zz" }), 0, "no match, no row");
  const folder = taste({ kind: "folder", label: "Invoices", target: `${home}/Documents/Invoices` }, "invoice", { now, home });
  const deep = taste({ kind: "folder", label: "Invoices", target: `${home}/p/q/Invoices` }, "invoice", { now, home });
  assert.ok(folder > deep, "a folder in Documents before one deep in a tree");
  assert.equal(t("invoice.pdf", `${home}/Documents`), taste({ kind: "file", label: "invoice.pdf", target: `${home}/Documents/invoice.pdf` }, "invoice", { now, home }));
  // An exact stem is the full name; still, a prefix-matched file stays under a prefix-matched app (0.9).
  assert.ok(t("Calculations.xlsx", `${home}/Documents`, { q: "calcu", used: now }) < 0.9);
});

test("filenameLike: an extension, a slash, or a known extension as the last word", () => {
  for (const q of ["report.pdf", "q3.xl", "notes.md", "invoice pdf", "Desktop/", "budget xlsx"]) assert.ok(filenameLike(q), q);
  for (const q of ["invoice", "calcu", "mr. smith", "notes on it", "v1.2"]) assert.ok(!filenameLike(q), q);
});

test("settings: synonyms find the pane people mean", () => {
  const first = q => settings(q)[0];
  assert.equal(first("wifi").label, "Wi-Fi");
  assert.equal(first("wi-fi").label, "Wi-Fi");
  assert.equal(first("volume").label, "Sound");
  assert.equal(first("dark mode").label, "Appearance");
  assert.equal(first("full disk").label, "Full Disk Access");
  assert.equal(first("input mon").label, "Input Monitoring");
  assert.equal(first("bluet").label, "Bluetooth");
  assert.ok(settings("internet").some(r => r.label === "Wi-Fi") && settings("internet").some(r => r.label === "Network"));
  assert.deepEqual(first("wifi"), { kind: "setting", id: "setting:com.apple.wifi-settings-extension", label: "Wi-Fi",
    sub: "System Settings", last: 0, target: "x-apple.systempreferences:com.apple.wifi-settings-extension", score: 1 });
  assert.equal(first("screen recording").target, "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture");
  assert.deepEqual(settings("qqqq"), []);
  assert.ok(PANES.length >= 30);
  assert.equal(new Set(PANES.map(p => p[1])).size, PANES.length, "ids are unique");
});

test("frecency: picks lift, decay with a 7-day half-life, and stay capped", () => {
  const dir = tmp();
  let now = 1_000 * DAY;
  const f = new Frecency(path.join(dir, "deep", "frecency.json"), { now: () => now });
  assert.equal(f.boost("app:/A.app", "a"), 0);
  f.pick("app:/A.app", "saf");
  const one = f.boost("app:/A.app", "");
  assert.ok(one > 0 && one < 0.2);
  for (let i = 0; i < 50; i++) f.pick("app:/A.app", "saf");
  assert.ok(f.boost("app:/A.app", "") <= 0.45);
  assert.ok(f.boost("app:/A.app", "sa") > f.boost("app:/A.app", "xyz"), "same prefix picked it before");
  assert.ok(f.boost("app:/A.app", "safari") > f.boost("app:/A.app", ""), "a longer query sharing the prefix counts");
  assert.ok(f.boost("app:/A.app", "sa") <= 0.6);

  const g = new Frecency(path.join(dir, "g.json"), { now: () => now });
  g.pick("x", "");
  const fresh = g.boost("x", "");
  now += 7 * DAY;
  const week = g.boost("x", "");
  now += 70 * DAY;
  assert.ok(week < fresh && g.boost("x", "") < week / 10, "old picks fade");
  // Decayed count halves in a week: 1 -> 0.5.
  assert.ok(Math.abs(week - 0.45 * (1 - Math.exp(-0.5 / 3))) < 1e-9);

  const h = new Frecency(path.join(dir, "h.json"), { now: () => now, cap: 5 });
  for (let i = 0; i < 8; i++) { now += DAY; h.pick(`id${i}`, ""); }
  h.pick("id7", "");
  const kept = Object.keys(/** @type {object} */ (h.items)).sort();
  assert.deepEqual(kept, ["id3", "id4", "id5", "id6", "id7"], "oldest dropped first");
  f.flush(); g.flush(); h.flush();
});

test("frecency: writes atomically on a debounce, reloads, and survives a corrupt file", async () => {
  const dir = tmp();
  const file = path.join(dir, "sub", "frecency.json");
  const f = new Frecency(file, { delayMs: 20 });
  f.pick("setting:com.apple.wifi-settings-extension", "wifi please turn it on");
  assert.ok(!fs.existsSync(file), "not written on the keystroke");
  await new Promise(r => setTimeout(r, 60));
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("please"), "only a short prefix is stored");
  assert.ok(raw.includes('"wifi p"'));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["frecency.json"], "no temp file left behind");
  const again = new Frecency(file);
  assert.ok(again.boost("setting:com.apple.wifi-settings-extension", "wifi") > 0);

  fs.writeFileSync(file, "{not json");
  const broken = new Frecency(file);
  assert.equal(broken.boost("anything", "a"), 0);
  broken.pick("a", "b");
  broken.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).items.a.s, 1);
});

test("open: runs /usr/bin/open without a shell, and reports failure", async () => {
  const calls = [];
  const ok = (file, args, cb) => { calls.push([file, args]); cb(null, "", ""); };
  assert.deepEqual(await open({ kind: "setting", id: "s", label: "Wi-Fi", sub: "", last: 0, target: "x-apple.systempreferences:com.apple.wifi-settings-extension" }, { run: ok }), { ok: true });
  assert.deepEqual(await open({ kind: "file", id: "f", label: "a b", sub: "", last: 0, target: "/tmp/a b; rm -rf ~" }, { run: ok }), { ok: true });
  assert.deepEqual(calls, [["/usr/bin/open", ["x-apple.systempreferences:com.apple.wifi-settings-extension"]], ["/usr/bin/open", ["/tmp/a b; rm -rf ~"]]]);
  const bad = (file, args, cb) => cb(new Error("exit 1"), "", "The file does not exist.\n");
  assert.deepEqual(await open({ kind: "file", id: "f", label: "x", sub: "", last: 0, target: "/nope" }, { run: bad }), { error: "The file does not exist." });
  assert.ok("error" in await open({ kind: "file", id: "f", label: "x", sub: "", last: 0, target: "-a Calculator" }, { run: ok }));
  assert.equal(calls.length, 2, "a non-path target never reaches open");
});

test("tilde", () => {
  assert.equal(tilde("/Users/a/Docs", "/Users/a"), "~/Docs");
  assert.equal(tilde("/Users/a", "/Users/a"), "~");
  assert.equal(tilde("/Users/ab/x", "/Users/a"), "/Users/ab/x");
});

test("smoke: real mdfind finds a file created under the temp dir (read-only)", async t => {
  if (process.platform !== "darwin") return t.skip("macOS only");
  const dir = tmp();
  const name = `vyrelocalsmoke${process.pid}.txt`;
  fs.writeFileSync(path.join(dir, name), "x");
  try { execFileSync("/usr/bin/mdimport", [dir], { stdio: "ignore", timeout: 5000 }); } catch {}
  let out = [];
  for (let i = 0; i < 10 && !out.length; i++) {
    out = await files("vyrelocalsmoke", { onlyin: dir, timeoutMs: 2000 });
    if (!out.length) await new Promise(r => setTimeout(r, 200));
  }
  if (!out.length) return t.skip("Spotlight does not index the temp dir on this Mac");
  assert.equal(out[0].label, name);
});
