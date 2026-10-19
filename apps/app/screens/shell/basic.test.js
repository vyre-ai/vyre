import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { capChoices, sizeWords, storageLine, hostChoices, isBasicRow, gatedPath, backupLine, storedLine, NEEDS_SERVER } from "./basic.js";

test("a space is Basic only when the box says tier basic; cloud and team spaces are not", () => {
  assert.equal(isBasicRow({ tier: "basic" }), true);
  assert.equal(isBasicRow({ tier: "cloud" }), false);
  assert.equal(isBasicRow({ setup: { who: "personal" }, home: { kind: "this-computer" } }), false, "no inference from other fields");
  assert.equal(isBasicRow(null), false);
  assert.equal(NEEDS_SERVER, "This needs a Cloud space");
});

test("with no Cloud space the planner, records, flows and calendar are gated; chats and projects are not", () => {
  for (const p of ["/u/records/contact", "/u/records/reminder", "/u/record/abc", "/u/flows", "/u/flows/x", "/u/kits", "/u/planner", "/u/calendar", "/u/task/t1", "/u/settings/customize"]) assert.equal(gatedPath(p), true, p);
  for (const p of ["/u/now", "/u/chats", "/u/chats/c1", "/u/projects", "/u/project/p1", "/u/settings", "/u/memory", "/u/vault", "/u/drive"]) assert.equal(gatedPath(p), false, p);
});

test("a person in any Cloud space has the planner, reminders, notes, to-dos and calendar in Personal; custom Records, Customize and flows stay gated", () => {
  for (const p of ["/u/planner", "/u/calendar", "/u/task/t1", "/u/records/reminder", "/u/records/note"]) assert.equal(gatedPath(p, true), false, p);
  for (const p of ["/u/records/contact", "/u/records/matter", "/u/record/abc", "/u/flows", "/u/kits", "/u/settings/customize"]) assert.equal(gatedPath(p, true), true, p);
});

test("where a Personal space keeps its planner items: encrypted on a team's server, or nothing said", () => {
  assert.equal(storedLine({ basic: true, teams: [{ name: "Juniper" }] }), "Reminders, notes and to-dos: encrypted on Juniper's server");
  assert.equal(storedLine({ basic: true, teams: [] }), null);
  assert.equal(storedLine({ basic: false, teams: [{ name: "Juniper" }] }), null);
});

test("the backup line: not backed up with no team, the destination when the box says, nothing when it is unknown", () => {
  const NB = "Not backed up: join a team or set up My Cloud";
  assert.equal(backupLine({ basic: true, teams: [] }), NB);
  assert.equal(backupLine({ basic: true, teams: [{ name: "Juniper" }], status: { to: "Juniper", state: "ok" } }), "Backed up, encrypted, to Juniper");
  assert.equal(backupLine({ basic: true, teams: [{ name: "Juniper" }], status: { to: null } }), NB);
  assert.equal(backupLine({ basic: true, teams: [{ name: "Juniper" }] }), null, "a team exists but the box has not said: no claim");
  assert.equal(backupLine({ basic: false, teams: [] }), null);
});

test("the personal-items host: the Cloud spaces from spaces.tier, named by the one function, and the current choice", () => {
  const t = { tier: "basic", cloud: [{ id: "spc_a", name: "juniper.vyre.run", label: "juniper" }, { id: "spc_b", name: "example.vyre.run", label: null }], time_zone: null, personal_host: "spc_b" };
  assert.deepEqual(hostChoices(t), { options: [["spc_a", "juniper"], ["spc_b", "example"]], current: "spc_b" });
  assert.deepEqual(hostChoices({ cloud: [], personal_host: null }), { options: [], current: null });
  assert.equal(hostChoices({ cloud: [{ id: "spc_a", name: "x" }], personal_host: "gone" }).current, null);
});

test("the storage line: what is used, the cap when there is one, and where", () => {
  assert.equal(sizeWords(0), "0 B");
  assert.equal(sizeWords(1536), "1.5 KB");
  assert.equal(sizeWords(5 * 1024 ** 3), "5 GB");
  assert.equal(storageLine({ used: 12 * 1024 ** 2, cap: 1024 ** 3 }, "juniper"), "Using 12 MB of 1 GB on juniper");
  assert.equal(storageLine({ used: 2048, cap: 0 }, "juniper"), "Using 2 KB on juniper");
  assert.equal(storageLine(null, "juniper"), null);
});

test("the owner's cap choices: no cap and round sizes, with the current one kept in the list", () => {
  assert.deepEqual(capChoices(0).map(([, l]) => l), ["No cap", "1 GB", "5 GB", "10 GB", "50 GB", "100 GB"]);
  assert.ok(capChoices(2 * 1024 ** 3).some(([v]) => v === String(2 * 1024 ** 3)));
});
