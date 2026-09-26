// @ts-check
// docs-check: the real docs tree is clean, and each rule catches what it is for, on small fixture
// trees in temp folders. Also the pieces the checker leans on: GitHub-style slugs and the
// reference generator (every tool a manifest declares is on the tools page, and two runs agree).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { check, format } from "../scripts/lib/docs/check.js";
import { slug, slugger } from "../scripts/lib/docs/slug.js";
import { generate, manifests, literalKeys, REPO } from "../scripts/lib/docs/reference.js";
import { FORBIDDEN } from "../scripts/lib/hygiene.js";
import { SCRATCH } from "./scratch.mjs";

const FM = (title = "A page", extra = "") => `---\ntitle: ${title}\nsummary: One sentence.\naudience: users, builders\nowner: docs\nstatus: stable\n${extra}---\n\n`;

/** A docs tree in a temp folder: { "index.md": text, ... } plus nav pages. Returns the root. */
function tree(t, files, { pages = Object.keys(files).filter(f => f.endsWith(".md") && !f.startsWith("work/")), unpublished = ["work/"] } = {}) {
  const root = fs.mkdtempSync(path.join(SCRATCH, "docs-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nav = { site: { title: "t" }, sections: [{ title: "All", pages }], unpublished };
  const all = { "docs/nav.json": JSON.stringify(nav, null, 2), ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k.startsWith("../") ? k.slice(3) : `docs/${k}`, v])) };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const run = async (root, reference = /** @type {any} */ (false)) => format(await check({ root, reference }));
const only = (lines, re) => lines.filter(l => re.test(l));

test("docs-check: the real docs tree is clean", async () => {
  const problems = await check({ root: REPO, tmp: SCRATCH });
  assert.deepEqual(format(problems), []);
});

test("docs-check: a clean fixture has no problems", async t => {
  const root = tree(t, {
    "index.md": FM("Home") + "# Home\n\nSee [install](get-started/install.md#before-you-start) and [below](#two-words).\n\n## Two words\n\n[site](https://docs.vyre.run/get-started/install/) [ext](https://example.com/nowhere) [mail](mailto:alex@example.com)\n",
    "get-started/install.md": FM("Install") + "# Install\n\n## Before you start\n\nBack [home](../index.md).\n",
  });
  assert.deepEqual(await run(root), []);
});

test("docs-check: broken links, anchors, unpublished targets and site paths", async t => {
  const root = tree(t, {
    "index.md": FM() + [
      "# Home", "", "## Twice", "", "## Twice", "",
      "[gone](missing.md)",
      "[bad anchor](other.md#nope)",
      "[good dup](#twice-1)",
      "[bad self](#three)",
      "[internal](work/notes.md)",
      "[site bad](https://docs.vyre.run/not/a/page)",
      "[site good](https://docs.vyre.run/other)",
      "[site anchor](https://docs.vyre.run/other#no-such)",
      "[root bad](/nope/)",
      "`[in code](missing-too.md)`",
      "```", "[in a fence](missing-three.md)", "```",
      "",
    ].join("\n"),
    "other.md": FM() + "# Other\n",
    "work/notes.md": "internal, no front matter needed\n",
  });
  const lines = await run(root);
  assert.equal(only(lines, /missing\.md: no such file/).length, 1);
  assert.equal(only(lines, /other\.md#nope: no heading in docs\/other\.md/).length, 1);
  assert.equal(only(lines, /#twice-1/).length, 0, "a repeated heading gets -1");
  assert.equal(only(lines, /#three: no heading on this page/).length, 1);
  assert.equal(only(lines, /work\/notes\.md: points into an unpublished folder/).length, 1);
  assert.equal(only(lines, /not\/a\/page: no page on docs\.vyre\.run/).length, 1);
  assert.equal(only(lines, /docs\.vyre\.run\/other#no-such: no heading/).length, 1);
  assert.equal(only(lines, /\/nope\/: no page on docs\.vyre\.run/).length, 1);
  assert.equal(only(lines, /missing-too|missing-three/).length, 0, "links in code are not links");
  assert.equal(only(lines, /work\/notes\.md:\d+: .*front matter/).length, 0, "unpublished pages are not checked");
  assert.ok(lines.every(l => /^docs\/index\.md:\d+: /.test(l)), lines.join("\n"));
  assert.ok(only(lines, /missing\.md/)[0].startsWith("docs/index.md:15: "), "the line number is the link's line");
});

test("docs-check: front matter is required and its values are checked", async t => {
  const root = tree(t, {
    "none.md": "# No front matter\n",
    "partial.md": "---\ntitle: Partial\n---\n",
    "values.md": "---\ntitle: V\nsummary: S.\naudience: users, robots\nowner: nobody\nstatus: shipped\nsumary: typo\n---\n",
    "comment.md": "---\ntitle: C\nsummary: S.\naudience: users            # users | builders\nowner: docs   # a team\nstatus: stable\n---\n",
  });
  const lines = await run(root);
  assert.deepEqual(only(lines, /none\.md/), ["docs/none.md:1: no front matter (a --- block with title, summary, audience, owner, status)"]);
  for (const k of ["summary", "audience", "owner", "status"]) assert.ok(lines.includes(`docs/partial.md:1: front matter has no ${k}`), k);
  assert.ok(only(lines, /values\.md:4: audience must be from/).length === 1);
  assert.ok(only(lines, /values\.md:5: owner nobody is not a known team/).length === 1);
  assert.ok(only(lines, /values\.md:6: status must be one of/).length === 1);
  assert.ok(only(lines, /values\.md:7: unknown front matter key sumary/).length === 1);
  assert.deepEqual(only(lines, /comment\.md/), [], "a trailing # comment is not part of the value");
});

test("docs-check: the nav and redirect stubs", async t => {
  const root = tree(t, {
    "a.md": FM() + "# A\n",
    "loose.md": FM() + "# Loose\n",
    "old.md": "---\ntitle: Old\nredirect: a.md\n---\n",
    "older.md": "---\ntitle: Older\nredirect: old.md\n---\n",
    "dead.md": "---\ntitle: Dead\nredirect: nowhere.md\n---\n",
    "fat.md": "---\ntitle: Fat\nredirect: a.md\nsummary: extra\n---\n",
    "listed-stub.md": "---\ntitle: Listed\nredirect: a.md\n---\n",
    "links-stub.md": FM() + "[via stub](old.md#a)\n",
  }, { pages: ["a.md", "ghost.md", "listed-stub.md", "links-stub.md"] });
  const lines = await run(root);
  assert.ok(lines.includes("docs/loose.md:1: not in docs/nav.json (add it, or make it a redirect stub)"));
  assert.ok(only(lines, /^docs\/nav\.json:\d+: ghost\.md is in the nav but there is no such file$/).length === 1);
  assert.ok(only(lines, /^docs\/nav\.json:\d+: listed-stub\.md is a redirect stub/).length === 1);
  assert.ok(only(lines, /older\.md:3: redirects to old\.md, which is itself a redirect/).length === 1);
  assert.ok(only(lines, /dead\.md:3: redirects to nowhere\.md, which does not exist/).length === 1);
  assert.ok(only(lines, /fat\.md:4: a redirect stub has only title and redirect, not summary/).length === 1);
  assert.deepEqual(only(lines, /^docs\/(old|links-stub)\.md/), [], "a stub needs no nav entry, and an anchor through a stub resolves on its target");
});

test("docs-check: em dashes and section signs, in pages and the files they include", async t => {
  const root = tree(t, {
    "a.md": FM() + "# A\n\nOne \u2014 two.\n\nSee \u00a7 5.\n\n<!-- include: ../CHANGELOG.md -->\n\n<!-- include: ../MISSING.md -->\n\n[into the include](#from-the-changelog)\n",
    "../CHANGELOG.md": "# Changelog\n\n## From the changelog\n\nfine\nnot \u2014 fine\n",
  });
  const lines = await run(root);
  assert.ok(lines.includes("docs/a.md:11: em dash; use a colon, a comma or two sentences"));
  assert.ok(lines.includes("docs/a.md:13: section sign; write Section 5.1"));
  assert.ok(lines.includes("CHANGELOG.md:6: em dash; use a colon, a comma or two sentences"));
  assert.ok(lines.includes("docs/a.md:17: includes ../MISSING.md, which does not exist"));
  assert.deepEqual(only(lines, /from-the-changelog/), [], "an included file's headings are anchors on the page");
});

test("docs-check: names, secrets, emails and IP addresses", async t => {
  const name = FORBIDDEN[0];
  const secret = "sk-" + "a1B2".repeat(6);
  const root = tree(t, {
    "a.md": FM() + [
      "# A", "",
      `Ask ${name.charAt(0).toUpperCase() + name.slice(1)} about it.`,
      `token ${secret}`,
      "mail alex@example.com, kit@harlowlegal.com, juno@northwindbakery.com",
      "mail someone@gmail.com",
      "ip 192.0.2.10 198.51.100.7 203.0.113.9 100.101.102.103 127.0.0.1 0.0.0.0 10.1.2.3 192.168.1.20 version 1.2.3",
      "ip 8.8.8.8",
      "",
    ].join("\n"),
  });
  const lines = await run(root);
  assert.ok(only(lines, /a\.md:11: names a real person or business/).length === 1, lines.join("\n"));
  assert.ok(lines.includes("docs/a.md:12: looks like a secret"));
  assert.deepEqual(only(lines, /email address/), ["docs/a.md:14: email address someone@gmail.com is not an example; use @example.com"]);
  assert.deepEqual(only(lines, /IP address/), ["docs/a.md:16: IP address 8.8.8.8 is not in a documentation range; use 192.0.2.x, 198.51.100.x or 203.0.113.x"]);
});

test("docs-check: stale and missing generated pages", async t => {
  const root = tree(t, { "reference/cli.md": FM("CLI", "generated: scripts/gen-docs-reference\n") + "old\n" }, { pages: ["reference/cli.md", "reference/tools.md"] });
  const lines = await run(root, () => ({ "reference/cli.md": FM("CLI", "generated: scripts/gen-docs-reference\n") + "new\n", "reference/tools.md": "x" }));
  assert.ok(lines.includes("docs/reference/cli.md:10: generated page is stale; run npm run docs:ref (edit the code, not the page)"), lines.join("\n"));
  assert.ok(lines.includes("docs/reference/tools.md:1: generated page is missing; run npm run docs:ref"));
});

test("slug: GitHub-style anchors", () => {
  assert.equal(slug("Before you start"), "before-you-start");
  assert.equal(slug("`vault.put` and **bold**"), "vaultput-and-bold");
  assert.equal(slug("What's new? (v0.2)"), "whats-new-v02");
  assert.equal(slug("[A link](x.md) here"), "a-link-here");
  assert.equal(slug("snake_case stays"), "snake_case-stays");
  assert.equal(slug("vyre up"), "vyre-up");
  const s = slugger();
  assert.deepEqual(["x", "x", "x-1", "x"].map(s), ["x", "x-1", "x-1-1", "x-2"]);
});

test("reference: payload keys from an object literal", () => {
  assert.deepEqual(literalKeys("{ lesson: l.id, session, \"quoted\": 1, f(x) { return {nope: 1}; }, ...(d ? { declined: true } : {}) }"),
    { always: ["lesson", "session", "quoted"], sometimes: ["declined"] });
});

test("reference: every declared tool is on the tools page, and the pages are deterministic", () => {
  const a = generate({ root: REPO, tmp: SCRATCH });
  const b = generate({ root: REPO, tmp: SCRATCH });
  assert.deepEqual(a, b);
  const tools = a["reference/tools.md"];
  const missing = manifests(REPO).flatMap(m => (m.manifest.does?.tools || []).filter(t => !tools.includes(`### \`${t}\``)));
  assert.deepEqual(missing, []);
  for (const [rel, text] of Object.entries(a)) {
    assert.ok(text.startsWith("---\ntitle: "), rel);
    assert.ok(text.includes("\ngenerated: scripts/gen-docs-reference\n"), rel);
    assert.ok(!text.includes("\u2014") && !text.includes("\u00a7"), rel);
    assert.ok(!text.includes(SCRATCH), `${rel} leaks the temp home`);
  }
});
