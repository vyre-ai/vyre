// @ts-check
// The installed-apps scan over a temp folder of fake bundles: XML and binary plists, one level
// into plain subfolders, ranking, and a cache that expires on read.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { installed, rank, SCAN_TTL_MS } from "./installed.js";
import { fakeExec, fakeApp } from "./fake.js";
import { tempHome } from "../../test/helpers.js";

test("installed: names rank prefix, then word prefix, then substring", () => {
  assert.equal(rank("Notes", "no"), 0);
  assert.equal(rank("Microsoft Notes", "no"), 1);
  assert.equal(rank("Keynote", "no"), 2);
  assert.equal(rank("Safari", "no"), -1);
});

test("installed: reads bundles one level deep and one into plain folders, with ids from XML and plutil", async t => {
  const home = tempHome(t);
  const apps = path.join(home, "Applications"), sys = path.join(home, "System");
  fakeApp(apps, "Notes", "com.apple.Notes");
  fakeApp(apps, "Keynote", "com.apple.iWork.Keynote");
  fakeApp(path.join(apps, "Utilities"), "Terminal", "com.apple.Terminal", true);
  fakeApp(path.join(apps, "Deep", "Deeper"), "TooDeep", "x.too.deep");
  fakeApp(sys, "Notes", "com.other.Notes");
  fakeApp(sys, "Bare", null);
  const f = fakeExec((file, args) => (file === "plutil" && args.at(-1)?.includes("Terminal.app") ? { stdout: "com.apple.Terminal\n" } : { code: 1 }));
  const list = installed({ dirs: [apps, sys, path.join(home, "missing")], now: () => 0, exec: f.exec });
  const all = await list.find({ limit: 50 });
  assert.deepEqual(all.map(a => [a.name, a.bundleId]), [["Bare", null], ["Keynote", "com.apple.iWork.Keynote"], ["Notes", "com.apple.Notes"], ["Terminal", "com.apple.Terminal"]]);
  assert.equal(all[2].path, path.join(apps, "Notes.app"));
  assert.deepEqual(f.calls.map(c => c.args.slice(0, 5)), [["-extract", "CFBundleIdentifier", "raw", "-o", "-"]]);
  assert.deepEqual((await list.find({ q: "no" })).map(a => a.name), ["Notes", "Keynote"]);
});

test("installed: plutil runs only for the rows returned", async t => {
  const home = tempHome(t);
  for (const n of ["Alpha", "Beta", "Gamma"]) fakeApp(home, n, `x.${n}`, true);
  const f = fakeExec((file, args) => ({ stdout: "id." + path.basename(path.dirname(path.dirname(args.at(-1) || ""))) }));
  const list = installed({ dirs: [home], now: () => 0, exec: f.exec });
  await list.find({ q: "beta" });
  assert.equal(f.calls.length, 1);
  await list.find({ q: "beta" });
  assert.equal(f.calls.length, 1, "a known id was read again");
});

test("installed: the scan is cached for five minutes and expires when read", async t => {
  const home = tempHome(t);
  fakeApp(home, "Notes", "com.apple.Notes");
  let now = 1000;
  const list = installed({ dirs: [home], now: () => now, exec: fakeExec().exec });
  assert.equal((await list.find({})).length, 1);
  fakeApp(home, "Reminders", "com.apple.reminders");
  now += SCAN_TTL_MS;
  assert.equal((await list.find({})).length, 1, "rescanned before the cache expired");
  assert.equal(list.scans, 1);
  now += 1;
  assert.equal((await list.find({})).length, 2);
  assert.equal(list.scans, 2);
  list.clear();
  await list.find({});
  assert.equal(list.scans, 3);
});
