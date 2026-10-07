// @ts-check
// The terms index (scripts/lib/docs/terms.js): what it finds in the code, the mentions it records
// on the real pages, the stale mentions docs-check fails, and the two files it writes. The stale
// rules run on a small fixture tree with a fake CLI, config and module, so each rule is shown
// catching what it is for and leaving placeholders, examples and history alone.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { check, format } from "../scripts/lib/docs/check.js";
import { REPO, generateAll } from "../scripts/lib/docs/reference.js";
import { CONCEPTS, STALE_ALLOWED, known, cliCommands, buildIndex, indexJson, indexPage, staleMentions, INDEX_MD, INDEX_JSON } from "../scripts/lib/docs/terms.js";
import { slugger } from "../scripts/lib/docs/slug.js";
import { SCRATCH } from "./scratch.mjs";

const FM = (title = "A page") => `---\ntitle: ${title}\nsummary: One sentence.\naudience: users\nowner: docs\nstatus: stable\n---\n\n`;

/** A repository in a temp folder: { "docs/x.md": text, "core/...": text }. Pages in docs/ go in the nav. */
function tree(t, files) {
  const root = fs.mkdtempSync(path.join(SCRATCH, "docs-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pages = Object.keys(files).filter(f => f.startsWith("docs/") && f.endsWith(".md")).map(f => f.slice(5));
  const all = { "docs/nav.json": JSON.stringify({ site: { title: "t" }, sections: [{ title: "All", pages }], unpublished: ["work/"] }), ...files };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

// A small Vyre: two commands (one strict), a config with a network section, one module with two
// tools and an event, one environment variable, the Deck's routes and the box wrapper.
const CODE = {
  "core/cli/index.js": "export async function commands() { return []; }\n",
  "core/cli/commands/vault.js": [
    "const SUBS = { list, ls: list, get, put, \"git-credential\": gc };",
    "export default { name: \"vault\", order: 40, usage: \"vyre vault <command>\", summary: \"credentials\", async run(argv) { return 0; } };",
  ].join("\n"),
  "core/cli/commands/daemon.js": [
    "export default [",
    "  { name: \"status\", order: 12, summary: \"is it running\", async run() { return 0; } },",
    "  { name: \"call\", order: 92, usage: \"vyre call [--tty] <tool> [json]\", summary: \"run any tool\", async run() { return 0; } },",
    "  { name: \"open\", order: 22, usage: \"vyre open <project>\", summary: \"a project\", async run() { return 0; } },",
    "];",
  ].join("\n"),
  "core/config/index.js": [
    "/** @typedef {{ tailscale: boolean, address?: string, port?: number }} Network */",
    "/** @typedef {{ name?: string, role: \"box\"|\"local\", network: Network }} Config */",
    "function defaults() { return { role: \"local\", network: { tailscale: false } }; }",
    "export const home = () => process.env.VYRE_HOME;",
  ].join("\n"),
  "core/vault/module.json": JSON.stringify({ name: "vault", version: "0.1.0", does: { tools: ["vault.get", "vault.ssh.keys"] }, watches: { emits: ["vault.unlocked"] } }),
  "core/vault/index.js": [
    "export default { async start(ctx) {",
    "  const opts = (ctx.config && ctx.config.vault) || {};",
    "  if (opts.keystore) ctx.tool(\"vault.get\", {}); ctx.tool(\"vault.ssh.keys\", {});",
    "  ctx.events.emit(\"vault.unlocked\", { at: 1 }); ctx.vault.fetch;",
    "} };",
  ].join("\n"),
  "deck/js/app.js": "const ROUTES = [\n  [\"/now\", \"now\"],\n  [\"/projects/:slug\", \"projects\"],\n];\nconst PLACES = [{ href: \"/now\", label: \"Now\", icon: \"now\", view: \"now\" }];\n",
  "box/vyre": "#!/bin/sh\ncase \"${1:-}\" in\n  update)\n    ;;\n  *)\n    ;;\nesac\n",
};

test("terms: stale mentions fail, placeholders, examples and history do not", async t => {
  const root = tree(t, {
    ...CODE,
    "docs/index.md": FM("Home") + [
      "# Home",
      "",
      "Good: `vyre vault get stripe-live`, `vyre vault ls`, `vyre status`, `vyre update`, `vyre --help`.",
      "Good: `vault.get`, `vault.ssh.keys`, `vault.ssh`, `vault.unlocked`, `vault.keystore`, `vault.fetch`, `network.port`, `VYRE_HOME`.",
      "Good: `vyre call vault.get '{}'`, `vyre call invoices.list`, `vyre open harlow-legal`, `vyre vault <command>`, `vyre <cmd>`.",
      "Good: `vault.json`, `vyre.run`, `ctx.tool`, `VYRE_TEST_*`, `network.<key>`, `/now`, `/projects/harlow-legal`.",
      "",
      "Stale: `vyre upp`.",
      "Stale: `vyre vault reveel stripe-live`.",
      "Stale: `vault.reveel`.",
      "Stale: `vault.ssh.nope`.",
      "Stale: `network.tailscal`.",
      "Stale: `VYRE_NOPE`.",
      "Stale: `vyre call vault.gett`.",
      "Stale on purpose: `vault.reveel` <!-- terms: ignore -->",
      "",
      "```sh",
      "$ vyre vault get stripe-live",
      "VYRE_HOME=/tmp/x vyre stauts",
      "vyre status && vyre vault nope",
      "export VYRE_NOT_READ=1",
      "```",
      "",
      "```json",
      "{ \"vault.nope\": 1, \"VYRE_ALSO_NOT\": 2 }",
      "```",
      "",
    ].join("\n"),
    "docs/adr/0001-old.md": FM("Old") + "# Old\n\nWe removed `vyre upp` and `vault.reveel`.\n",
    "docs/changelog.md": FM("Changes") + "# Changes\n\n- dropped `vyre upp`\n",
    "docs/known-gaps.md": FM("Gaps") + "# Gaps\n\n- `vault.reveel` is not built\n",
  });
  const lines = format(await check({ root, reference: false })).filter(l => /stale mention/.test(l));
  assert.deepEqual(lines, [
    "docs/index.md:16: stale mention: vyre upp is not a command",
    "docs/index.md:17: stale mention: vyre vault reveel: reveel is not a subcommand of vyre vault",
    "docs/index.md:18: stale mention: vault.reveel: no tool, event or config key has this name",
    "docs/index.md:19: stale mention: vault.ssh.nope: no tool, event or config key has this name",
    "docs/index.md:20: stale mention: network.tailscal: no tool, event or config key has this name",
    "docs/index.md:21: stale mention: VYRE_NOPE is not read anywhere in Vyre",
    "docs/index.md:22: stale mention: vyre call vault.gett: there is no tool vault.gett",
    "docs/index.md:27: stale mention: vyre stauts is not a command",
    "docs/index.md:28: stale mention: vyre vault nope: nope is not a subcommand of vyre vault",
    "docs/index.md:29: stale mention: VYRE_NOT_READ is not read anywhere in Vyre",
  ]);
});

test("terms: the allowlist silences a listed mention, and a listed mention that is gone fails", async t => {
  const root = tree(t, { ...CODE, "docs/index.md": FM() + "# A\n\n`vault.reveel`\n" });
  STALE_ALLOWED.push({ page: "index.md", text: "vault.reveel" }, { page: "index.md", text: "vyre gone" });
  try {
    // The real list's entries name pages this tree does not have; only this tree's are asserted.
    const problems = staleMentions(root).filter(p => !/ on (?!index\.md)/.test(p.problem));
    assert.deepEqual(problems.map(p => `${p.file}:${p.line}: ${p.problem}`), [
      "scripts/lib/docs/terms.js:1: STALE_ALLOWED lists `vyre gone` on index.md, which is no longer there; take it off the list",
    ]);
  } finally { STALE_ALLOWED.splice(-2, 2); }
});

test("terms: a tree with no code has no stale mentions to check", async t => {
  const root = tree(t, { "docs/index.md": FM() + "# A\n\n`vyre upp` `vault.reveel`\n" });
  assert.deepEqual(staleMentions(root), []);
});

test("terms: the index records each mention's page, line and heading anchor", async t => {
  const root = tree(t, {
    ...CODE,
    "docs/index.md": FM("Home") + [
      "# Home",
      "",
      "The vault keeps items; `vault.get` reads one.",
      "",
      "## Twice",
      "",
      "Run `vyre vault get x`, see `/projects/harlow-legal`.",
      "",
      "## Twice",
      "",
      "```sh",
      "vyre status",
      "VYRE_HOME=/tmp/h vyre call vault.get",
      "```",
      "",
      "> [!SNAG] It hangs",
      "> `network.port` is taken.",
      "",
    ].join("\n"),
  });
  const things = buildIndex({ root });
  const get = (kind, name) => /** @type {any} */ (things.find(x => x.kind === kind && x.name === name));
  assert.deepEqual(get("tool", "vault.get").mentions, [
    { page: "index.md", line: 11, anchor: "home" },
    { page: "index.md", line: 21, anchor: "twice-1" },
  ]);
  assert.equal(get("tool", "vault.get").definedIn, "core/vault/index.js");
  assert.deepEqual(get("command", "vyre vault get").mentions, [{ page: "index.md", line: 15, anchor: "twice" }]);
  assert.deepEqual(get("command", "vyre vault").mentions, [{ page: "index.md", line: 15, anchor: "twice" }]);
  assert.deepEqual(get("command", "vyre status").mentions.map(m => m.line), [20]);
  assert.deepEqual(get("command", "vyre update").definedIn, "box/vyre");
  assert.deepEqual(get("env", "VYRE_HOME").mentions.map(m => m.line), [21]);
  assert.deepEqual(get("config", "network.port").mentions, [{ page: "index.md", line: 25, anchor: "it-hangs" }]);
  assert.deepEqual(get("config", "vault.keystore").definedIn, "core/vault/index.js");
  assert.deepEqual(get("concept", "vault").mentions.map(m => m.line), [11]);
  assert.deepEqual(get("event", "vault.unlocked").mentions, []);

  const json = JSON.parse(indexJson(things));
  assert.equal(json.things.length, things.length);
  assert.equal(json.counts.tool, 2);
  const md = indexPage(things);
  assert.ok(md.includes("- `vault.get` tool, not explained on any page yet. 2 mentions: index.md [11](../index.md#home), [21](../index.md#twice-1)"), md);
});

test("terms: the real tree", async () => {
  const k = known(REPO);
  // The commands read from the files are the ones the CLI loads, plus help, version and the box's own.
  const { commands } = await import("../core/cli/index.js");
  const loaded = new Set((await commands()).map(c => c.name));
  const read = cliCommands(REPO).filter(c => c.file.startsWith("core/cli/commands/")).map(c => c.name);
  assert.deepEqual(read, [...loaded].sort());
  for (const c of cliCommands(REPO).filter(x => x.strict)) assert.ok(c.subs.length, `vyre ${c.name} has subcommands`);
  assert.ok(k.cmd.get("vault")?.subs.includes("get"));
  assert.ok(k.cmd.get("box")?.subs.includes("update"));
  assert.ok(k.cmd.has("update") && k.cmd.has("logs"), "the box wrapper's commands");

  // Every concept's page, anchor and code file exist.
  for (const c of CONCEPTS) {
    const [page, anchor] = c.page.split("#");
    const file = path.join(REPO, "docs", page);
    assert.ok(fs.existsSync(file), `${c.name}: ${page}`);
    if (anchor) {
      const slug = slugger(), text = fs.readFileSync(file, "utf8");
      const anchors = [...text.matchAll(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/gm)].map(m => slug(m[1]));
      assert.ok(anchors.includes(anchor), `${c.name}: no #${anchor} in ${page}`);
    }
    if (c.code) assert.ok(fs.existsSync(path.join(REPO, c.code)), `${c.name}: ${c.code}`);
  }
  for (const s of k.screens) {
    assert.ok(fs.existsSync(path.join(REPO, s.file)), s.file);
    assert.ok(fs.existsSync(path.join(REPO, "docs", s.page.split("#")[0])), s.page);
  }
});

test("terms: the committed index is what the code and the pages make, and is deterministic", () => {
  const a = generateAll({ root: REPO, tmp: SCRATCH });
  const b = generateAll({ root: REPO, tmp: SCRATCH });
  assert.equal(a[INDEX_JSON], b[INDEX_JSON]);
  assert.equal(a[INDEX_MD], b[INDEX_MD]);
  assert.equal(fs.readFileSync(path.join(REPO, "docs", INDEX_JSON), "utf8"), a[INDEX_JSON], "run npm run docs:ref");
  assert.equal(fs.readFileSync(path.join(REPO, "docs", INDEX_MD), "utf8"), a[INDEX_MD], "run npm run docs:ref");
  const json = JSON.parse(a[INDEX_JSON]);
  // no "screen": the Deck is removed in 0.2.9 and its views are no longer listed (scripts/lib/docs/terms.js screens)
  for (const kind of ["command", "tool", "event", "config", "env", "concept"]) assert.ok(json.counts[kind] > 0, kind);
  const tools = new Set(json.things.filter(t => t.kind === "tool").map(t => t.name));
  for (const t of known(REPO).tools.keys()) assert.ok(tools.has(t), t);
  for (const t of json.things) {
    assert.ok(t.kind && t.name && Array.isArray(t.mentions), JSON.stringify(t).slice(0, 80));
    if (t.kind === "tool") assert.match(String(t.page), /^reference\/tools\.md#/, t.name);
  }
  assert.ok(!a[INDEX_MD].includes("\u2014") && !a[INDEX_MD].includes("\u00a7"));
});
