import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { settingsGroups } from "./logic.js";
import { SETTINGS_ITEMS } from "../shell/settings-items.js";
import { REPO_URL, starNote, starPlan } from "./about-model.js";

/** Entries whose screen lands from another branch: tags-wire adds the /u/tags index (a5e1b796e). Remove it from here once that merges. */
const EXPECTED_FROM_TAGS_WIRE = ["/u/tags"];
const APP = new URL("../../app", import.meta.url).pathname;

/** True when expo-router would find a screen for this path: a file, a folder's index, or a [dynamic] sibling. */
function resolves(href) {
  let dir = APP;
  const parts = href.split("?")[0].split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const dyn = names.find((n) => /^\[[^\]]+\](\.tsx)?$/.test(n));
    if (last) {
      if (names.includes(parts[i] + ".tsx")) return true;
      const sub = path.join(dir, parts[i]);
      if (fs.existsSync(sub) && fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, "index.tsx"))) return true;
      return Boolean(dyn);
    }
    if (names.includes(parts[i]) && fs.statSync(path.join(dir, parts[i])).isDirectory()) dir = path.join(dir, parts[i]);
    else if (dyn && fs.existsSync(path.join(dir, dyn)) && fs.statSync(path.join(dir, dyn)).isDirectory()) dir = path.join(dir, dyn);
    else return false;
  }
  return false;
}

test("the route check finds real screens and refuses a missing one", () => {
  assert.ok(resolves("/u/settings/account"));
  assert.ok(resolves("/u/about"));
  assert.ok(!resolves("/u/settings/nothing-here-xyz"));
});

test("every row on the Settings home opens a screen that exists", () => {
  for (const role of [undefined, "owner", "member", "temp"]) {
    for (const g of settingsGroups("Space", role)) for (const r of g.rows) assert.ok(resolves(r[2]), `${r[0]} points at ${r[2]}, which has no screen`);
  }
});

test("every entry in the Settings panel opens a screen that exists, and has a place on the home", () => {
  const home = settingsGroups("Space").flatMap((g) => g.rows).map((r) => r[2]);
  for (const i of SETTINGS_ITEMS) {
    if (EXPECTED_FROM_TAGS_WIRE.includes(i.href)) continue;
    assert.ok(resolves(i.href), `${i.label} points at ${i.href}, which has no screen`);
    assert.ok(home.includes(i.href) || i.href === "/u/spaces", `${i.label} (${i.href}) is in the panel but not on the Settings home`);
  }
  const hrefs = SETTINGS_ITEMS.map((i) => i.href);
  assert.equal(new Set(hrefs).size, hrefs.length, "two panel entries open the same screen");
});

test("every Settings row says in one line what it is", () => {
  for (const g of settingsGroups("Space")) for (const r of g.rows) {
    assert.ok(r[1] && r[1].length > 12, `${r[0]} has no description`);
    assert.ok(!/[\u2014\u00a7]/.test(r[1]), `${r[0]} uses a banned character`);
  }
});

test("About names no person and links the repository", () => {
  assert.equal(REPO_URL, "https://github.com/vyre-ai/vyre");
  for (const f of ["AboutCard.tsx", "about-model.js", "StarOnGithub.tsx"]) {
    const src = fs.readFileSync(new URL("./" + f, import.meta.url), "utf8").replace(REPO_URL, "");
    assert.ok(!/vyre-ai/i.test(src.replace(/^\s*\/\/.*$/gm, "")), `${f} shows an org name`);
  }
});

test("Star stars only for a connected account that has not starred, and otherwise opens the repo", () => {
  assert.equal(starPlan({ connected: true, starred: false }).action, "star");
  assert.equal(starPlan({ connected: true, starred: true }).action, "none");
  assert.equal(starPlan({ connected: true, starred: null }).action, "open");
  assert.equal(starPlan({ connected: false, starred: null }).action, "open");
  assert.equal(starPlan(null).action, "open");
  assert.ok(starNote(starPlan(null)).includes("GitHub"));
});

test("nothing stars on its own: the star tool is called only from a press", () => {
  const src = fs.readFileSync(new URL("./StarOnGithub.tsx", import.meta.url), "utf8");
  const calls = src.split('tool("github.star")').length - 1;
  assert.equal(calls, 1);
  assert.ok(/const press = async/.test(src) && src.indexOf('tool("github.star")') > src.indexOf("const press = async"));
  assert.ok(!/useEffect\([^)]*github\.star["']\)/.test(src));
});
