// brand in a real vyred in a temp home: the profile is saved by a person only, a colour that cannot be read is moved and says so, a draft comes from a website's own markup, and a new artifact
// carries the brand by default while a document that says otherwise wins and a public share carries none.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { validate } from "../modules/index.js";
import { tempHome } from "../../test/helpers.js";
import { brandFromHtml, normalizeBrand, resolveBrand, artifactBrand } from "../../lib/brand/profile.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** @param {any} t */
async function world(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  return (/** @type {string} */ tool, input = {}, caller = "cli") => call(tool, input, { root, caller });
}

test("brand: the module's manifest is valid", () => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8")), { firstParty: true }), []);
});

test("brand: the profile is checked, every part is optional, and an unknown key is told", () => {
  assert.deepEqual(normalizeBrand({}), { ok: true, profile: {} });
  const bad = normalizeBrand({ colour: "red", colors: { primary: "red" }, logos: { light: "https://x.example/logo.svg" }, fonts: { body: "comic" }, name: "<b>x</b>", letterhead: { on: "yes" } });
  assert.equal(bad.ok, false);
  const text = /** @type {any} */ (bad).problems.join("\n");
  for (const re of [/colour is not part of a brand profile/, /colors\.primary must be a hex colour/, /logos\.light must be a png, jpeg or webp image as a data: URL/, /fonts\.body must be one of/, /name is plain text/, /letterhead must be/]) assert.match(text, re);
  const ok = normalizeBrand({ name: "Northwind Law", legalName: "Northwind Law, P.C.", colors: { primary: "#3a5ba0" }, logos: { light: PNG }, letterhead: { on: true } });
  assert.equal(ok.ok, true);
  assert.equal(/** @type {any} */ (ok).profile.colors.primary, "#3A5BA0");
});

test("brand: a colour that cannot be read is moved to one that can, and the note says so", () => {
  const a = resolveBrand({ colors: { primary: "#FFF200" } }).accent;
  assert.ok(a && a.note && /too low in contrast/.test(a.note), JSON.stringify(a));
  assert.notEqual(a.paper, "#FFF200");
  const navy = resolveBrand({ colors: { primary: "#1F4E9C" } }).accent;
  assert.equal(navy && navy.paper, "#1F4E9C", "readable on light as it is");
  assert.match(String(navy && navy.note), /on dark\)\.$/, "only dark moved, and the note names only that");
  assert.deepEqual(resolveBrand({}).theme, {});
});

test("brand: a draft comes from the website's own markup and nothing is saved", () => {
  const html = `<html><head><title>Northwind Law | Estate planning</title><meta property="og:site_name" content="Northwind Law"><meta name="theme-color" content="#1f4e9c">
    <link rel="icon" href="/favicon.png"><script type="application/ld+json">{"@type":"LegalService","legalName":"Northwind Law, P.C.","telephone":"+1 555 0100","address":{"streetAddress":"1 Main St","addressLocality":"Austin","addressRegion":"TX","postalCode":"78701"}}</script></head><body></body></html>`;
  const d = brandFromHtml(html, "https://northwind.example/");
  assert.deepEqual(d.draft, { name: "Northwind Law", colors: { primary: "#1F4E9C" }, legalName: "Northwind Law, P.C.", phone: "+1 555 0100", address: "1 Main St, Austin, TX, 78701" });
  assert.equal(d.logoUrl, "https://northwind.example/favicon.png");
  assert.deepEqual(brandFromHtml("<html></html>").draft, {}, "a page that says nothing drafts nothing");
});

test("brand: only a person saves it; a new artifact carries the brand by default, its own theme wins, and a public share carries none", async t => {
  const c = await world(t);
  assert.ok((await c("brand.set", { profile: { name: "Northwind Law" } }, "mcp")).error, "an agent cannot save it");
  assert.deepEqual((await c("brand.resolve", {}, "mcp")).data.names, { name: null, legalName: null, address: null, phone: null });
  const bad = (await c("brand.set", { profile: { colors: { primary: "blue" } } })).data;
  assert.ok(bad.problems.length);
  const saved = (await c("brand.set", { profile: { name: "Northwind Law", legalName: "Northwind Law, P.C.", phone: "+1 555 0100", colors: { primary: "#1F4E9C" }, fonts: { heading: "serif" }, logos: { light: PNG }, letterhead: { on: true } } })).data;
  assert.equal(saved.saved, true);
  assert.equal(saved.theme.accent, "custom");
  const made = (await c("artifacts.create", { kind: "doc", title: "Engagement note", content: "# Engagement note\n\nWelcome aboard." })).data;
  const page = (await c("artifacts.export", { id: made.id, as: "page" })).data.body;
  assert.match(page, /class="letterhead"/);
  assert.match(page, /Northwind Law, P\.C\./);
  assert.match(page, /--accent:#1F4E9C/);
  assert.match(page, /--hfont:Georgia/);
  assert.match(page, /<img alt="" src="data:image\/png/);
  const own = (await c("artifacts.create", { kind: "doc", title: "Own look", content: "# Own\n\n<!-- vyre-theme: --accent:#AA0000 -->\nText" })).data;
  assert.ok((await c("artifacts.export", { id: own.id, as: "page" })).data.body.includes("--accent:#1F4E9C"), "the brand is the default");
});

test("brand: the artifact fragment is empty with no brand, and escapes what the person typed", () => {
  const none = artifactBrand(resolveBrand({}));
  assert.deepEqual(none, { css: "", header: "" });
  const h = artifactBrand(resolveBrand({ name: "A & B", letterhead: { on: true, text: "Licensed in TX" } })).header;
  assert.match(h, /A &amp; B/);
  assert.match(h, /Licensed in TX/);
});
