// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { signinLoc, normalName, signInByName } from "./signin.js";
import { nodeCrypto } from "./nodecrypto.js";

test("a name's locator is one hash whatever its spelling, and a bad name is refused in words", async () => {
  const c = nodeCrypto();
  const a = await signinLoc("Kit", c);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await signinLoc("  @kit.vyre.run ", c), a);
  assert.notEqual(await signinLoc("kat", c), a);
  assert.equal(normalName("@Kit"), "kit");
  await assert.rejects(() => signinLoc("not a name!", c), e => e.code === "bad_name" && /Type the name/.test(e.message));
});

test("signInByName posts a hashed name and a one-time secret, and says why when the relay is busy or away", async () => {
  const c = nodeCrypto();
  /** @type {any[]} */ const seen = [];
  const busy = /** @type {any} */ (async (/** @type {string} */ u, /** @type {any} */ init) => { seen.push([u, JSON.parse(init.body)]); return { ok: false, status: 429 }; });
  await assert.rejects(() => signInByName({ name: "kit", relay: "wss://relay.example", key: { publicKey: "A".repeat(43) }, crypto: c, fetch: busy }), e => e.code === "rate_limited" && /Wait a minute/.test(e.message));
  assert.equal(seen[0][0], "https://relay.example/v1/signin");
  assert.equal(seen[0][1].loc, await signinLoc("kit", c));
  assert.ok(!JSON.stringify(seen[0][1]).includes("kit"), "the relay is never sent the name");
  const away = /** @type {any} */ (async () => { throw new Error("down"); });
  await assert.rejects(() => signInByName({ name: "kit", relay: "wss://relay.example", key: { publicKey: "A".repeat(43) }, crypto: c, fetch: away }), e => e.code === "unreachable");
});
