// @ts-check
// Drive's real source against a fake box: shares, a folder a page at a time, a text file's first chunk, and the refusals.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const b64 = (/** @type {string} */ s) => Buffer.from(s, "utf8").toString("base64");

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o[tool]) return o[tool];
    if (tool === "files.drive.status") return { data: { enabled: false, why: "the tailnet policy does not let this box share folders", access: "ro", shares: [{ name: "projects", path: "/work", access: "ro", shared: false }], list: [] } };
    if (tool === "files.drive.list") return input.offset ? { data: { share: input.share, path: input.path, entries: [{ name: "notes.md", dir: false, kind: "text", mime: "text/markdown", size: 11, mtime: "2026-10-01T10:00:00.000Z" }], total: 3 } }
      : { data: { share: input.share, path: input.path, total: 3, next: 2, entries: [{ name: "Harlow Legal", dir: true, kind: "folder", mime: "inode/directory", size: 0, mtime: "2026-10-01T10:00:00.000Z" }, { name: "Trail map.pdf", dir: false, kind: "pdf", mime: "application/pdf", size: 2200000, mtime: "2026-09-20T10:00:00.000Z" }] } };
    if (tool === "files.drive.read") return { data: { share: input.share, path: input.path, kind: "text", mime: "text/markdown", size: 11, mtime: "2026-10-01T10:00:00.000Z", offset: 0, length: 11, base64: b64("Hi Kit, é ok"), done: true } };
    return { data: {} };
  };
  return { call, seen };
}

test("status gives the offered folders and why sharing is off", { skip: !strip }, async () => {
  const { driveSource } = await import("./source.ts");
  const b = box();
  const s = await driveSource(b.call).statusReal();
  assert.deepEqual(b.seen, [{ tool: "files.drive.status", input: {} }]);
  assert.deepEqual([s.enabled, s.shares.map((x) => x.name), /tailnet policy/.test(s.why ?? "")], [false, ["projects"], true]);
});

test("a folder is listed a page at a time, and the next page continues it", { skip: !strip }, async () => {
  const { driveSource } = await import("./source.ts");
  const { entryLine, join, crumbs, parent } = await import("./real-model.ts");
  const b = box();
  const d = driveSource(b.call);
  const p1 = await d.listReal("projects", "/Harlow Legal");
  assert.equal(p1.next, 2);
  const p2 = await d.listReal("projects", "/Harlow Legal", p1.next);
  assert.deepEqual(b.seen.map((s) => s.input.offset), [0, 2]);
  assert.deepEqual([...p1.entries, ...p2.entries].map((e) => e.name), ["Harlow Legal", "Trail map.pdf", "notes.md"]);
  assert.match(entryLine(p1.entries[1]), /^2\.1 MB, /);
  assert.match(entryLine(p1.entries[0]), /2026$/);
  assert.equal(join("/Harlow Legal", "Doe estate"), "/Harlow Legal/Doe estate");
  assert.equal(join("", "a"), "/a");
  assert.equal(parent("/a/b"), "/a");
  assert.deepEqual(crumbs("projects", "/a/b"), [{ name: "projects", path: "" }, { name: "a", path: "/a" }, { name: "b", path: "/a/b" }]);
});

test("a text file's first chunk reads as UTF-8 text, and a bad byte is a replacement mark, not an error", { skip: !strip }, async () => {
  const { driveSource } = await import("./source.ts");
  const { textOf, bytesOf, isText } = await import("./real-model.ts");
  const b = box();
  const c = await driveSource(b.call).readReal("projects", "/notes.md");
  assert.deepEqual(b.seen, [{ tool: "files.drive.read", input: { share: "projects", path: "/notes.md", offset: 0, length: 65536 } }]);
  assert.equal(textOf(bytesOf(c.base64)), "Hi Kit, é ok");
  assert.equal(textOf([72, 0xff, 105]), "H�i");
  assert.deepEqual([isText({ mime: "text/markdown", kind: "text" }), isText({ mime: "application/pdf", kind: "pdf" })], [true, false]);
});

test("a hidden or missing folder is one plain refusal that keeps its code", { skip: !strip }, async () => {
  const { driveSource } = await import("./source.ts");
  const { driveRefusal } = await import("./real-model.ts");
  const b = box({ "files.drive.list": { error: { code: "not_available", message: "not available" } } });
  await assert.rejects(driveSource(b.call).listReal("projects", "/secret"), (/** @type {any} */ e) => e.code === "not_available" && /not available on your home/.test(driveRefusal(e.code, e.message)));
});

test("the real Drive has one Shared tab, and no separate Shared links tab", async () => {
  const { REAL_TABS } = await import("./tabs.js");
  const names = REAL_TABS.map(([k]) => k);
  assert.ok(names.includes("shared"));
  assert.ok(!names.includes("links"));
  assert.ok(!REAL_TABS.some(([, label]) => label === "Shared links"));
});
