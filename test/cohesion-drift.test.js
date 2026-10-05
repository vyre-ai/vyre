// @ts-check
// Surfaces must not keep their own copies of lists another module owns (ADR 0036, map item 9).
//
// A surface that hardcodes model names drifts from sessions.models the day a model changes; a
// surface that copies the box's tool-policy sets (which tools need a person, which a passkey
// session covers) drifts the day presence adds one, and the Deck's copy already has. This test
// freezes today's copies in ALLOWED. A new copy fails. A copy that goes away must leave the list
// too, so the list only shrinks.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The surfaces: what a person sees. Box modules own these lists and may name them.
const SURFACES = ["deck", "local/capsule/native/Sources", "apps"];
const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.build)(\/|$)|\.test\.|Tests?\//;
const EXT = /\.(js|mjs|ts|tsx|swift|html)$/;

const RULES = {
  // A model id or a bare model alias as a string: the owner is sessions.models.
  models: /claude-(?:opus|sonnet|haiku)-\d[\w.-]*|["'](?:opus|sonnet|haiku)["']/g,
  // A copy of presence's tool-policy sets: the owner is core/presence.
  policy: /\b(?:const|let|var|static let)\s+(?:SESSIONABLE|HUMAN_ONLY|PERSON_ONLY)\b/g,
};

/** Today's copies, by rule, file and count. Shrink it as surfaces read the owner instead. */
const ALLOWED = {
  models: {
    "apps/ios/Vyre/Screens/Common.swift": 1, // debt: mobile, after 0.1.0
    "deck/views/agents.js": 3,
    // The Capsule's one fallback pair when sessions.models.get is missing (ModelFallback; CapsuleModel.models).
    "local/capsule/native/Sources/Vyred/Route.swift": 2,
  },
  policy: {
    "apps/app/src/auth/person.ts": 2, // debt: mobile, after 0.1.0
    "deck/js/api.js": 1,
  },
};

/** @param {string} dir @returns {string[]} */
function files(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (SKIP.test(rel)) continue;
    if (e.isDirectory()) out.push(...files(rel));
    else if (EXT.test(e.name)) out.push(rel);
  }
  return out;
}

function scan() {
  /** @type {Record<string, Record<string, number>>} */
  const found = Object.fromEntries(Object.keys(RULES).map(k => [k, {}]));
  for (const f of SURFACES.flatMap(files)) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const [rule, re] of Object.entries(RULES)) {
      const n = (text.match(re) || []).length;
      if (n) found[rule][f] = n;
    }
  }
  return found;
}

test("no surface adds a copy of a list another module owns", () => {
  const found = scan();
  const grown = [];
  for (const [rule, byFile] of Object.entries(found))
    for (const [f, n] of Object.entries(byFile))
      if (n > (ALLOWED[rule][f] || 0)) grown.push(`${rule}: ${f} has ${n} (allowed ${ALLOWED[rule][f] || 0})`);
  assert.deepEqual(grown, [], "read sessions.models or the presence tools instead of copying them (ADR 0036)");
});

test("the allowlist only shrinks: a copy that went away leaves it", () => {
  const found = scan();
  const stale = [];
  for (const [rule, byFile] of Object.entries(ALLOWED))
    for (const [f, n] of Object.entries(byFile))
      if ((found[rule][f] || 0) < n) stale.push(`${rule}: ${f} now has ${found[rule][f] || 0}, lower ALLOWED to match`);
  assert.deepEqual(stale, []);
});
