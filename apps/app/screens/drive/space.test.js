// @ts-check
// The space's Drive against the box's shapes: folders from paths, the calls and their inputs, upload paths and refusals.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return o[tool] ?? { data: {} }; };
  return { call, seen };
}

test("folders are the first step of a path below the one you are in, folders first, and a file says its version", { skip: !strip }, async () => {
  const m = await import("./space-model.ts");
  const e = [{ path: "Clients/A/retainer.pdf", size: 2048, ver: 3, at: 1_790_000_000_000 }, { path: "Clients/B/x.txt", size: 5 }, { path: "notes.md", size: 10 }, { path: "Clients/readme.txt", size: 7 }];
  assert.deepEqual(m.children(e, "").map((i) => [i.name, i.dir]), [["Clients", true], ["notes.md", false]]);
  assert.deepEqual(m.children(e, "Clients").map((i) => [i.name, i.dir, i.path]), [["A", true, "Clients/A"], ["B", true, "Clients/B"], ["readme.txt", false, "Clients/readme.txt"]]);
  const f = m.children(e, "Clients/A")[0];
  assert.match(m.itemLine(f), /^2 KB, .*2026, version 3$/);
  assert.equal(m.itemLine(m.children(e, "")[0]), "");
});

test("list pages through next, upload sends base64 and the version it came from, restore is its own call", { skip: !strip }, async () => {
  const { spaceDriveSource } = await import("./space-source.ts");
  let n = 0;
  const b = box({ "files.drive.space.list": undefined });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    b.seen.push({ tool, input });
    if (tool === "files.drive.space.list") { n++; return { data: n === 1 ? { entries: [{ path: "a" }], next: "a" } : { entries: [{ path: "b" }], next: null } }; }
    if (tool === "files.drive.versions") return { data: { path: "a", versions: [{ ver: 1, size: 1, at: 1 }] } };
    return { data: { path: "a", version: 2, conflict: false, size: 1 } };
  };
  const s = spaceDriveSource(call);
  const l = await s.list(undefined, "");
  assert.deepEqual(l.entries.map((x) => x.path), ["a", "b"]);
  assert.deepEqual(b.seen[1], { tool: "files.drive.space.list", input: { prefix: "", limit: 500, after: "a" } });
  await s.upload(undefined, "Clients/a.txt", "QQ==", 1); await s.restore(undefined, "a", 1);
  assert.deepEqual(b.seen.slice(-2), [{ tool: "files.drive.upload", input: { path: "Clients/a.txt", base64: "QQ==", base: 1 } }, { tool: "files.drive.restore", input: { path: "a", version: 1 } }]);
  assert.equal((await s.versions(undefined, "a"))[0].ver, 1);
});

test("an upload path is checked before the box is asked, bytes become base64, and refusals get plain words", { skip: !strip }, async () => {
  const m = await import("./space-model.ts");
  assert.deepEqual(m.uploadPath("Clients/A", " a.pdf "), { path: "Clients/A/a.pdf" });
  assert.deepEqual(m.uploadPath("", "a.pdf"), { path: "a.pdf" });
  for (const bad of ["", "a/b", "..", "a\\b"]) assert.ok("error" in m.uploadPath("", bad), bad);
  assert.equal(m.toBase64(new Uint8Array([72, 105])), "SGk=");
  assert.equal(m.toBase64(new Uint8Array([1, 2, 3])), "AQID");
  assert.match(m.spaceDriveRefusal("unavailable", ""), /no Drive yet/);
  assert.match(m.spaceDriveRefusal("too_large", ""), /8 MB/);
  assert.match(m.spaceDriveRefusal("presence_required", ""), /Approve on this device/);
  assert.match(m.versionLine({ ver: 3, size: 10, at: 0 }, 3), /^Version 3, current, 10 B$/);
});
