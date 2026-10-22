// @ts-check
// Removing a Space whose server does not answer clears every place this computer kept it: the pairing, the shell, the host's Spaces and the saved root.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("Remove clears the pairing, the kept shell, the host's Spaces and the saved root, then the next Space is the one left", { skip: !strip }, async () => {
  const { dropSpaceHere } = await import("./drop-space.ts");
  /** @type {string[]} */ const pairings = ["boxa", "boxb"];
  let shell = { v: /** @type {const} */ (1), at: 1, space: "spc_bbbbbbbbbbbb", data: { me: { name: "Ada" }, spaces: [{ id: "spc_aaaaaaaaaaaa", name: "Cedar", server: "boxa" }, { id: "spc_bbbbbbbbbbbb", name: "Birch", server: "boxb" }] } };
  let host = { spaces: [{ id: "spc_aaaaaaaaaaaa", paired: { box: "boxa" } }, { id: "spc_bbbbbbbbbbbb", paired: { box: "boxb" } }], current: "spc_bbbbbbbbbbbb" };
  /** @type {Record<string, string>} */ let roots = { spc_aaaaaaaaaaaa: "puba", spc_bbbbbbbbbbbb: "pubb" };
  const got = await dropSpaceHere({
    space: "spc_bbbbbbbbbbbb",
    removePairingFor: async (b) => { const i = pairings.indexOf(b); if (i >= 0) pairings.splice(i, 1); },
    shellGet: async () => shell,
    shellSet: async (v) => { shell = v; },
    hostLoad: async () => host,
    hostSave: async (k) => { host = /** @type {typeof host} */ (k); },
    rootsRead: async () => roots,
    rootsWrite: async (all) => { roots = all; },
  });
  assert.deepEqual(pairings, ["boxa"]);
  assert.deepEqual(shell.data.spaces.map((s) => s.id), ["spc_aaaaaaaaaaaa"]);
  assert.equal(shell.space, "spc_aaaaaaaaaaaa");
  assert.deepEqual(host.spaces.map((s) => s.id), ["spc_aaaaaaaaaaaa"]);
  assert.equal(host.current, "spc_aaaaaaaaaaaa");
  assert.deepEqual(roots, { spc_aaaaaaaaaaaa: "puba" });
  assert.deepEqual(got.removed, ["spc_bbbbbbbbbbbb"]);
  assert.deepEqual(got.boxes, ["boxb"]);
  assert.equal(got.next, "spc_aaaaaaaaaaaa");
});

test("a Space is quiet when its server did not answer, or its pairing is gone while another server remains", { skip: !strip }, async () => {
  const { markQuietSpaces } = await import("./drop-space.ts");
  const spaces = [
    { id: "spc_aaaaaaaaaaaa", name: "Cedar" },
    { id: "spc_bbbbbbbbbbbb", name: "Birch", server: "boxb" },
    { id: "spc_cccccccccccc", name: "Home" },
  ];
  const boxes = { spc_aaaaaaaaaaaa: "boxa", spc_cccccccccccc: "boxc" };
  const quiet = markQuietSpaces(spaces, ["boxb"], boxes, ["boxa", "boxc"]);
  assert.equal(quiet[0].quiet, undefined);
  assert.equal(quiet[0].server, "boxa");
  assert.equal(quiet[1].quiet, true);
  assert.equal(quiet[2].quiet, undefined);
  const gone = markQuietSpaces(spaces, [], boxes, ["boxa"]);
  assert.equal(gone[1].quiet, true, "the pairing is already gone");
  assert.equal(gone[2].quiet, true);
  const unread = markQuietSpaces(spaces, [], boxes, null);
  assert.equal(unread[1].quiet, undefined, "pairings that could not be read are not treated as gone");
  const none = markQuietSpaces(spaces, [], boxes, []);
  assert.equal(none[0].quiet, undefined, "no relay pairing is not every Space gone");
  const plain = markQuietSpaces([{ id: "spc_dddddddddddd", name: "Basic" }], ["boxa"], {}, ["boxa"]);
  assert.equal(plain[0].quiet, undefined);
  const url = markQuietSpaces([{ id: "spc_aaaaaaaaaaaa", name: "Cedar", server: "https://cedar.vyre.run" }], [], { spc_aaaaaaaaaaaa: "boxa" }, ["boxa"]);
  assert.equal(url[0].server, "boxa");
  assert.equal(url[0].quiet, undefined);
});

test("Remove on this computer is wired to the pairing, the shell cache, the host Spaces, the saved roots and the switcher", () => {
  const src = fs.readFileSync(new URL("./drop-space.ts", import.meta.url), "utf8");
  for (const needle of ["removePairingFor", "viewCache", "hostStore", "readRoots", "writeRoots", "forgetServer", "setShowing"]) assert.match(src, new RegExp(needle));
  const shell = fs.readFileSync(new URL("../../screens/shell/real.ts", import.meta.url), "utf8");
  assert.match(shell, /markQuietSpaces/);
});
