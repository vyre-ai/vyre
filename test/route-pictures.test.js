// @ts-check
// G27: every screen has a picture. Each route of the app (apps/app/scripts/routes.mjs: every screen file that is not the shell or a harness page) has pictures under design-refs/routes/<slug>/, drawn by
// scripts/design-pictures.mjs --routes in the sample world, or is named in test/screens-pictures.json with the reason it has none yet. The list is a ratchet (scripts/team/ratchets.mjs): a new screen without a
// picture fails until the picture is made, naming it here is growth that needs a [ratchet +N: why] in a commit message, and a route whose pictures now exist makes its entry stale, so the list only shrinks.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeList } from "../apps/app/scripts/routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFS = path.join(HERE, "..", "design-refs", "routes");
const FILE = path.join(HERE, "screens-pictures.json");
const SURFACES = ["phone-paper.png", "app-paper.png"];

const has = (/** @type {string} */ slug) => SURFACES.every((f) => fs.existsSync(path.join(REFS, slug, f)));

test("every route has its pictures, or is named in test/screens-pictures.json; a route with pictures leaves the list", () => {
  const routes = routeList();
  const without = routes.filter((r) => !has(r.slug));
  if (process.env.UPDATE_SCREENS_PICTURES === "1") {
    const was = JSON.parse(fs.readFileSync(FILE, "utf8")).routes || {};
    fs.writeFileSync(FILE, JSON.stringify({ _comment: "Routes of the app that have no pictures yet in design-refs/routes (made by: node scripts/design-pictures <out> --routes --update, in CI with [pictures-update]). A ratchet: it may only shrink. A route needing an address example is given one in apps/app/scripts/route-samples.json.", routes: Object.fromEntries(without.map((r) => [r.file, was[r.file] || (r.url ? "its pictures are not made yet" : "it has a parameter and no example address in apps/app/scripts/route-samples.json yet")])) }, null, 1) + "\n");
    return;
  }
  const listed = JSON.parse(fs.readFileSync(FILE, "utf8")).routes;
  assert.deepEqual(without.filter((r) => !(r.file in listed)).map((r) => r.file), [], "these screens have no pictures: run the picture job with [pictures-update] to make them (a new screen cannot ship without one)");
  assert.deepEqual(Object.keys(listed).filter((f) => !without.some((r) => r.file === f)), [], "these routes have pictures now (or are gone): remove them from test/screens-pictures.json");
  console.log(`route pictures: ${routes.length - without.length} of ${routes.length} routes have pictures`);
});
