import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { saveCentrePhoto } from "./profile-photo-save.js";

const screen = () => fs.readFileSync(new URL("../../screens/settings/ProfileScreen.tsx", import.meta.url), "utf8");

test("a tall picture is centre-cropped, scaled to 512 and saved for Noah Hale", async () => {
  /** @type {{ space: string, pic: { side: number, mime: string }, name: string }[]} */
  const seen = [];
  const pic = await saveCentrePhoto(
    { uri: "file://noah.jpg", width: 800, height: 2000 },
    "spc_cccccccccccc",
    "Noah Hale",
    async (_pick, crop) => {
      assert.deepEqual(crop, { originX: 0, originY: 600, width: 800, height: 800 });
      return { base64: "QQ==", mime: "image/jpeg", bytes: 2, side: Math.min(512, crop.width) };
    },
    async (space, saved, name) => { seen.push({ space, pic: saved, name }); },
  );
  assert.equal(pic.side, 512);
  assert.equal(pic.mime, "image/jpeg");
  assert.deepEqual(seen, [{ space: "spc_cccccccccccc", pic, name: "Noah Hale" }]);
});

test("a small picture is not enlarged past its own side", async () => {
  const pic = await saveCentrePhoto(
    { width: 200, height: 200 },
    "spc_bbbbbbbbbbbb",
    "Noah Hale",
    async (_pick, crop) => ({ base64: "QQ==", mime: "image/webp", bytes: 2, side: Math.min(512, crop.width) }),
    async () => {},
  );
  assert.equal(pic.side, 200);
  assert.equal(pic.mime, "image/webp");
});

test("a picture that cannot be encoded is not saved", async () => {
  let saved = 0;
  await assert.rejects(
    () => saveCentrePhoto({ width: 10, height: 10 }, "spc_cccccccccccc", "Noah Hale", async () => { throw new Error("That picture is still over 200 KB at its smallest. Try another one."); }, async () => { saved += 1; }),
    /200 KB/,
  );
  assert.equal(saved, 0);
});

test("Your profile saves and clears a photo through profiles.setPhoto", () => {
  const src = screen();
  assert.match(src, /saveCentrePhoto\(/);
  assert.match(src, /useProfiles\.getState\(\)\.setPhoto\(s, pic, n\)/);
  assert.match(src, /useProfiles\.getState\(\)\.setPhoto\(space, null, name\)/);
});
