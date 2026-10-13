import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { checkLogoFile, coverSquare, keepableLogo, LOGO_PX } from "./logo.js";
import { cleanLook } from "../../src/state/appearance-keep.js";

test("a logo file is an image of a kind we can crop and small enough to read", () => {
  assert.equal(checkLogoFile({ type: "image/png", size: 40_000 }), null);
  assert.equal(checkLogoFile({ type: "image/jpeg", size: 2_000_000 }), null);
  assert.equal(checkLogoFile({ type: "image/webp", size: 10 }), null);
  assert.match(checkLogoFile({ type: "application/pdf", size: 10 }) ?? "", /PNG, JPEG or WebP/);
  assert.match(checkLogoFile({ type: "image/png", size: 9_000_000 }) ?? "", /5 MB/);
  assert.match(checkLogoFile({ type: "image/png", size: 0 }) ?? "", /empty/);
});

test("the crop is the biggest centred square, scaled to the logo size", () => {
  assert.deepEqual(coverSquare(400, 200), { sx: 100, sy: 0, side: 200, out: LOGO_PX });
  assert.deepEqual(coverSquare(200, 400), { sx: 0, sy: 100, side: 200, out: LOGO_PX });
  assert.deepEqual(coverSquare(64, 64), { sx: 0, sy: 0, side: 64, out: LOGO_PX });
  assert.equal(coverSquare(0, 10), null);
});

test("only a small image data address is kept as a space's logo; anything else is dropped", () => {
  assert.equal(keepableLogo("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(keepableLogo("data:image/jpeg;base64,AAAA") !== null, true);
  for (const bad of ["https://x/y.png", "javascript:alert(1)", "data:text/html;base64,AAAA", "data:image/svg+xml;base64,AAAA", `data:image/png;base64,${"A".repeat(200_000)}`, 5, null, ""]) assert.equal(keepableLogo(bad), null, String(bad).slice(0, 30));
});

test("a space's kept look carries its logo", () => {
  assert.equal(cleanLook({ accent: "amber", logo: "data:image/png;base64,AAAA" }).logo, "data:image/png;base64,AAAA");
  assert.equal(cleanLook({ accent: "amber", logo: "https://evil" }).logo, undefined);
});
