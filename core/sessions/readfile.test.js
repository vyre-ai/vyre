// Reading a generated file as the account that owns it: only a provider's media output folders, only media names, only media bytes, no links, capped.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";
import { openConfined, looksLikeMedia } from "./readfile.js";

const SCRIPT = fileURLToPath(new URL("./readfile.js", import.meta.url));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))]);

test("readfile: a media file in a provider's output folder is read byte for byte by the script", t => {
  const home = tempHome(t);
  const dir = path.join(home, ".grok", "sessions", "x", "abc", "images"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "1.jpg"), JPEG, { mode: 0o600 });
  const out = execFileSync(process.execPath, [SCRIPT, home, path.join(dir, "1.jpg"), "100000"], { maxBuffer: 1 << 20 });
  assert.ok(out.equals(JPEG));
  const cdir = path.join(home, ".codex", "generated_images", "sess"); fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, "c.png"), Buffer.from("89504e470d0a1a0a0000000d", "hex"));
  assert.equal("error" in openConfined(home, path.join(cdir, "c.png"), 100), false);
});

test("readfile: login files, other folders, non-media names or bytes, links, outside paths, directories, oversize and relative paths are refused, and nothing is read", t => {
  const home = tempHome(t), outside = tempHome(t);
  const w = (rel, bytes) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; };
  const imgs = ".grok/sessions/x/abc/images";
  w(".codex/auth.json", '{"tokens":{"refresh_token":"R"}}');
  w(".grok/auth.json", '{"token":"T"}');
  w(".codex/config.toml", "model = 'x'");
  w(`${imgs}/ok.jpg`, JPEG);
  w(`${imgs}/notes.txt`, JPEG);
  w(`${imgs}/token.png`, JPEG);
  w(`${imgs}/login.png`, Buffer.from('{"tokens":"R"}'));
  w(".grok/other/abc/images/1.jpg", JPEG);
  w(".codex/sessions/x.jpg", JPEG);
  w("elsewhere/1.jpg", JPEG);
  fs.writeFileSync(path.join(outside, "secret.jpg"), JPEG);
  fs.symlinkSync(path.join(outside, "secret.jpg"), path.join(home, imgs, "link.jpg"));
  fs.symlinkSync(outside, path.join(home, ".grok", "sessions", "x", "dirlink"));
  fs.mkdirSync(path.join(home, imgs, "d.jpg"));
  const why = (rel, max = 100000) => { const r = openConfined(home, path.join(home, rel), max); if ("error" in r) return r.error; fs.closeSync(r.fd); return "opened"; };
  assert.equal(why(`${imgs}/ok.jpg`), "opened");
  assert.match(why(".codex/auth.json"), /not a place/, "the Codex login");
  assert.match(why(".grok/auth.json"), /not a place/, "the Grok login");
  assert.match(why(".codex/config.toml"), /not a place/);
  assert.match(why(`${imgs}/notes.txt`), /media file name/);
  assert.match(why(`${imgs}/token.png`), /media file name/, "a sensitive name with a media extension");
  assert.match(why(`${imgs}/login.png`), /picture, video or sound/, "a login renamed .png");
  assert.match(why(".grok/other/abc/images/1.jpg"), /not a place/);
  assert.match(why(".codex/sessions/x.jpg"), /not a place/);
  assert.match(why("elsewhere/1.jpg"), /not a place/);
  assert.match(why(`${imgs}/link.jpg`), /link/);
  assert.match(why(".grok/sessions/x/dirlink/secret.jpg"), /link/);
  assert.match(why(`${imgs}/d.jpg`), /regular/);
  assert.match(why(`${imgs}/ok.jpg`, 4), /larger/);
  assert.match(openConfined(home, "relative.jpg", 100).error, /absolute/);
  assert.match(openConfined(home, path.join(outside, "secret.jpg"), 100).error, /outside/);
  assert.match(why(`${imgs}/none.jpg`), /no such/);
  // As the script: a refusal prints one line and no bytes.
  const r = spawnSync(process.execPath, [SCRIPT, home, path.join(home, ".codex/auth.json"), "100"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "", "nothing leaves the child");
  assert.match(r.stderr, /not a place/);
});

test("readfile: looksLikeMedia knows pictures, video and sound by their first bytes, and not text or json", () => {
  const hex = h => Buffer.from(h, "hex");
  for (const h of ["89504e470d0a1a0a00", "ffd8ffe0", "47494638396100", "52494646000000005745425000", "5249464600000000574156450000", "000000186674797069736f6d", "1a45dfa3", "4f676753", "494433", "fffb90"]) assert.ok(looksLikeMedia(hex(h)), h);
  for (const t of ['{"tokens":1}', "model = 'x'", "<html>", ""]) assert.ok(!looksLikeMedia(Buffer.from(t)), t);
});
