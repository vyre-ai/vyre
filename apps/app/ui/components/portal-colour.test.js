import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mirrorVars } from "../lib/root-vars.js";

// Dark mode, live: every menu and picker drew its item text dark on the dark panel. The panels take their fill from the theme as a style, but the text took a
// class (text-text = var(--text)), and on the web the menu is portalled to <body>, where the only custom properties are the ones mirrored on <html>. The unlock
// cover mounts its own ThemeProvider; when it closed, its cleanup removed every property from <html> while the app's provider stayed up, so the text had no colour.

const fakeStyle = () => {
  const props = new Map();
  return { props, setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) };
};

test("a nested provider that goes away hands <html> back to the one under it", () => {
  const s = fakeStyle();
  const releaseApp = mirrorVars(s, { "--text": "#F1EEE6", "--surface-3": "#222" });
  const releaseCover = mirrorVars(s, { "--text": "#F1EEE6", "--surface-3": "#222" });
  releaseCover();
  assert.equal(s.props.get("--text"), "#F1EEE6", "the app's text colour is still on <html>");
  assert.equal(s.props.get("--surface-3"), "#222");
  releaseApp();
  assert.equal(s.props.size, 0, "the last provider out clears it");
});

test("the outer provider going first leaves the inner one's values, and a key only it had is removed", () => {
  const s = fakeStyle();
  const outer = mirrorVars(s, { "--text": "#111", "--only-outer": "1" });
  const inner = mirrorVars(s, { "--text": "#222" });
  outer();
  assert.equal(s.props.get("--text"), "#222");
  assert.equal(s.props.has("--only-outer"), false);
  inner();
  inner();
  assert.equal(s.props.size, 0, "a second release is a no-op");
});

test("a theme change (release then mirror again) keeps the new values on <html>", () => {
  const s = fakeStyle();
  const app = mirrorVars(s, { "--text": "#F1EEE6" });
  const cover = mirrorVars(s, { "--text": "#F1EEE6" });
  app();
  const app2 = mirrorVars(s, { "--text": "#141311" });
  cover();
  assert.equal(s.props.get("--text"), "#141311", "paper text after the switch, with the cover gone");
  app2();
});

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("the ThemeProvider mirrors through mirrorVars and never removes properties itself", () => {
  const theme = read("../theme.tsx");
  assert.ok(/mirrorVars\(document\.documentElement\.style, ctx\.map\)/.test(theme), "theme.tsx uses mirrorVars on <html>");
  assert.ok(!/removeProperty/.test(theme), "no removeProperty in theme.tsx: a nested provider must not wipe <html>");
});

test("menu, option and picker text takes the theme's colour as a style: no Text with a class in the portalled lists", () => {
  for (const f of ["./Menu.tsx", "./PickerList.tsx", "./Select.tsx", "./Sheet.web.tsx"]) {
    const src = read(f);
    const texts = src.match(/<Text\b[^>]*>/g) || [];
    for (const t of texts) assert.ok(!/\bclassName=/.test(t), `${f}: ${t} takes a class; give it a tone and a style so its colour comes from the theme`);
  }
  // The fast path of Text resolves the tone against the theme in force (the context), never at module load.
  const text = read("./Text.tsx");
  assert.ok(/color: ctx\.color\[TONE\[tone\] \?\? "text"\]/.test(text), "Text's colour is the context's theme colour");
});

test("a long Select opens a searchable list; the time zone list is long enough to get it", async () => {
  const src = read("./Select.tsx");
  assert.ok(/export const SEARCH_FROM = \d+/.test(src));
  assert.ok(/search \?\? options\.length > SEARCH_FROM/.test(src), "search is on by default past SEARCH_FROM");
  assert.ok(/filterItems\(all, query, all\.length\)/.test(src), "the query filters every option, uncapped");
  const from = Number(/SEARCH_FROM = (\d+)/.exec(src)[1]);
  const { zoneOptions } = await import("../../screens/spaces/zone-model.js");
  const zones = zoneOptions("Pacific/Nauru");
  assert.ok(zones.length > from, `${zones.length} zones: searchable`);
  const { filterItems } = await import("../lib/picker-model.js");
  const items = zones.map(([v, l]) => ({ key: v, label: l }));
  assert.deepEqual(filterItems(items, "nauru", items.length).map((i) => i.key), ["Pacific/Nauru"]);
});
