// @ts-check
// One model service (lib/model-registry.js, core/models): no surface and no module keeps its own list of model names. A literal list of two or more model names ("opus", "Sonnet", "claude-haiku-4-5",
// "gpt-5", "grok-4") in the app, core, lib, the kernel or the harness is a copy that goes stale the day a provider ships a model, and it gives one provider a place no other has. Pickers read
// sessions.accounts.models (the person's own accounts, every model with its details) and nothing else. Existing copies are in test/no-model-lists.json with the reason each stays; the count per file may only
// go down, and a new list fails until it reads the service instead. (The a5-no-copies style: test/a5-no-copies.test.js.)
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["apps/app/app", "apps/app/src", "apps/app/screens", "apps/app/ui", "core", "lib", "kernel", "harness", "web", "local"];
const SKIP_DIR = new Set(["node_modules", "dist", "dist-mock", ".git", ".expo", ".build", "build", "vendor", "fixtures", "testing", "generated"]);
const SKIP_FILE = /\.test\.|\.generated\.|mock|gallery|fixture|\/test\//i;

/** A string that is a model's name or id, whole: a Claude family word, a dated or versioned Claude id, or a GPT, Grok, Gemini or Llama id. */
export const MODEL = /^(?:claude[- ])?(?:opus|sonnet|haiku|fable|mythos)(?:[- ]\d+(?:[.-]\d+)*)?(?:-\d{8})?$|^claude-[a-z]+-\d[\w.-]*$|^(?:gpt|grok|gemini|llama)-?\d[\w.-]*$/i;

/** The keys under which an object in a list names a choice: a list of { id, label } objects is a list of models; a record that says which `model` it runs on is not. */
const CHOICE_KEYS = new Set(["id", "label", "name", "value", "title", "slug"]);
/** The property a string at `at` is the value of ("label" in `label: "Opus"`), or "" for a string that stands on its own. @param {string} src @param {number} at */
function keyBefore(src, at) {
  let j = at - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (src[j] !== ":") return "";
  j--;
  while (j >= 0 && /\s/.test(src[j])) j--;
  let k = "";
  while (j >= 0 && /[\w"']/.test(src[j])) { k = src[j] + k; j--; }
  return k.replace(/["']/g, "");
}

/** @param {string} dir @param {string[]} out */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/**
 * How many array literals in a source hold two or more model names (strings, or the `id` and `label` of objects in it). Strings, comments, regular expressions and template literals are read past, so a
 * bracket inside one does not count; a list inside a list counts once, as the innermost list that holds them.
 * @param {string} src
 */
export function modelLists(src) {
  /** @type {{ n: number }[]} */ const stack = [];
  let hits = 0, i = 0, prev = "";
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); i = j < 0 ? src.length : j; continue; }
    if (c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? src.length : j + 2; continue; }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%~^".includes(prev))) {
      // a regular expression literal: to its closing slash, past escapes and character classes
      let j = i + 1, inClass = false;
      while (j < src.length && src[j] !== "\n") { const d = src[j]; if (d === "\\") { j += 2; continue; } if (d === "[") inClass = true; else if (d === "]") inClass = false; else if (d === "/" && !inClass) break; j++; }
      i = j + 1; prev = "/"; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, buf = "";
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") { buf += src[j + 1] || ""; j += 2; continue; } if (c !== "`" && src[j] === "\n") break; buf += src[j]; j++; }
      const key = keyBefore(src, i);
      if (c !== "`" && stack.length && MODEL.test(buf.trim()) && (!key || CHOICE_KEYS.has(key))) stack[stack.length - 1].n++;
      i = j + 1; prev = '"'; continue;
    }
    if (c === "[") stack.push({ n: 0 });
    else if (c === "]" && stack.length) { const a = /** @type {{ n: number }} */ (stack.pop()); if (a.n >= 2) hits++; else if (stack.length) stack[stack.length - 1].n += a.n; }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return hits;
}

/** Lists found: { "<file>": count }. */
function scan() {
  /** @type {Record<string, number>} */ const found = {};
  for (const d of DIRS) for (const f of walk(path.join(ROOT, d))) {
    const rel = path.relative(ROOT, f).split(path.sep).join("/");
    if (!/\.(js|mjs|cjs|ts|tsx)$/.test(f) || SKIP_FILE.test("/" + rel)) continue;
    const n = modelLists(fs.readFileSync(f, "utf8"));
    if (n) found[rel] = n;
  }
  return found;
}

test("no hard-coded list of model names: every picker reads the one model service (the baseline may only shrink)", () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "no-model-lists.json"), "utf8")).lists;
  const found = scan();
  const worse = Object.entries(found).filter(([k, n]) => n > (base[k] ? base[k].count : 0)).map(([k, n]) => `${k}: ${n} (allowed ${base[k] ? base[k].count : 0})`);
  assert.deepEqual(worse, [], `a literal list of model names: read the models a person can run from sessions.accounts.models (lib/model-registry.js modelView) instead. Found now: ${JSON.stringify(found)}`);
  const stale = Object.keys(base).filter(k => !found[k] || found[k] < base[k].count).map(k => `${k}: found ${found[k] || 0}, baseline ${base[k].count}`);
  assert.deepEqual(stale, [], "a list was removed: lower its number in test/no-model-lists.json");
});

test("the guard sees a list of model names in any form and leaves other words, a single default and prose alone", () => {
  assert.equal(modelLists(`export const MODEL_ALIASES = Object.freeze([{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }]);`), 1);
  assert.equal(modelLists(`const M = ["claude-opus-4-8", "claude-haiku-4-5"];`), 1);
  assert.equal(modelLists(`const M = ['gpt-5', 'grok-4'];`), 1);
  assert.equal(modelLists(`const M = [{ id: "fast", label: "Claude Sonnet" }, { id: "deep", label: "Claude Opus" }];`), 1);
  assert.equal(modelLists(`const W = ["red", "green", "blue"];`), 0);
  assert.equal(modelLists(`const D = { chat: "opus" }; const one = ["opus"];`), 0, "one default is not a list");
  assert.equal(modelLists(`const asks = ["Switch this chat to Opus", "Use Haiku for this thread"];`), 0, "sentences that name a model are not a list of models");
  assert.equal(modelLists(`const re = /["(opus|sonnet)"]/; const s = "[opus, sonnet]"; // ["opus", "sonnet"]\n`), 0, "a regular expression, a string and a comment are read past");
  assert.equal(modelLists(`const L = [["opus", "sonnet"], ["haiku", "fable"]];`), 2, "the innermost lists count");
  assert.equal(modelLists(`const agents = [{ name: "juno", model: "Claude Sonnet 5.5" }, { name: "kit", model: "Claude Opus 5.5" }];`), 0, "records that each say which model they run on are not a list of models to pick from");
});
