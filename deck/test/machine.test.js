// @ts-check
// The paired Mac's rows in the Deck (deck/js/machine.js): which rows get a machine chip, the note
// that stands in for their actions, and the offline chip from link.macs. Pure enough for node,
// with the chat tests' small DOM stand-in. The views themselves are a browser check.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDom, allText } from "../chat/lib/test-dom.js";

installDom();
const { isMac, machineChip, readOnlyNote, offlineNames, offlineChip, readMacs } = await import("../js/machine.js");

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = name => JSON.parse(fs.readFileSync(path.join(DECK, "fixtures", name), "utf8"));

test("machine: only a row labelled with the Mac gets a chip, and it names the machine", () => {
  const chip = /** @type {any} */ (machineChip({ id: "s1", source: "mac", machine: "alex-mac" }));
  assert.equal(allText(chip), "alex-mac");
  assert.match(chip.className, /\btag\b/);
  assert.match(chip.className, /\bmachine\b/);
  for (const row of [{ source: "box", machine: "box" }, { id: "s2" }, null, undefined, { source: "Mac", machine: "alex-mac" }]) {
    assert.equal(machineChip(row), null, JSON.stringify(row));
    assert.equal(isMac(row), false);
  }
  assert.equal(isMac({ source: "mac" }), true);
  assert.equal(allText(/** @type {any} */ (machineChip({ source: "mac" }))), "your Mac", "a Mac row without a name still says where it is");
});

test("machine: a Mac row's actions give way to one line saying where to continue it", () => {
  assert.equal(readOnlyNote({ source: "mac", machine: "alex-mac" }), "On alex-mac. Open it there to continue.");
  assert.equal(readOnlyNote({ source: "mac" }), "On your Mac. Open it there to continue.");
});

test("machine: the offline chip names each paired Mac that is away, and nothing when none is", () => {
  const macs = fixture("link.json")["link.macs"];
  assert.deepEqual(offlineNames(macs), ["alex-air"]);
  assert.equal(allText(/** @type {any} */ (offlineChip(macs))), "alex-air offline");
  assert.equal(offlineChip([{ name: "alex-mac", online: true }]), null);
  assert.equal(offlineChip([]), null);
  assert.equal(offlineChip(undefined), null);
  assert.deepEqual(offlineNames([{ node: "alex-mac", online: false }, { online: false }]), ["alex-mac", "your Mac"]);
});

test("machine: link.macs is read while the page is seen, kept while it is hidden, and a machine without it has no Macs", async () => {
  /** @type {string[]} */ const asked = [];
  const attempt = async tool => { asked.push(tool); return { data: [{ name: "alex-mac", online: false }] }; };
  assert.deepEqual(await readMacs(attempt), [{ name: "alex-mac", online: false }]);
  const prev = [{ name: "kept" }];
  /** @type {any} */ (globalThis.document).hidden = true;
  try { assert.equal(await readMacs(attempt, prev), prev); } finally { delete (/** @type {any} */ (globalThis.document)).hidden; }
  assert.deepEqual(asked, ["link.macs"], "not asked while hidden");
  assert.deepEqual(await readMacs(async () => ({ error: { code: "no_such_tool", missing: true } })), []);
});

test("machine: the fixture Deck has Mac rows to chip", () => {
  const mac = fixture("threads.json")["threads.list"].filter(isMac);
  assert.ok(mac.length >= 1);
  assert.ok(mac.every(t => t.machine === "alex-mac"));
  assert.ok(fixture("threads.json")["threads.list"].some(t => !isMac(t)), "box rows stay unlabelled");
});
