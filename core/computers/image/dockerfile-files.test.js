// @ts-check
// The image can only run what its Dockerfile copies. A file agentd imports or starts that the COPY line does not name makes agentd fail on its first import inside the image, which no unit test sees (they run from
// the repository). This reads the Dockerfile's COPY list into /opt/agentd and fails when an import, a spawn target (/opt/agentd/<file>), or a file of this folder that belongs in the image is missing from it.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const dockerfile = fs.readFileSync(path.join(DIR, "Dockerfile"), "utf8").replace(/\\\n\s*/g, " ");
/** the files COPYd to /opt/agentd/ */
const copied = new Set(/** @type {string[]} */ ([]));
for (const line of dockerfile.split("\n")) {
  const m = /^COPY\s+(.+?)\s+(\S+)\s*$/.exec(line.trim());
  if (m && m[2] === "/opt/agentd/") for (const f of m[1].split(/\s+/)) copied.add(f);
}
const GENERATED = new Set(["package.json", "client"]);   // written by a RUN line
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(DIR, f), "utf8");
const shippable = fs.readdirSync(DIR).filter(f => /^agentd[a-z-]*\.(js|py)$/.test(f) && !/\.test\./.test(f));

test("the Dockerfile copies the files of this folder that belong in the image, and nothing it names is missing from the folder", () => {
  assert.ok(copied.size >= 5, "the COPY list into /opt/agentd/ was found");
  for (const f of shippable) assert.ok(copied.has(f), `${f} is in this folder but not in the Dockerfile's COPY list`);
  for (const f of copied) assert.ok(fs.existsSync(path.join(DIR, f)), `${f} is in the COPY list but not in this folder`);
});

test("every relative import of a copied file, and every /opt/agentd/<file> any file here starts or imports, is a copied file", () => {
  const files = [...copied, "entrypoint.sh", "Dockerfile"];
  for (const f of files) {
    const text = f === "Dockerfile" ? dockerfile : read(f);
    if (/\.js$/.test(f)) {
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)["']\.\/([A-Za-z0-9._-]+)["']/g)) assert.ok(copied.has(m[1]), `${f} imports ./${m[1]}, which is not copied into /opt/agentd`);
    }
    for (const m of text.matchAll(/\/opt\/agentd\/([A-Za-z0-9._-]+)/g)) {
      const name = m[1].replace(/\.$/, "");
      if (GENERATED.has(name) || name === "*.js") continue;
      assert.ok(copied.has(name), `${f} names /opt/agentd/${name}, which is not copied`);
    }
  }
});

test("the chmod line makes every copied python helper readable (root-owned, run by name)", () => {
  const chmod = /chmod 0644 (.*\/opt\/agentd\/package\.json)/.exec(dockerfile);
  assert.ok(chmod, "a chmod 0644 line");
  for (const f of copied) if (f.endsWith(".py")) assert.ok(chmod[1].includes(`/opt/agentd/${f}`), `${f} is not made readable`);
});
