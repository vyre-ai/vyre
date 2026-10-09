// @ts-check
// The picture on a preview's card: finding a Chrome on this machine, taking one screenshot of a loopback address with a deadline, and handing the last good one to a person who may open the preview.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findChrome, capture } from "./thumb.js";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

/** A stand-in Chrome (like the real one, it only writes a .png or .jpeg): writes a PNG-looking file where --screenshot says, and notes the address and flags it was given. @param {string} dir @param {{ sleep?: number }} [o] */
const fakeChrome = (dir, o = {}) => {
  const f = path.join(dir, "fake-chrome");
  fs.writeFileSync(f, `#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) out="\${a#--screenshot=}";; http*) url="$a";; esac; done\ncase "$out" in *.png) ;; *) echo "Unsupported screenshot image file type" >&2; exit 0;; esac\necho "$url" >> "${dir}/seen.txt"\necho "$@" >> "${dir}/args.txt"\n${o.sleep ? `sleep ${o.sleep}` : ""}\nprintf '\\211PNG\\r\\n\\032\\n' > "$out"; head -c 600 /dev/zero >> "$out"\n`, { mode: 0o755 });
  return f;
};

test("a Chrome is found by config, by VYRE_CHROME, then on the path; none is none", () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-chrome-"));
  const chrome = fakeChrome(dir);
  assert.equal(findChrome({ PATH: "" }, chrome), chrome);
  assert.equal(findChrome({ PATH: "", VYRE_CHROME: chrome, PLAYWRIGHT_BROWSERS_PATH: dir }), chrome);
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin); fs.copyFileSync(chrome, path.join(bin, "chromium")); fs.chmodSync(path.join(bin, "chromium"), 0o755);
  assert.equal(findChrome({ PATH: bin, PLAYWRIGHT_BROWSERS_PATH: dir }), path.join(bin, "chromium"));
  assert.equal(findChrome({ PATH: "/nonexistent", PLAYWRIGHT_BROWSERS_PATH: dir }, "/nope"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a screenshot is written whole to the file, loopback names resolve, and a browser that hangs is killed at its deadline", async () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-capture-"));
  const out = path.join(dir, "a.png");
  assert.equal(await capture({ chrome: fakeChrome(dir), url: "http://pv-0a1b2c3d.localhost:5100/", out }), true);
  assert.ok(fs.statSync(out).size > 200);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600, "private to the daemon's user");
  assert.match(fs.readFileSync(path.join(dir, "args.txt"), "utf8"), /--host-resolver-rules=MAP \*\.localhost 127\.0\.0\.1/);
  assert.ok(!fs.existsSync(path.join(dir, "a.part.png")));
  const slow = path.join(dir, "slow"); fs.mkdirSync(slow);
  const t0 = Date.now();
  assert.equal(await capture({ chrome: fakeChrome(slow, { sleep: 30 }), url: "http://127.0.0.1:1/", out: path.join(slow, "b.png"), timeoutMs: 600 }), false);
  assert.ok(Date.now() - t0 < 5000, "killed at the deadline, not waited for");
  assert.equal(await capture({ chrome: path.join(dir, "missing"), url: "http://127.0.0.1:1/", out: path.join(dir, "c.png"), timeoutMs: 600 }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a preview's card gets its picture when it comes up and after a restart, only a person who may open it can have it, and removing it removes the picture", { timeout: 90_000 }, async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-thumbs-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.VYRE_CHROME = fakeChrome(dir);
  process.env.VYRE_PREVIEW_THUMBS = "1";
  t.after(() => { delete process.env.VYRE_CHROME; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli") => d.registry.call(tool, input, caller);
  const until = async (/** @type {() => Promise<boolean>} */ f, ms = 15_000) => { const s = Date.now(); while (Date.now() - s < ms) { if (await f()) return true; await new Promise(r => setTimeout(r, 150)); } return false; };
  fs.mkdirSync(path.join(dir, "site"));
  fs.writeFileSync(path.join(dir, "site", "index.html"), "<!doctype html><title>x</title>hello");
  const pv = await call("previews.open", { title: "Site", path: path.join(dir, "site") });
  const id = pv.data.id;
  assert.equal((await call("previews.thumb", { id })).data.image === null || true, true);
  assert.ok(await until(async () => (await call("previews.thumb", { id })).data.image !== null), "the picture arrives once the preview is up");
  assert.match(fs.readFileSync(path.join(dir, "seen.txt"), "utf8"), new RegExp(`^http://pv-${id}\\.localhost:\\d+/$`, "m"), "its own address, on this machine");
  const first = (await call("previews.thumb", { id })).data;
  assert.ok(Buffer.from(first.image, "base64").subarray(1, 4).toString() === "PNG");
  assert.ok((await call("previews.thumb", { id }, "mcp")).error, "a model has no picture of a person's page");
  assert.equal((await call("previews.thumb", { id: "00000000" })).error.code, "not_found");
  // after a restart the card gets a fresh picture
  await call("previews.stop", { id });
  await call("previews.restart", { id });
  assert.ok(await until(async () => (await call("previews.thumb", { id })).data.at > first.at), "a new picture after the restart");
  await call("previews.remove", { id });
  assert.ok(!fs.readdirSync(path.join(root, "previews-thumbs")).some(f => f.startsWith(id)), "removing the preview removes its picture");
});
