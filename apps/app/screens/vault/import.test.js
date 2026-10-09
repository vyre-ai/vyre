// @ts-check
// The Vault's import page without a screen: what a preview says in words, the calls the page makes (the file's bytes go once; a scan and a move are names and paths), and the words for a refusal.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

const preview = {
  format: "bitwarden-csv", token: "tok", counts: { login: 96, note: 20, card: 3, secret: 0, "api-key": 2, "env-set": 0 },
  add: Array.from({ length: 100 }, (_, i) => `site-${i}`), same: ["a", "b"], conflicts: [{ name: "gmail", existing: "gmail" }], renamed: [{ from: "x", to: "x-2" }], skipped: ["row 4: no password"],
};

test("fifteen places to bring passwords in from, each with how to export and what the picker offers", { skip: !strip }, async () => {
  const { SOURCES } = await import("./import-model.ts");
  assert.equal(SOURCES.length, 15);
  assert.equal(new Set(SOURCES.map((s) => s.id)).size, 15);
  for (const s of SOURCES) { assert.ok(s.name && s.how && s.accept, s.id); assert.ok(!/\bkdbx\b/.test(s.accept), `${s.id}: the encrypted KeePass file is not offered`); }
});

test("a preview in plain words: counts, kinds, the first names, what differs", { skip: !strip }, async () => {
  const { previewView, importLabel, kindsLine } = await import("./import-model.ts");
  const v = previewView(preview);
  assert.equal(v.title, "Bitwarden export, 121 items");
  assert.equal(v.kinds, "96 logins, 20 notes, 3 cards and 2 keys");
  assert.deepEqual([v.fresh, v.here, v.differ], [100, 2, 1]);
  assert.equal(v.names.length, 6);
  assert.equal(v.more, 94);
  assert.deepEqual(v.differs, ["gmail"]);
  assert.deepEqual(v.renamed, ["x will be called x-2, because that name is taken."]);
  assert.equal(importLabel(v, false), "Import 100 items");
  assert.equal(importLabel(v, true), "Import 101 items");
  assert.equal(kindsLine({ login: 1 }), "1 login");
  assert.equal(kindsLine({}), "");
  assert.equal(previewView({ ...preview, add: [], conflicts: [] }).empty, true);
  assert.equal(importLabel(previewView({ ...preview, add: [], conflicts: [] }), true), "Nothing to import");
});

test("the result says what happened and nothing else", { skip: !strip }, async () => {
  const { resultLine } = await import("./import-model.ts");
  const line = resultLine({ format: "x", added: ["a", "b"], updated: ["c"], same: ["d"], conflicts: ["e", "f"], renamed: [], skipped: [] });
  assert.equal(line, "2 items are in your Vault. 1 item got a new version; the old one stays in its history. 1 was already there. 2 items differ and were left as it is.");
});

test("refusals are our words; the box's text shows only for a file it could not read", { skip: !strip }, async () => {
  const { importRefusal } = await import("./import-model.ts");
  assert.match(importRefusal("presence_required", "x"), /Approve on this device/);
  assert.match(importRefusal("locked", "x"), /Unlock the Vault/);
  assert.equal(importRefusal("error", "this is a KeePass database (.kdbx), which is encrypted"), "this is a KeePass database (.kdbx), which is encrypted");
  assert.match(importRefusal("error", ""), /Nothing was changed/);
});

test("the scan groups files by project, biggest first, and warns about a file git holds", { skip: !strip }, async () => {
  const { scanGroups, scanTotals } = await import("./import-model.ts");
  const scan = { scanned: 3, templates: 0, truncated: false, files: [
    { project: "intake", file: "/home/a/intake/.env", secrets: 2, kinds: ["stripe", "openai"], git: { tracked: false, ignored: true } },
    { project: "site", file: "/home/a/site/web/.env.local", secrets: 5, kinds: ["supabase"], git: { tracked: true, ignored: false } },
    { project: null, file: "/home/a/scratch/.env", secrets: 1, kinds: [], git: null },
  ] };
  const g = scanGroups(scan);
  assert.deepEqual(g.map((x) => x.project), ["site", "intake", "a"]);
  assert.equal(g[0].files[0].line, "5 keys: Supabase");
  assert.match(g[0].files[0].warn, /Committed to git/);
  assert.equal(g[1].files[0].line, "2 keys: Stripe, Openai");
  assert.equal(g[1].files[0].warn, "");
  assert.deepEqual(scanTotals(scan), { files: 3, secrets: 8 });
});

/** A fake box that records every call. */
function box() {
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (tool === "vault.import.preview") return { data: preview };
    if (tool === "vault.import" && input.files) return { data: { added: ["p.env"], rewritten: ["/x/.env"], unchanged: [], skipped: [], committed: [] } };
    if (tool === "vault.import") return { data: { format: "bitwarden-csv", added: ["a"], updated: [], same: [], conflicts: [], skipped: [] } };
    if (tool === "vault.env.scan") return { data: { files: [{ project: "p", file: "/x/.env", secrets: 1, kinds: ["stripe"], git: null }], scanned: 1, templates: 0, truncated: false } };
    return { error: { code: "no_such_tool", message: "no" } };
  };
  return { call, seen };
}

test("the page sends the file's bytes once, with the token; a scan and a move are paths only, and the move rewrites", { skip: !strip }, async () => {
  const { importSource } = await import("./import-source.ts");
  const { call, seen } = box();
  const src = importSource(call);
  const file = { name: "bw.csv", base64: "Zm9v" };
  const p = await src.preview(file);
  assert.equal(p.token, "tok");
  assert.deepEqual(seen[0], { tool: "vault.import.preview", input: { content: "Zm9v", filename: "bw.csv" } });
  await src.run(file, p.token, false);
  assert.deepEqual(seen[1], { tool: "vault.import", input: { content: "Zm9v", filename: "bw.csv", token: "tok", conflicts: "skip" } });
  await src.run(file, p.token, true);
  assert.equal(seen[2].input.conflicts, "update");
  const scan = await src.scan();
  assert.equal(scan?.files.length, 1);
  const moved = await src.moveEnv(["/x/.env"]);
  assert.deepEqual(seen[4], { tool: "vault.import", input: { files: ["/x/.env"], rewrite: true } });
  assert.deepEqual(moved.rewritten, ["/x/.env"]);
  assert.ok(!JSON.stringify(seen.slice(3)).includes("content"), "a scan and a move carry no file bytes");
});

test("a box without vault.env.scan answers null, and a refusal carries its code", { skip: !strip }, async () => {
  const { importSource } = await import("./import-source.ts");
  const src = importSource(async () => ({ error: { code: "no_such_tool", message: "no" } }));
  assert.equal(await src.scan(), null);
  await assert.rejects(src.preview({ name: "x.csv", base64: "" }), (e) => /** @type {any} */ (e).code === "no_such_tool");
});
