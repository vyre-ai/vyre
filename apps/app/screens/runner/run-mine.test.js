// Where a chat runs, as the owner met it live (20 Oct): the header's "Runs on" switch, one Settings switch "Run my chats on this computer", a refusal that links to it (or names the admin), on by
// default in the owner's own desktop app, and "this computer" wherever any computer is meant.
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { REASON_WORDS, RUN_SWITCH_ROUTE, RUN_SWITCH_TITLE, chipOf, movedLine, runRefusal, runsOnWords, turnOnByDefault } from "./runner-model.js";

const read = (/** @type {string} */ p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("the header switch says Server or This computer (or the computer's own name), and why in its menu", () => {
  assert.deepEqual(runsOnWords({ where: "server" }), { short: "Server", why: "" });
  assert.deepEqual(runsOnWords({ where: "server", reason: "lid-closed" }), { short: "Server", why: "On the server: lid closed." });
  assert.deepEqual(runsOnWords({ where: "mac" }), { short: "This computer", why: "" });
  assert.equal(runsOnWords({ where: "mac", computer: "Dana's laptop" }).short, "Dana's laptop");
  assert.equal(runsOnWords({ where: "mac", state: "paused" }).short, "Paused");
  assert.equal(runsOnWords({ where: "server", offer: "mac" }).why, "It can come back to this computer.");
  assert.equal(runsOnWords({ where: "server", pinned: true }).why, "It is kept on the server.");
  assert.deepEqual(runsOnWords(null), { short: "", why: "" });
});

test("no word says Mac where any computer is meant", () => {
  for (const w of Object.values(REASON_WORDS)) assert.doesNotMatch(w, /\bMac\b/);
  assert.doesNotMatch(chipOf({ where: "server" })?.moveLabel ?? "", /\bMac\b/);
  assert.equal(chipOf({ where: "server" })?.moveLabel, "Move to this computer");
  assert.equal(movedLine({ to: "mac", reason: "you" }), "Moved to this computer: you moved it.");
  const model = read("./runner-model.js").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
  assert.doesNotMatch(model.replace(/MacSettings/g, ""), /["`'][^"`'\n]*\bMac\b[^"`'\n]*["`']/, "no string in the runner's words says Mac");
});

test("not set up: one short line and the Settings switch as the next step; not allowed: ask the Space's admin", () => {
  assert.deepEqual(runRefusal({ code: "no_lease", message: "x" }, { allowed: true }), { line: "This computer is not set up to run chats yet.", action: { label: "Turn it on", route: RUN_SWITCH_ROUTE } });
  assert.deepEqual(runRefusal({ code: "no_lease" }, { allowed: null })?.action?.route, "/u/settings/system");
  assert.deepEqual(runRefusal({ code: "no_lease" }, { allowed: false }), { line: "Your Space keeps chats on its server. Ask your Space's admin to allow this.", action: null });
  assert.equal(runRefusal({ code: "conflict" }, { allowed: true }), null, "any other refusal is the box's own words");
  assert.equal(RUN_SWITCH_TITLE, "Run my chats on this computer");
});

test("on by default once, only in the owner's own desktop app where a Space allows it, and never over a choice the person made", () => {
  const yes = { desktop: true, owner: true, allowed: true, enabled: false, chosen: false };
  assert.equal(turnOnByDefault(yes), true);
  assert.equal(turnOnByDefault({ ...yes, desktop: false }), false, "a browser or a phone");
  assert.equal(turnOnByDefault({ ...yes, owner: false }), false, "a member");
  assert.equal(turnOnByDefault({ ...yes, allowed: false }), false, "no Space allows it");
  assert.equal(turnOnByDefault({ ...yes, enabled: true }), false, "already on");
  assert.equal(turnOnByDefault({ ...yes, chosen: true }), false, "the person chose");
});

test("Settings, This computer has ONE switch with that title, on the existing runner calls; the box's refusal names it", () => {
  const page = read("./RunHere.tsx");
  assert.match(page, /<Switch label=\{RUN_SWITCH_TITLE\}/);
  assert.doesNotMatch(page, /<Segmented/, "no three-way choice any more");
  assert.match(page, /runner\.turnOn\(\)/);
  assert.match(page, /runner\.turnOff\(\)/);
  assert.match(page, /Ask your Space's admin to allow this\./);
  const place = read("../../../../core/runner/place-tools.js");
  assert.match(place, /This computer is not set up to run chats yet\. Turn on Run my chats on this computer in Settings, This computer\.", "no_lease"/);
  assert.doesNotMatch(place, /turn on Run on this computer on the Mac/);
});

test("the chat header carries where it runs; the floating pill above the composer is gone", () => {
  const screen = read("../../src/chat/ChatScreen.tsx");
  assert.match(screen, /place=\{<PlacementSwitch placement=\{placed\.placement\}/);
  assert.doesNotMatch(screen, /PlacementChip/);
  const start = screen.indexOf("<StatusLine"), end = screen.indexOf("/>", start);
  assert.doesNotMatch(screen.slice(start, end), /place=/, "the status line has no place chip");
  const header = read("../../src/chat/ChatHeader.tsx");
  assert.match(header, /\{place\}\s*\n\s*\{menu && menu\.length \? <Menu align="end"/, "beside the ... menu, top right");
  const sw = read("../../src/chat/placement.tsx");
  assert.match(sw, /label: "Server"/);
  assert.match(sw, /label: "This computer"/);
  assert.doesNotMatch(sw, /Move to this Mac/);
});
