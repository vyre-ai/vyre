// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ALPHABET, formatCode, parseCode } from "./code.js";
import { codeToAvatarBytes, avatarBytesToCode, AVATAR_KIND } from "./avatarcode.js";
import * as payload from "../../deck/vyrecode/payload.js";

const randomCode = () => { const s = Array.from(crypto.randomBytes(8), b => ALPHABET[b & 31]).join(""); return formatCode(s.slice(0, 2), s.slice(2)); };

test("a typed code is 8 bytes in the avatar and comes back as the same code, for any code", () => {
  for (let i = 0; i < 500; i++) {
    const code = randomCode();
    const b = /** @type {Uint8Array} */ (codeToAvatarBytes(code));
    assert.equal(b.length, 8);
    assert.equal(b[0], AVATAR_KIND);
    assert.equal(avatarBytesToCode(b), code, code);
  }
  assert.equal(avatarBytesToCode(/** @type {Uint8Array} */ (codeToAvatarBytes("wink k7qm 4p2x"))), "WINK-K7QM-4P2X", "what a person types folds to the same picture");
  assert.equal(codeToAvatarBytes("no way!"), null);
});

test("the ring's payload protection carries it: the codeword survives byte errors and the code comes out the same", () => {
  const code = randomCode();
  const id8 = Array.from(/** @type {Uint8Array} */ (codeToAvatarBytes(code)));
  const cw = payload.buildCodeword(id8);
  for (let errors = 0; errors <= 4; errors++) {
    const bad = [...cw];
    for (let i = 0; i < errors; i++) bad[i * 3] ^= 0xff;
    const got = payload.recoverId(bad);
    assert.ok(got, `${errors} byte errors are corrected`);
    assert.equal(avatarBytesToCode(got.id8), code);
  }
});

test("a ring that carries anything else is never read as a code: an identity mark's fingerprint, a wrong version, a wrong length", () => {
  const fingerprint = [...crypto.createHash("sha256").update("per_alex").digest()].slice(0, 8);
  assert.equal(avatarBytesToCode(fingerprint), null);
  const b = Array.from(/** @type {Uint8Array} */ (codeToAvatarBytes(randomCode())));
  assert.equal(avatarBytesToCode([0xc2, ...b.slice(1)]), null, "another version");
  assert.equal(avatarBytesToCode([...b.slice(0, 6), 0, 0]), null, "no magic");
  assert.equal(avatarBytesToCode(b.slice(0, 7)), null);
  assert.equal(avatarBytesToCode(/** @type {any} */ (null)), null);
  assert.ok(parseCode(/** @type {string} */ (avatarBytesToCode(b))), "and what it returns is a code the typed path reads");
});
