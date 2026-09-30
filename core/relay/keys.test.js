// @ts-check
// loadKeys(root), on its own: made on first use, 0600/0700, round-trips, and a genuinely
// unreadable file (not just missing) fails loudly rather than minting a fresh identity over it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadKeys } from "./keys.js";
import { tempHome } from "../../test/helpers.js";

test("relay keys: made on first use, 0600/0700, and the same root loads the same keys back", t => {
  const root = tempHome(t);
  const first = loadKeys(root);
  const file = path.join(root, "relay", "keys.json");
  assert.equal(fs.statSync(path.join(root, "relay")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = loadKeys(root);
  assert.deepEqual(again.box.priv, first.box.priv);
  assert.deepEqual(again.box.pub, first.box.pub);
  assert.deepEqual(again.route.priv, first.route.priv);
  assert.deepEqual(again.route.pub, first.route.pub);
});

test("relay keys: two different roots never share a key", t => {
  const a = loadKeys(tempHome(t)), b = loadKeys(tempHome(t));
  assert.notDeepEqual(a.box.priv, b.box.priv);
});

test("relay keys: a file that exists but is not readable fails loudly, never minting a fresh identity silently", t => {
  const root = tempHome(t);
  const dir = path.join(root, "relay");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "keys.json"), "not json", { mode: 0o600 });
  assert.throws(() => loadKeys(root), /relay keys unreadable/);
});
