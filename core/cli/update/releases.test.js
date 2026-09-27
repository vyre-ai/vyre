// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../../test/helpers.js";
import * as R from "./releases.js";

const rel = (tag, extra = {}) => ({ tag_name: tag, prerelease: /-/.test(tag), draft: false, body: `notes for ${tag}`, published_at: "2026-09-01T00:00:00Z", assets: [], ...extra });

test("releases: versions order by semver, betas before their release, numbers as numbers", () => {
  const sorted = ["0.2.0", "0.1.0", "0.2.0-beta.10", "0.2.0-beta.2", "0.10.0", "0.2.0-beta.9", "v0.1.1"].sort(R.compare);
  assert.deepEqual(sorted, ["0.1.0", "v0.1.1", "0.2.0-beta.2", "0.2.0-beta.9", "0.2.0-beta.10", "0.2.0", "0.10.0"]);
  assert.equal(R.compare("1.0.0-beta.1", "1.0.0-beta"), 1, "more parts sort after fewer");
  assert.equal(R.compare("1.0.0-1", "1.0.0-beta"), -1, "a number sorts before a word");
  assert.equal(R.parseVersion("latest"), null);
  assert.throws(() => R.compare("x", "0.1.0"), /not a version/);
});

test("releases: stable is the newest non-prerelease, beta the newest of either; drafts and odd tags are left out", () => {
  const list = R.releases([
    rel("v0.1.0"), rel("v0.2.0"), rel("v0.3.0-beta.1"), rel("v0.3.0-beta.2"),
    rel("v0.9.0", { draft: true }), rel("nightly"), rel("v0.2.1", { prerelease: true }),
  ]);
  assert.deepEqual(list.map(r => r.version), ["0.3.0-beta.2", "0.3.0-beta.1", "0.2.1", "0.2.0", "0.1.0"]);
  assert.equal(R.pick(list, "stable")?.version, "0.2.0", "a release GitHub marks as a prerelease is not stable");
  assert.equal(R.pick(list, "beta")?.version, "0.3.0-beta.2");
  assert.equal(R.pick(R.releases([rel("v0.1.0-beta.1")]), "stable"), null);
  // Newest by version, not by list order or date: a late fix to an old line is not newer.
  assert.equal(R.pick(R.releases([rel("v0.1.5"), rel("v0.2.0"), rel("v0.1.6")]), "stable")?.version, "0.2.0");
  assert.throws(() => R.releases({ message: "Not Found" }), /not a list/);
});

test("releases: the changelog runs from the running version (left out) to the target (kept)", () => {
  const list = R.releases([rel("v0.1.0"), rel("v0.1.1"), rel("v0.2.0-beta.1"), rel("v0.2.0"), rel("v0.3.0")]);
  assert.deepEqual(R.changelog(list, "0.1.0", "0.2.0", "stable").map(n => n.version), ["0.2.0", "0.1.1"]);
  assert.deepEqual(R.changelog(list, "0.1.0", "0.2.0", "beta").map(n => n.version), ["0.2.0", "0.2.0-beta.1", "0.1.1"]);
  assert.equal(R.changelog(list, "0.1.0", "0.2.0", "stable")[0].notes, "notes for v0.2.0");
  assert.deepEqual(R.changelog(list, "0.3.0", "0.3.0", "stable"), []);
});

test("releases: min_from refuses an old version and names the release to step through", () => {
  const list = R.releases([rel("v0.1.0"), rel("v0.2.0"), rel("v0.2.1"), rel("v0.3.0")]);
  assert.deepEqual(R.canUpdate(list, "0.2.0", "0.2.0", "0.3.0", "stable"), { ok: true });
  assert.deepEqual(R.canUpdate(list, "0.1.0", undefined, "0.3.0", "stable"), { ok: true });
  const r = R.canUpdate(list, "0.1.0", "0.2.0", "0.3.0", "stable");
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.step?.version, "0.2.0");
  // No release between min_from and the target: nothing to step through.
  const none = R.canUpdate(list, "0.0.1", "0.3.0", "0.3.0", "stable");
  assert.equal(!none.ok && none.step, null);
});

test("releases: SHA256SUMS is parsed strictly, and a file is checked against its line", t => {
  const home = tempHome(t);
  const file = path.join(home, "vyre.tgz");
  fs.writeFileSync(file, "Northwind Bakery");
  const hash = crypto.createHash("sha256").update("Northwind Bakery").digest("hex");
  const sums = R.parseSums(`${hash}  vyre.tgz\n${"a".repeat(64)} *VERSION\n`);
  assert.deepEqual(sums, { "vyre.tgz": hash, VERSION: "a".repeat(64) });
  R.verify(file, "vyre.tgz", sums);
  assert.throws(() => R.verify(file, "VERSION", sums), /checksum mismatch for VERSION/);
  assert.throws(() => R.verify(file, "compose.yml", sums), /no line for compose.yml/);
  assert.throws(() => R.parseSums("<!doctype html><html><body>Not Found</body></html>\n"), /not a checksum list/);
  assert.throws(() => R.parseSums(`${hash}  vyre.tgz\nsomething else\n`), /not a checksum list/);
  assert.throws(() => R.parseSums(`${hash}  ../vyre.tgz\n`), /not a checksum list/, "a name with a path is refused");
  assert.throws(() => R.parseSums(""), /empty/);
});

test("releases: downloads go over https, or plain http only to this machine", () => {
  assert.equal(R.safeUrl("https://github.com/vyre-ai/vyre/releases/download/v0.1.0/vyre.tgz"), "https://github.com/vyre-ai/vyre/releases/download/v0.1.0/vyre.tgz");
  assert.equal(R.safeUrl("http://127.0.0.1:4100/x"), "http://127.0.0.1:4100/x");
  assert.throws(() => R.safeUrl("http://example.com/vyre.tgz"), /refusing to download over http:/);
  assert.throws(() => R.safeUrl("file:///etc/passwd"), /refusing/);
});
