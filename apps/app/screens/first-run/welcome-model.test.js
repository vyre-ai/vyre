import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODEL_COPY, SPACE_KEY, THEME_CHOICES, THEME_ICONS, UNLOCK_COPY, WELCOME_COPY, WELCOME_TONES, addressFrom, lastSpace, modelStep, rememberSpace } from "./welcome-model.js";

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), m }; };

test("the words are the owner's, and the password is never called a master password", () => {
  for (const v of Object.values(WELCOME_COPY)) assert.doesNotMatch(String(v), /master password/i);
});

test("the footer names the product's maker and links to its site", () => {
  assert.equal(WELCOME_COPY.footer, "A product of Clearfield Labs");
  assert.equal(WELCOME_COPY.footerUrl, "https://clearfieldlabs.com");
});

test("the theme choices are Light, Match this device and Dark, with the device in the middle", () => {
  assert.deepEqual(THEME_CHOICES.map((c) => c[1]), ["Light", "Match this device", "Dark"]);
  assert.deepEqual(THEME_CHOICES.map((c) => c[0]), ["paper", "system", "dark"]);
});

test("the last Space is remembered, and only a real name is", () => {
  const s = store();
  assert.equal(lastSpace(s), "");
  rememberSpace(s, "juniper");
  assert.equal(s.m.get(SPACE_KEY), "juniper");
  assert.equal(lastSpace(s), "juniper");
  rememberSpace(s, "../x"); rememberSpace(s, "");
  assert.equal(lastSpace(s), "juniper");
});

test("a storage that throws leaves the field empty and does not break", () => {
  const bad = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(lastSpace(bad), "");
  rememberSpace(bad, "juniper");
  assert.equal(lastSpace(null), "");
});

test("a name and a full address are the same Space", () => {
  assert.equal(addressFrom("juniper").space, "juniper");
  assert.equal(addressFrom(" Juniper.vyre.run ").address, "https://juniper.vyre.run");
  assert.equal(addressFrom(""), null);
  assert.equal(addressFrom("a b"), null);
});
