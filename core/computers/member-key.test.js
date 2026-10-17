// @ts-check
// The shared computers' member key: made on first need, only when the item is truly absent, never held in memory, never in a log line.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemberKey } from "./member-key.js";

/** A vault stand-in with the real rules that matter: a read needs the grant, a put with onlyIfAbsent writes nothing when the name exists, a locked vault refuses both. */
function rig({ item = null, granted = true, locked = false, readFails = false } = {}) {
  const s = { item, granted, locked, readFails, puts: 0, fetches: 0, log: /** @type {string[]} */ ([]) };
  const key = createMemberKey({
    fetch: async () => {
      s.fetches++;
      await new Promise(r => setImmediate(r));
      if (s.locked) throw new Error("the vault is locked");
      if (s.readFails) throw new Error("the vault could not be read");
      if (!s.item) throw new Error("no item named vyre-shared-computer-member-key");
      if (!s.granted) throw new Error("vyre-shared-computer-member-key is not granted to computers");
      return s.item;
    },
    put: async value => {
      s.puts++;
      await new Promise(r => setImmediate(r));
      if (s.locked) throw new Error("the vault is locked");
      if (s.item) return { existed: true };
      s.item = value; s.granted = true; return {};
    },
  });
  return { s, key };
}

test("absent: one put of 32 random bytes (43 base64url characters), and the second call returns the same without another put", async () => {
  const { s, key } = rig();
  const k = await key();
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.puts, 1);
  assert.equal(await key(), k);
  assert.equal(s.puts, 1);
});

test("ten concurrent first calls make exactly one put and all get the same key", async () => {
  const { s, key } = rig();
  const all = await Promise.all(Array.from({ length: 10 }, () => key()));
  assert.equal(new Set(all).size, 1);
  assert.equal(s.puts, 1);
});

test("an item that exists WITHOUT the grant is never replaced: the put answers existed, nothing is written, and the read's own refusal comes back", async () => {
  const { s, key } = rig({ item: "owners-own-key-value", granted: false });
  await assert.rejects(key(), /not granted to computers/);
  assert.equal(s.item, "owners-own-key-value");
  assert.equal(s.puts, 1, "the only-if-absent put was asked and answered existed");
});

test("a read that fails for another reason does not replace an existing key", async () => {
  const { s, key } = rig({ item: "owners-own-key-value", readFails: true });
  await assert.rejects(key(), /could not be read/);
  assert.equal(s.item, "owners-own-key-value");
});

test("a locked vault returns the vault's refusal, and the next call tries again", async () => {
  const { s, key } = rig({ locked: true });
  await assert.rejects(key(), /locked/);
  assert.equal(s.item, null);
  s.locked = false;
  assert.match(await key(), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.puts, 2);
});

test("the value is read on each use, never kept: an owner's rotation is followed", async () => {
  const { s, key } = rig({ item: "first-value-1234" });
  assert.equal(await key(), "first-value-1234");
  s.item = "rotated-value-5678";
  assert.equal(await key(), "rotated-value-5678");
  assert.equal(s.puts, 0);
});
