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

// The theme reads tokens v2 under kebab names ("text2" is "text-2"); a name it does not have is undefined, and React Native draws undefined text black.
const v2 = JSON.parse(readFileSync(new URL("../../../../lib/theme/tokens.json", import.meta.url), "utf8")).v2.color;
const kebab = (s) => s.replace(/[A-Z0-9]/g, (c) => "-" + c.toLowerCase());
const scheme = (name) => Object.fromEntries(Object.entries(v2[name]).map(([k, v]) => [kebab(k), v]));
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("every colour on the welcome and unlock screens is a token the theme has, in light and in dark", () => {
  for (const name of ["paper", "dark"]) {
    const c = scheme(name);
    for (const [part, tone] of Object.entries(WELCOME_TONES)) assert.ok(typeof c[tone] === "string", `${part} uses ${tone}, which ${name} does not have`);
  }
});

test("the line under the greeting and the wordmark are readable on the page in light and in dark", () => {
  const words = ["wordmark", "sub", "greeting", "line", "fieldLead", "fieldText", "link", "footer", "error"];
  for (const name of ["paper", "dark"]) {
    const c = scheme(name);
    for (const w of words) assert.ok(contrast(c[WELCOME_TONES[w]], c.bg) >= 4.5, `${w} (${WELCOME_TONES[w]}) on ${name} bg is ${contrast(c[WELCOME_TONES[w]], c.bg).toFixed(2)}:1`);
  }
  assert.equal(WELCOME_TONES.line, "text-2");
  assert.equal(WELCOME_TONES.wordmark, "text");
});

test("the theme switch is three icons from the one icon set, sun, device and moon, in the choices' order", () => {
  const names = JSON.parse(/ICON_NAMES = (\[[^\]]*\])/.exec(readFileSync(new URL("../../src/ui/icons.generated.ts", import.meta.url), "utf8"))[1]);
  assert.deepEqual(THEME_CHOICES.map((c) => THEME_ICONS[c[0]]), ["sun", "laptop", "moon"]);
  for (const i of Object.values(THEME_ICONS)) assert.ok(names.includes(i), `${i} is not in the icon set`);
});

test("the unlock cover's words have no em dash and keep the recovery switch", () => {
  for (const v of [...Object.values(UNLOCK_COPY), ...Object.values(WELCOME_COPY)]) assert.doesNotMatch(String(v), /\u2014/);
  assert.equal(UNLOCK_COPY.useRecovery, "Use my recovery key");
  assert.equal(UNLOCK_COPY.usePassword, "Use my password");
});

test("the model step's Continue follows the models, not the accounts: an account with no models never leaves a dead button", () => {
  const one = [{ models: [{ id: "m1" }] }];
  assert.deepEqual(modelStep(null, false), { lead: MODEL_COPY.lead, count: 0, canContinue: false }, "still looking");
  assert.equal(modelStep(one, false).canContinue, false, "a model to pick: Continue waits for the pick");
  assert.equal(modelStep(one, true).canContinue, true);
  const empty = modelStep([{ models: [] }, { models: [] }], false);
  assert.deepEqual(empty, { lead: MODEL_COPY.noModels, count: 0, canContinue: true }, "accounts with no models: Continue goes on with the default and the line says so");
  assert.deepEqual(modelStep([], false), { lead: MODEL_COPY.none, count: 0, canContinue: true }, "no account: the line says how to connect one");
  for (const v of Object.values(MODEL_COPY)) if (typeof v === "string") assert.doesNotMatch(v, new RegExp("[\\u2014\\u00a7]"), "plain words: no long dash, no section sign");
});
