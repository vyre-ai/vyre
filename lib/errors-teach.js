// @ts-check
// lib/errors-teach: a refusal says what to do next. A caller that is told only "denied" or "no such thing" has to guess; a caller that is told who decides, or which tool lists the thing, or what to
// supply, can act. Two parts, both pure:
//   hasNextStep(message, names)   does the message carry a next step: a real tool named, a person who decides, or an instruction? The lint in test/errors-teach.test.js reads every refusal in the code
//                                 with it, so a new refusal cannot be written without one.
//   nextCall(message, catalog)    for the MCP server: the tools a message names, as ready calls (the name an agent calls it by and an example input from its schema), so the agent need not look them up.

import { exampleArgs } from "./tools-index.js";

/** A dotted registry tool name: `flows.list`, `work.team.add`. */
const TOOL = /(?<![A-Za-z0-9_.\-/])[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+(?![A-Za-z0-9_\-])/g;

/** Who decides, said plainly: the person, the owner, an admin. */
const WHO = /\b(the|a|an|your|their|that|this)\s+(person|owner|owners|admin|admins|administrator|user|member|space's owner|project lead|lead)\b|\b(ask|tell|show|wait for|hand|give|send)\b[^.]{0,30}\b(them|him|her|everyone|someone)\b|\b(someone|somebody)\b/i;

/** An instruction: a verb that starts a clause and tells the reader to do something. */
const DO = /(^|[.;:!?]\s+|\(|[,—-]\s+|\bto\s+|\bplease\s+|\bthen\s+|\bor\s+)(use|call|try|run|open|pair|sign in|sign it in|install|set|add|give|name|choose|pick|check|wait|retry|start|turn on|turn it on|enable|connect|send|read|see|list|remove|fix|move|put|leave|pass|say|type|pick|finish|approve|confirm|answer|include|supply|provide|specify|write|restore|re-?run|upgrade|update|reset|rename|release|renew|replace|unlock|claim|join|accept|decline|look|find|search|go|tap|press|click|reopen|resume|rejoin|re-pair|create|make|save|keep|drop|ask|tell|show|share|grant|revoke|stop|cancel|attach|pin|unpin|save|import|export|copy|choose|select|enter|paste|upload|download|begin|try again)\b/i;

/** "only the owner may", "needs a signed-in person": a requirement that says what to arrange. */
const NEEDS = /\b(only|needs?|requires?|must|has to|have to|until|before|first|instead|unless|so that)\b/i;

/**
 * Does a refusal's message carry a next step?
 * @param {string} message the text with any ${...} replaced by "x" @param {Set<string>} tools the registry's dotted tool names
 * @returns {{ ok: boolean, why: string, unknown: string[] }} `unknown` lists dotted names in the message that are not tools (a stale hint); they do not count as a next step
 */
export function hasNextStep(message, tools) {
  const named = [...message.matchAll(TOOL)].map((m) => m[0]);
  const real = named.filter((n) => tools.has(n));
  const unknown = named.filter((n) => !tools.has(n) && !/\.(com|org|net|io|run|md|json|js|txt|pdf|docx?|png|jpg|csv|app|dev|sh|yml|yaml|html?)$/.test(n) && /^[a-z]+\.[a-z][a-z-]*(\.[a-z-]+)*$/.test(n) && n.split(".").length > 1);
  if (real.length) return { ok: true, why: "names a tool", unknown: [] };
  if (WHO.test(message)) return { ok: true, why: "says who decides", unknown };
  if (DO.test(message)) return { ok: true, why: "gives an instruction", unknown };
  if (NEEDS.test(message)) return { ok: true, why: "says what is needed", unknown };
  return { ok: false, why: "", unknown };
}

/**
 * Ready calls for the tools a message names, for an agent that reaches tools through the MCP server.
 * @param {string} message @param {{ name: string, tool: string, input?: any }[]} catalog the caller's tools: the name it calls them by, the registry name, the input schema
 * @param {{ listed?: Set<string>, max?: number }} [o] `listed` is the MCP names the server lists itself (those are called directly; the rest through tools_call)
 * @returns {string[]} lines like `tools_call { tool: "flows_list", arguments: {} }`
 */
export function nextCall(message, catalog, o = {}) {
  const max = o.max ?? 2;
  const by = new Map(catalog.map((c) => [c.tool, c]));
  /** @type {string[]} */ const out = [];
  for (const m of message.matchAll(TOOL)) {
    const c = by.get(m[0]);
    if (!c || out.some((l) => l.includes(`"${c.name}"`))) continue;
    const args = JSON.stringify(exampleArgs(c.input));
    out.push(o.listed && o.listed.has(c.name) ? `${c.name} ${args}` : `tools_call { tool: "${c.name}", arguments: ${args} }`);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The refusals written as literals in a source file: refuse("message", "code") and Object.assign(new Error("message"), { code: "code" }). A `${...}` in a template is replaced by "x".
 * @param {string} source @returns {{ code: string, message: string, index: number }[]}
 */
export function refusalsIn(source) {
  /** @type {{ code: string, message: string, index: number }[]} */ const out = [];
  const lit = String.raw`(\x60[^\x60]*\x60|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')`;
  const clean = (/** @type {string} */ l) => l.slice(1, -1).replace(/\$\{[^}]*\}/g, "x").replace(/\\(["'\x60])/g, "$1");
  for (const m of source.matchAll(new RegExp(String.raw`\brefuse\(\s*${lit}\s*,\s*"([a-z_]+)"`, "g"))) out.push({ code: m[2], message: clean(m[1]), index: m.index || 0 });
  for (const m of source.matchAll(new RegExp(String.raw`Object\.assign\(\s*new Error\(\s*${lit}\s*\)\s*,\s*\{\s*code:\s*"([a-z_]+)"`, "g"))) out.push({ code: m[2], message: clean(m[1]), index: m.index || 0 });
  return out;
}
