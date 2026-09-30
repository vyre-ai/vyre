// @ts-check
// lib/deeplink: every vector in spec/deeplink/open.json, the file the Windows and Mac apps also test against.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseOpen, ROUTES } from "./index.js";

const spec = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "spec", "deeplink", "open.json"), "utf8"));

test("spec/deeplink/open.json: every case", () => {
  assert.equal(spec.v, 1);
  assert.ok(spec.cases.length >= 20);
  for (const c of spec.cases) assert.equal(parseOpen(c.input), c.expect, `${c.input} (${c.why})`);
});

test("a pairing link, a URL or a non-string is never a route", () => {
  for (const x of ["vyre://pair/abcd", "https://example.com/chat", null, 42, { toString: () => "vyre://open/chat" }]) assert.equal(parseOpen(x), null);
  assert.ok(ROUTES.every(r => parseOpen("vyre://open" + r) === r), "each route itself opens");
});
