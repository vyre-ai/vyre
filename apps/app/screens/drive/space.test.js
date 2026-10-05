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

test("shared links: the words, the order, the address, and the three calls to the box", { skip: !strip }, async () => {
  const m = await import("./space-model.ts");
  const { spaceDriveSource } = await import("./space-source.ts");
  const NOW = 1_800_000_000_000, DAY = 86_400_000;
  const row = (/** @type {any} */ o) => ({ code: "c".repeat(22), url: "/v1/files/s?c=" + "c".repeat(22), name: "retainer.pdf", path: "Clients/A/retainer.pdf", version: null, size: 8, made_at: NOW - DAY, expires: NOW + 2 * DAY, opens: 0, active: true, ...o });
  assert.equal(m.linkLine(row({}), NOW), "Works for 2 more days, not opened yet");
  assert.equal(m.linkLine(row({ opens: 1, expires: NOW + 100 }), NOW), "Works for 1 more day, opened 1 time");
  assert.equal(m.linkLine(row({ opens: 3 }), NOW), "Works for 2 more days, opened 3 times");
  assert.match(m.linkLine(row({ active: false, expires: NOW - DAY }), NOW), /^Expired /);
  assert.equal(m.linkLine(row({ active: false }), NOW), "Stopped");
  const sorted = m.linksSorted([row({ code: "a", active: false, made_at: NOW }), row({ code: "b", made_at: NOW - 5 }), row({ code: "c", made_at: NOW - 1 })]);
  assert.deepEqual(sorted.map((l) => l.code), ["c", "b", "a"]);
  assert.equal(m.linkAddress("https://box.example/", row({})), "https://box.example/v1/files/s?c=" + "c".repeat(22));
  const ask = m.linkAsk("retainer.pdf");
  assert.equal(ask.title, "Share retainer.pdf with a link?");
  assert.match(ask.why, /7 days.*copy.*not sealed/s);
  assert.match(m.linkRefusal("too_large", ""), /8 MB/);
  assert.match(m.linkRefusal("no_such_tool", ""), /Update your Vyre/);
  /** @type {any[]} */ const seen = [];
  const src = spaceDriveSource(async (tool, input) => { seen.push({ tool, input }); return { data: tool === "files.drive.link.list" ? { links: [row({})] } : tool === "files.drive.link.revoke" ? { revoked: true } : row({}) }; });
  await src.linkCreate(undefined, "Clients/A/retainer.pdf");
  await src.linkCreate("spc_x", "a/b", 2, 3);
  assert.equal((await src.linkList()).length, 1);
  await src.linkRevoke("c".repeat(22));
  assert.deepEqual(seen.map((x) => x.tool), ["files.drive.link.create", "files.drive.link.create", "files.drive.link.list", "files.drive.link.revoke"]);
  assert.deepEqual(seen[0].input, { path: "Clients/A/retainer.pdf" });
  assert.deepEqual(seen[1].input, { space: "spc_x", path: "a/b", version: 2, days: 3 });
});
