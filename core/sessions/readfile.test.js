// Reading a file as the account that owns it: confined, canonical, regular, capped.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";
import { openConfined } from "./readfile.js";

const SCRIPT = fileURLToPath(new URL("./readfile.js", import.meta.url));

test("readfile: a regular file inside the home is read byte for byte by the script", t => {
  const home = tempHome(t);
  const dir = path.join(home, ".grok", "sessions", "x", "images"); fs.mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
  fs.writeFileSync(path.join(dir, "1.jpg"), bytes, { mode: 0o600 });
  const out = execFileSync(process.execPath, [SCRIPT, home, path.join(dir, "1.jpg"), "100000"], { maxBuffer: 1 << 20 });
  assert.ok(out.equals(bytes));
});

test("readfile: a link, a path outside the home, a directory, an oversize file and a relative path are refused", t => {
  const home = tempHome(t), outside = tempHome(t);
  fs.writeFileSync(path.join(outside, "secret"), "x");
  fs.writeFileSync(path.join(home, "ok.bin"), "12345678");
  fs.symlinkSync(path.join(outside, "secret"), path.join(home, "link"));
  fs.symlinkSync(outside, path.join(home, "dirlink"));
  fs.mkdirSync(path.join(home, "d"));
  const why = (file, max) => { const r = openConfined(home, file, max); return "error" in r ? r.error : "opened"; };
  assert.equal(why(path.join(home, "ok.bin"), 100), "opened");
  assert.match(why(path.join(home, "link"), 100), /link/, "a file link");
  assert.match(why(path.join(home, "dirlink", "secret"), 100), /link/, "a folder link");
  assert.match(why(path.join(outside, "secret"), 100), /outside/);
  assert.match(why(path.join(home, "..", path.basename(outside), "secret"), 100), /outside|link/, "dot dot");
  assert.match(why(path.join(home, "d"), 100), /regular/);
  assert.match(why(path.join(home, "ok.bin"), 4), /larger/);
  assert.match(why("ok.bin", 100), /absolute/);
  assert.match(why(path.join(home, "missing"), 100), /no such/);
  const r = spawnSync(process.execPath, [SCRIPT, home, path.join(home, "link"), "100"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /link/);
});
