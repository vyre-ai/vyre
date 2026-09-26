// @ts-check
// generate: new passwords and passphrases, from node:crypto and nothing else.
//
// Decision 10 in docs/adr/0001-vault-crypto.md. Every character or syllable comes from
// crypto.randomInt, which rejects out of range draws, so there is no modulo bias. Words are built
// from consonant-vowel syllables rather than picked from a list: 80^3 per word gives 18.9 bits,
// they are easy to say and type, and there is no word list to ship or licence. The reported bits
// assume the attacker knows the scheme, and they ignore the small loss from requiring each class.

import crypto from "node:crypto";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*-_=+?";
export const CONSONANTS = "bdfghjklmnprstvz";
export const VOWELS = "aeiou";

const floor1 = x => Math.floor(x * 10 + 1e-9) / 10;
const pick = s => s[crypto.randomInt(s.length)];

/**
 * A random password (characters) or passphrase (`words` given).
 * @param {{ length?: number, words?: number, symbols?: boolean, separator?: string }} [opts]
 * @returns {{ value: string, bits: number }}
 */
export function generate({ length = 24, words, symbols = true, separator = "-" } = {}) {
  if (words !== undefined) {
    if (!Number.isInteger(words) || words < 3 || words > 20) throw new Error("generate: words must be a whole number from 3 to 20");
    const list = [];
    for (let w = 0; w < words; w++) {
      let word = "";
      for (let i = 0; i < 3; i++) word += pick(CONSONANTS) + pick(VOWELS);
      list.push(word);
    }
    return { value: list.join(String(separator)), bits: floor1(words * 3 * Math.log2(CONSONANTS.length * VOWELS.length)) };
  }
  if (!Number.isInteger(length) || length < 8 || length > 128) throw new Error("generate: length must be a whole number from 8 to 128");
  const classes = [LOWER, UPPER, DIGITS, ...(symbols ? [SYMBOLS] : [])];
  const alphabet = classes.join("");
  let value;
  do {
    value = "";
    for (let i = 0; i < length; i++) value += pick(alphabet);
  } while (!classes.every(c => [...value].some(ch => c.includes(ch))));
  return { value, bits: floor1(length * Math.log2(alphabet.length)) };
}
