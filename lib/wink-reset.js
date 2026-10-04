// @ts-check
// The pure parts of the server reset code (core/wink/reset.js has the why): the code format and the salted scrypt hash. Here so the command line can make a code
// without importing the Wink module.

import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The code as typed, without dashes, spaces or case. @param {any} s */
export const normalise = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** A fresh one-time code, like K7QM-4P2X (40 bits). Made by the CLI, never by the daemon. @param {(n: number) => Buffer} [rand] */
export function newCode(rand = crypto.randomBytes) {
  const b = rand(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i] % 32];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** The hash the daemon keeps for a code. @param {string} code @param {string} saltHex */
export const codeHash = (code, saltHex) => crypto.scryptSync(normalise(code), Buffer.from(saltHex, "hex"), 32, { N: 16384, r: 8, p: 1 }).toString("hex");

/** What a person at the CLI sends to begin: a fresh salt and the hash. The code itself stays with the caller. @param {string} code */
export function beginInput(code) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: codeHash(code, salt) };
}
