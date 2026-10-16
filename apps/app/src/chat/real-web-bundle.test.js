// @ts-check
// The release web export is built with EXPO_PUBLIC_VYRE_MOCK unset (not the sample world). These checks catch regressions that only show up in that bundle.
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHAT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(CHAT, "../../../..");

test("ChatScreen declares useRouter once", () => {
  const src = fs.readFileSync(path.join(CHAT, "ChatScreen.tsx"), "utf8");
  const hits = [...src.matchAll(/const router = useRouter\(\)/g)];
  assert.equal(hits.length, 1, "duplicate useRouter() breaks the non-mock web bundle");
});

test("box-stream resolves lib/thread-composer-route.js from the app tree", () => {
  const src = fs.readFileSync(path.join(CHAT, "box-stream.ts"), "utf8");
  const m = src.match(/from "([^"]+thread-composer-route\.js)"/);
  assert.ok(m, "box-stream imports thread-composer-route");
  const resolved = path.resolve(CHAT, m[1]);
  assert.ok(fs.existsSync(resolved), `missing ${m[1]} (resolved ${resolved})`);
});

test("release.yml exports the hosted web app without EXPO_PUBLIC_VYRE_MOCK=1", () => {
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows/release.yml"), "utf8");
  const i = yml.indexOf("Export the web app");
  assert.ok(i > 0);
  const step = yml.slice(i, yml.indexOf("\n      - name:", i + 10));
  assert.doesNotMatch(step, /EXPO_PUBLIC_VYRE_MOCK\s*=\s*1/);
});
