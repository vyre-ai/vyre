import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
// The preview frame never recolours the page: its canvas is the browser's own white, a named token (tokens.page.web), on the web frame and the phone's web view alike. A page designed on white must not turn dark in dark mode.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (/** @type {string} */ f) => fs.readFileSync(path.join(HERE, f), "utf8");

test("the preview frame's canvas is the browser's white token on both frames, and follows no theme role", () => {
  const tokens = src("../theme/tokens.ts");
  assert.match(tokens, /"page": \{\s*"web": "#FFFFFF"\s*\}/);
  for (const f of ["PreviewFrame.web.tsx", "PreviewFrame.tsx"]) {
    const code = src(f);
    assert.match(code, /tokens\.page\.web/, `${f} uses the named browser-white token`);
    assert.doesNotMatch(code, /useUiTheme|useTheme|color\.(panel|bg|card)/, `${f} does not follow the theme`);
  }
});
