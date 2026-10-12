import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeTag } from "../state/space-name.js";
import { tagFor, spaceOfUrn } from "./place-tag.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const walk = (/** @type {string} */ d, /** @type {string[]} */ out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === "node_modules") continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };

test("one function says where a thing lives: her own home, her own cloud, or the team space's name", () => {
  assert.equal(placeTag({ id: "spc_aaaaaaaaaaaa", label: "personal", tier: "basic" }), "Personal - Home");
  assert.equal(placeTag({ id: "spc_aaaaaaaaaaaa", label: "personal", tier: "cloud" }), "Personal - Cloud");
  assert.equal(placeTag({ id: "spc_bbbbbbbbbbbb", displayName: "Acme", tier: "cloud" }), "Acme", "a team space says its own name, not \"Acme's Cloud\"");
  assert.equal(placeTag({ id: "spc_bbbbbbbbbbbb", name: "acme.vyre.run" }), "acme");
  assert.equal(placeTag({ id: "spc_bbbbbbbbbbbb", displayName: "Northwind's Cloud", tier: "cloud" }), "Northwind");
  assert.equal(placeTag({ id: "spc_cccccccccccc", name: "spc_cccccccccccc" }), "Space", "never an id");
});

test("a thing from the team space carries the space's name and her own carries the right Personal tag", () => {
  const cards = [{ id: "spc_home", tag: "Personal - Home" }, { id: "spc_team", tag: "Acme" }, { id: "spc_cloud", tag: "Personal - Cloud" }];
  assert.equal(tagFor(cards, "spc_team", "all"), "Acme", "a thing that names its space");
  assert.equal(tagFor(cards, "showing", "spc_team"), "Acme", "the space showing");
  assert.equal(tagFor(cards, "home", "spc_team"), "Personal - Home", "her own home's things, whichever space shows");
  assert.equal(tagFor([cards[1], cards[2]], "home", "spc_team"), "Personal - Cloud");
  assert.equal(tagFor(cards, "showing", "all"), null, "nothing under All spaces");
  assert.equal(tagFor([], "home", "all"), null);
});

test("the ten own-home screens, the routed ones and the sidebar draw the tag", () => {
  const src = walk(path.join(APP, "screens")).filter((f) => /\.tsx$/.test(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
  assert.ok((src.match(/<PlaceTag of="home" \/>/g) || []).length >= 10, "ten screens show her own home's tag");
  for (const routed of ["Projects", "Flows", "Chat"]) assert.ok(src.includes('<PlaceTag of="showing" />'), `${routed} shows the space's tag`);
  const shell = fs.readFileSync(path.join(APP, "ui/components/SpaceSwitcherTitle.tsx"), "utf8");
  assert.ok(/SpaceTag text=\{cur\.tag\}/.test(shell), "the sidebar's space title carries it");
  assert.ok(!/OwnHomeNotice|yours, not the team/i.test(src), "the banner is gone");
});

test("the rows carry it too: chats (the block list), projects, a project's files, her vault items, her own assistants", () => {
  const read = (/** @type {string} */ f) => fs.readFileSync(path.join(APP, f), "utf8");
  assert.ok(/tagOf\(x\) \? <SpaceTag text=\{tagOf\(x\)\} \/>/.test(read("ui/blocks/BlockViews.tsx")), "every block list row draws its tag (its own, else the list's)");
  assert.ok(/content: \{ \.\.\.\(tag \? \{ tag \} : \{\}\)/.test(read("screens/chats/ChatsList.tsx")), "the chats list gives its rows the tag of where they live");
  assert.ok(/tagOf=\{\(sid\) => tagFor\(cards, sid \|\| showing, showing\)\}/.test(read("screens/projects/ProjectsScreen.tsx")) && /tagOf && tagOf\(spaceId\(i\)\)/.test(read("ui/tasks/ProjectsList.tsx")), "projects: each row says its own space, so a mixed list is right");
  assert.ok(/tag: tagFor\(cards, spaceOfUrn\(r\.urn\) \|\| showing, showing\)/.test(read("screens/records/RecordsBlock.tsx")) && /<SpaceTag text=\{String\(r\.tag\)\} \/>/.test(read("ui/blocks/TypedTable.tsx")), "records rows carry the tag of the space their address names");
  for (const f of ["screens/projects/ProjectPanes.tsx", "screens/vault/RealVault.tsx", "screens/settings/RealAgents.tsx", "screens/drive/RealDrive.tsx", "screens/drive/SpaceDrive.tsx", "screens/find/FindPanel.tsx"]) assert.ok(/<SpaceTag text=/.test(read(f)), `${f} tags its rows`);
});

test("a record's address names its space, so a mixed list tags each row right", () => {
  assert.equal(spaceOfUrn("vyre://spc_abcdefghijkl/contact/01a1"), "spc_abcdefghijkl");
  assert.equal(spaceOfUrn("not an address"), "");
  const cards = [{ id: "spc_abcdefghijkl", tag: "Acme" }, { id: "spc_mnopqrstuvwx", tag: "Personal - Cloud" }];
  assert.equal(tagFor(cards, spaceOfUrn("vyre://spc_mnopqrstuvwx/note/9") || "showing", "all"), "Personal - Cloud");
});
