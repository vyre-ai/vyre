// @ts-check
// The workspace reader's sandbox sees the code it needs and no more (least privilege): besides node and its own folder, one read-only folder, lib/drivers, which holds the credential file names
// (credfiles.js) and nothing else. It used to mount core/sessions/drivers, every session driver, for that one file.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (/** @type {string} */ f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");

test("the reader's sandbox mounts lib/drivers for the credential names, never the session drivers, and lib/drivers holds only credfiles.js", () => {
  const host = read("./readerhost.js");
  assert.match(host, /const CREDFILES_DIR = path\.join\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\.", "\.\.", "lib", "drivers"\);/);
  assert.doesNotMatch(host, /"sessions", "drivers"/, "no session driver is readable in the reader's sandbox");
  assert.deepEqual(fs.readdirSync(new URL("../../lib/drivers/", import.meta.url)).sort(), ["credfiles.js"], "anything added to lib/drivers becomes readable inside every session's sandbox");
  assert.match(read("./reader.js"), /import \{ (isCredentialFile|mayUpload) \} from "\.\.\/\.\.\/lib\/drivers\/credfiles\.js";/);
  assert.doesNotMatch(read("../../lib/drivers/credfiles.js"), /^import /m, "the reader's sandbox has nothing else to import from");
});
