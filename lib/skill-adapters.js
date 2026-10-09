// @ts-check
// lib/skill-adapters: SKILL.md is the one canonical skill format (R031-86); each harness reads it where it reads it. One adapter per harness says where a skill goes and, when the harness
// has no skills of its own, how it becomes plain instructions. A plugin runs on its own vendor's harness, and on another only where the capability rule says its needs are met.
// Vyre copies nothing a harness already reads on its own, re-implements no plugin's tools and hides no harness feature: it places, it routes, it says why a thing does not fit.
// Pure.

import { fit } from "./harness-caps.js";

/** Where each harness reads a skill is a provider fact, so the table lives with the drivers (core/sessions/drivers/skill-homes.js) and is passed in: { <harness>: { dir, file } }. */

/** Which harness runs a vendor's plugins natively. */
export const PLUGIN_HOMES = Object.freeze({ anthropic: "claude", claude: "claude", openai: "codex", chatgpt: "codex", codex: "codex", "x-ai": "grok", grok: "grok" });

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The harness that runs a registry model's provider. `claude`, `codex`, `grok` run their own; OpenRouter models run on the OpenRouter driver. @param {string} provider */
export const harnessOf = (provider) => (provider === "openrouter" ? "openrouter" : String(provider));

/**
 * Where a harness reads a skill, or null when it has no such place known.
 * @param {Record<string, { dir: string, file: string }>} homes @param {string} harness @param {string} name @returns {{ dir: string, file: string, path: string } | null}
 */
export function placement(homes, harness, name) {
  const home = homes[harness];
  if (!home || !SLUG.test(String(name))) return null;
  return { dir: home.dir, file: home.file, path: `${home.dir}/${name}/${home.file}` };
}

/**
 * How a skill reaches a harness. If the harness reads skills (it showed it does, or did not say and has a known place), the SKILL.md goes to its place, unchanged. If it showed it has none, or has
 * no known place, the skill becomes instructions: its name, its description and its body as one block for the session's own prompt. Never a rewrite of the skill's words.
 * @param {Record<string, { dir: string, file: string }>} homes @param {string} harness @param {{ name: string, description?: string, text: string, body?: string }} skill @param {Record<string, boolean | null> | null} [caps]
 * @returns {{ mode: "native", files: { path: string, text: string }[] } | { mode: "instructions", text: string }}
 */
export function render(homes, harness, skill, caps) {
  const at = placement(homes, harness, skill.name);
  if (at && !(caps && caps.skills === false)) return { mode: "native", files: [{ path: at.path, text: skill.text }] };
  const body = String(skill.body ?? skill.text).trim();
  return { mode: "instructions", text: `## Skill: ${skill.name}\n${skill.description ? `${skill.description}\n\n` : "\n"}${body}\n` };
}

/**
 * Where a plugin from a vendor can run: its own vendor's harness first (natively, always), then every other harness whose capabilities meet the plugin's needs. A harness with a missing
 * capability is listed with the reason, not silently skipped.
 * @param {string} vendor @param {string[] | undefined} needs @param {Record<string, Record<string, boolean | null> | null>} capsBy harness -> caps (null: never seen)
 * @returns {{ native: string | null, also: string[], not: { harness: string, reason: string }[] }}
 */
export function routePlugin(vendor, needs, capsBy) {
  const native = /** @type {Record<string, string>} */ (PLUGIN_HOMES)[String(vendor).toLowerCase()] || null;
  /** @type {string[]} */ const also = [];
  /** @type {{ harness: string, reason: string }[]} */ const not = [];
  for (const [h, caps] of Object.entries(capsBy)) {
    if (h === native) continue;
    const f = fit(needs, caps, { harness: h });
    if (f.works === false) not.push({ harness: h, reason: /** @type {string} */ (f.reason) }); else also.push(h);
  }
  return { native, also, not };
}
