// @ts-check
// The one opener (open-link.ts): which addresses it takes, and that the Mac shell's own open is used first, with every external open in the app going through it.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("only http, https and mailto addresses are opened", { skip: !strip }, async () => {
  const { openable, openLink } = await import("./open-link.ts");
  for (const ok of ["https://claude.com/cai/oauth/authorize?code=true", "http://127.0.0.1:3000/x", "mailto:a@b.example"]) assert.equal(openable(ok), true, ok);
  for (const no of ["", "javascript:alert(1)", "file:///etc/passwd", "vyreapp://box/x", "https://a b", "ftp://x.example"]) assert.equal(openable(no), false, no);
  assert.equal(await openLink("javascript:alert(1)"), false);
});

test("in the Mac app the shell's own open takes the address", { skip: !strip }, async () => {
  const seen = [];
  /** @type {any} */ (globalThis).window = { __vyreShell: { kind: "mac", open: async (/** @type {string} */ u) => { seen.push(u); } } };
  try {
    const { openLink } = await import("./open-link.ts?mac");
    assert.equal(await openLink("https://claude.com/x"), true);
    assert.deepEqual(seen, ["https://claude.com/x"]);
  } finally { delete (/** @type {any} */ (globalThis)).window; }
});

test("no screen opens an address on its own: window.open and Linking.openURL are only in the opener (and the pop-up sign-in windows go through it)", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const hits = [];
  const walk = (/** @type {string} */ d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!["node_modules", "xterm", ".expo", "dist"].includes(e.name)) walk(p); } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) { const t = fs.readFileSync(p, "utf8"); if (/Linking\.openURL\(|window\.open\(/.test(t)) hits.push(path.relative(root, p)); } } };
  walk(root);
  assert.deepEqual(hits.sort(), ["src/real/github.ts", "src/real/open-link.ts"], "the GitHub sign-in's own pop-up (outside the Mac shell) and the opener");
});
