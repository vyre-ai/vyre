import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { atTree, hashTree, tagsOf } from "./mention-tree.js";
import { nestRows } from "../../ui/lib/nest-model.js";

const titleOf = (def, rec) => rec.data.name || rec.urn;
const world = {
  types: [
    { name: "client", label: "Clients", fields: [{ name: "ssn", kind: "sealed" }] },
    { name: "matter", label: "Matters", fields: [] },
    { name: "project", label: "Project", fields: [] },
    { name: "def-x", label: "Hidden", fields: [] },
  ],
  byType: {
    client: [{ urn: "u/c1", data: { name: "Dana Okafor", ssn: "123", tags: "vip, estate" } }, { urn: "u/c2", data: { name: "Sam Lee" } }],
    matter: [{ urn: "u/m1", data: { name: "Okafor estate", tags: ["estate"] } }],
    project: [
      { urn: "u/p1", data: { name: "Okafor admin", template: "tpl_estate-plan" } },
      { urn: "u/p2", data: { name: "Spring ads", template: "tpl_ad-campaign" } },
      { urn: "u/p3", data: { name: "Loose project" } },
    ],
  },
};
const templates = { templates: [{ template: "tpl_estate-plan", name: "Estate plan", noun: { one: "Matter", many: "Matters" } }, { template: "tpl_ad-campaign", name: "Ad campaign" }] };
const files = [
  { path: "Projects/okafor/files/Deed scan.png" },
  { path: "Projects/okafor/made/Site.mp4" },
  { path: "space/Voice note.mp3" },
];
const names = { "Projects/okafor": "Okafor estate" };
const tree = hashTree({ world, titleOf, templates, files, names });
const find = (nodes, ...keys) => keys.reduce((n, k) => (n.kids ?? n).find((x) => x.key === k || x.label === k), nodes);

test("# has four categories in order", () => {
  assert.deepEqual(tree.map((n) => n.label), ["Projects", "Records", "Files", "Tags"]);
});

test("Projects: a branch per template with a whole pick, then its projects", () => {
  const projects = tree[0];
  const estate = projects.kids.find((k) => k.label === "Estate plan");
  assert.deepEqual(estate.pick, { pick: "Matters (all)", urn: "template/tpl_estate-plan", kind: "collection" });
  assert.deepEqual(estate.kids.map((k) => k.label), ["Okafor admin"]);
  assert.deepEqual(estate.kids[0].pick, { pick: "Okafor admin", urn: "u/p1", kind: "project" });
  const ads = projects.kids.find((k) => k.label === "Ad campaign");
  assert.equal(ads.pick.pick, "Ad campaign (all)");
  const loose = projects.kids.find((k) => k.label === "No template");
  assert.deepEqual(loose.kids.map((k) => k.label), ["Loose project"]);
  assert.equal(loose.pick, undefined);
});

test("Records: an object per visible type (not projects, not internal), whole or one", () => {
  const recs = tree[1];
  assert.deepEqual(recs.kids.map((k) => k.label), ["Clients", "Matters"]);
  const clients = recs.kids[0];
  assert.deepEqual(clients.pick, { pick: "Clients (all)", urn: "type/client", kind: "collection" });
  assert.deepEqual(clients.kids[0].pick, { pick: "Dana Okafor", urn: "u/c1", kind: "record" });
  assert.equal(clients.kids[0].sealed, 1);
  assert.equal(clients.kids[1].sealed, 0);
});

test("Files: folders from the paths, shown by the Drive's names, whole folder or one file", () => {
  const f = tree[2];
  assert.deepEqual(f.kids.map((k) => k.label), ["Projects", "space"]);
  const okafor = find(f, "Projects", "okafor");
  assert.equal(okafor.label, "Okafor estate");
  assert.deepEqual(okafor.pick, { pick: "Okafor estate (all)", urn: "folder/Projects/okafor", kind: "collection" });
  assert.deepEqual(okafor.kids.map((k) => k.label), ["files", "made"]);
  const deed = find(okafor, "files", "Deed scan.png");
  assert.deepEqual(deed.pick, { pick: "Deed scan.png", urn: "file/Projects/okafor/files/Deed scan.png", kind: "file" });
  assert.equal(deed.kids, undefined);
});

test("Tags: each distinct tag once, with how many records carry it", () => {
  const t = tree[3];
  assert.deepEqual(t.kids.map((k) => k.label), ["estate", "vip"]);
  assert.deepEqual(t.kids[0].pick, { pick: "estate", urn: "tag/estate", kind: "tag" });
  assert.equal(t.kids[0].sub, "2 records");
  assert.equal(t.kids[1].sub, "1 record");
});

test("tagsOf reads a comma string or a list, lower-cased, no empties", () => {
  assert.deepEqual(tagsOf("A, b ,,c"), ["a", "b", "c"]);
  assert.deepEqual(tagsOf(["X", " y "]), ["x", "y"]);
  assert.deepEqual(tagsOf(undefined), []);
});

test("an empty world offers nothing to open: no category, template, object or folder without something inside", () => {
  assert.deepEqual(hashTree({ world: null, titleOf, templates: null, files: [], names: {} }), []);
});

test("a template with no projects, an object with no records and a category with nothing are not offered", () => {
  const t = hashTree({
    world: { types: [{ name: "client", label: "Clients", fields: [] }, { name: "lead", label: "Leads", fields: [] }, { name: "project", label: "Project", fields: [] }], byType: { client: [{ urn: "u/c1", data: { name: "Dana" } }], lead: [], project: [{ urn: "u/p1", data: { name: "Okafor admin", template: "tpl_estate-plan" } }] } },
    titleOf, templates, files: [], names: {},
  });
  assert.deepEqual(t.map((n) => n.label), ["Projects", "Records"], "no Files, no Tags");
  assert.deepEqual(t[0].kids.map((k) => k.label), ["Estate plan"], "Ad campaign has no project");
  assert.deepEqual(t[1].kids.map((k) => k.label), ["Clients"], "Leads has no records");
});

test("searching # finds a record, a project and a file across categories", () => {
  const rows = nestRows(tree, [], "okafor");
  const by = (g) => rows.filter((r) => r.group === g).map((r) => r.label);
  assert.deepEqual(by("Projects"), ["Okafor admin"]);
  assert.deepEqual(by("Records"), ["Okafor estate", "Dana Okafor"]);
  assert.deepEqual(by("Files"), ["Okafor estate"]);
});

test("@ has People, Teams and roles, Agents, AIs; empty groups are left out", () => {
  const people = [
    { name: "alex", family: "person" }, { name: "Dana Okafor", family: "person" },
    { name: "juno", family: "assistant", doing: "Waiting" }, { name: "claude", family: "assistant", group: "ai" },
  ];
  const t = atTree({ people, teams: [{ name: "Attorneys", kind: "role" }, { name: "Intake", kind: "team" }] });
  assert.deepEqual(t.map((n) => n.label), ["People", "Teams and roles", "Agents", "AIs"]);
  assert.deepEqual(t[0].kids.map((k) => k.label), ["alex", "Dana Okafor"]);
  assert.deepEqual(t[0].kids[0].pick, { pick: "alex" });
  assert.deepEqual(t[1].kids.map((k) => [k.label, k.sub]), [["Attorneys", "Role"], ["Intake", "Team"]]);
  assert.equal(t[2].kids[0].sub, "Waiting");
  assert.deepEqual(t[3].kids.map((k) => k.label), ["claude"]);
  const none = atTree({ people: [{ name: "alex", family: "person" }], teams: [] });
  assert.deepEqual(none.map((n) => n.label), ["People"]);
});

test("typing after @ searches across people, teams, agents and AIs", () => {
  const t = atTree({ people: [{ name: "Dana", family: "person" }, { name: "dash", family: "assistant" }], teams: [{ name: "Data team", kind: "team" }] });
  assert.deepEqual(nestRows(t, [], "da").map((r) => [r.group, r.label]), [["People", "Dana"], ["Teams and roles", "Data team"], ["Agents", "dash"]]);
});

import { filesOf, worldOfPicks } from "./mention-tree.js";

test("worldOfPicks makes one object per type, sealed counts kept", () => {
  const w = worldOfPicks([{ name: "Okafor estate", type: "Matter", sealed: 2 }, { name: "Lee trust", type: "Matter", sealed: 0 }]);
  const t = hashTree({ world: w, titleOf, templates: null, files: [], names: {} });
  const recs = t.find((n) => n.key === "records");
  assert.deepEqual(recs.kids.map((k) => k.label), ["Matter"]);
  assert.deepEqual(recs.kids[0].kids.map((k) => k.label), ["Okafor estate", "Lee trust"]);
  assert.equal(recs.kids[0].kids[0].sealed, 1);
});

test("filesOf recovers folder names from the words the Drive gave each file", () => {
  const r = filesOf([{ id: "Projects/okafor/files/Deed.png", path: "Projects / Okafor estate / files" }, { id: "space/Note.mp3", path: "space" }]);
  assert.deepEqual(r.paths, [{ path: "Projects/okafor/files/Deed.png" }, { path: "space/Note.mp3" }]);
  assert.deepEqual(r.names, { "Projects/okafor": "Okafor estate" });
});

test("the chat's own AIs (by name) are AIs, not agents", () => {
  const t = atTree({ people: [{ name: "Claude", family: "assistant" }, { name: "kit", family: "assistant" }], teams: [], ais: ["claude"] });
  assert.deepEqual(t.map((n) => [n.label, n.kids.map((k) => k.label)]), [["Agents", ["kit"]], ["AIs", ["Claude"]]]);
});
