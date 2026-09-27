// @ts-check
// Derived from Paseo (https://github.com/getpaseo/paseo), packages/app/src/utils/agent-command-autocomplete.ts
// and packages/app/src/client-slash-commands/index.ts,
// Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0. Modified for Vyre: plain JS, "/" only at the start of the message, a static list in place of the provider's.
//
// "/" commands for the composer's picker: where the command being typed is (the caret must be in
// the first word, which starts with "/"), which commands match it best, and the text once one is
// picked. No DOM: shared core, tested on its own (commands.test.js).
//
// Where the list comes from. threads.commands {thread} (proposed to the sessions team) gives the
// session's own: built-ins, the user's and the project's, plugins' and skills', each with its
// source; normalizeCommands() makes that list the picker's shape. On a box without it the picker
// offers this static list: Claude Code's built-in commands that work in a session the box runs,
// and the one the Vyre plugin adds (harness/commands/vyre.md). Whatever is typed still goes to
// threads.send verbatim, except the commands the composer answers itself (`local`: /model opens
// the model picker, /rewind the rewind picker), which are always offered.

import { scoreFields, compareScores } from "./match.js";

/**
 * source: "session" (built in), "project", "user", "plugin", "skill", "vyre". local: the composer
 * does it itself, nothing is sent.
 * @typedef {{ name: string, description: string, hint?: string, aliases?: string[], source: string, local?: "model"|"rewind" }} Command
 */

/** @type {readonly Command[]} */
export const COMMANDS = Object.freeze([
  { name: "compact", description: "Summarise the conversation so far to free up context", hint: "[what to keep]", source: "session" },
  { name: "context", description: "Show how much of the context window is in use", source: "session" },
  { name: "cost", description: "Show what this session has cost so far", source: "session" },
  { name: "clear", description: "Start the conversation over", aliases: ["reset", "new"], source: "session" },
  { name: "init", description: "Write a project guide for this folder", source: "session" },
  { name: "review", description: "Review a pull request", hint: "[pr]", source: "session" },
  { name: "rename", description: "Rename this session", hint: "<name>", source: "session" },
  { name: "model", description: "Switch the model for this session", hint: "[model]", source: "session", local: "model" },
  { name: "rewind", description: "Go back to an earlier message", source: "session", local: "rewind" },
  { name: "vyre", description: "Vyre status, ask an agent, recall past sessions, remember a lesson", hint: "[status | ask | recall | remember]", source: "vyre" },
]);

/** @typedef {{ start: number, end: number, query: string }} CommandRange */

const INVALID = /[/\s"']/;

/**
 * The "/" command at the caret: only in the message's first word, which starts with "/".
 * Null when there is none.
 * @param {string} text @param {number} caret @returns {CommandRange|null}
 */
export function findCommand(text, caret) {
  const end = Math.max(0, Math.min(caret, text.length));
  if (text[0] !== "/" || end < 1) return null;
  const query = text.slice(1, end);
  if (INVALID.test(query)) return null;
  return { start: 0, end, query };
}

/**
 * Commands that match the query, best first; ties by name. An empty query keeps the list's order.
 * @template {{ name: string, aliases?: readonly string[] }} C
 * @param {readonly C[]} commands @param {string} query @returns {C[]}
 */
export function rankCommands(commands, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const scored = [];
  for (const c of commands) {
    const score = scoreFields(q, [c.name, ...(c.aliases || [])]);
    if (score) scored.push({ c, score });
  }
  scored.sort((a, b) => compareScores(a.score, b.score) || a.c.name.localeCompare(b.c.name));
  return scored.map(s => s.c);
}

/**
 * The text with the command in place of what was typed, and where the caret goes: after the name
 * and one space, so the arguments can follow.
 * @param {string} text @param {CommandRange} range @param {string} name
 * @returns {{ text: string, caret: number }}
 */
export function applyCommand(text, range, name) {
  const before = text.slice(0, range.start), after = text.slice(range.end);
  const word = `/${name}`;
  const gap = after.startsWith(" ") ? "" : " ";
  return { text: before + word + gap + after, caret: before.length + word.length + 1 };
}

/** The badge each source shows in the picker; built-ins show none. */
export const SOURCE_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  session: "", builtin: "", "built-in": "", project: "project", user: "yours", plugin: "plugin", skill: "skill", vyre: "vyre", mcp: "mcp",
}));

/** @param {string} source */
export const sourceLabel = source => (source in SOURCE_LABELS ? SOURCE_LABELS[source] : String(source || ""));

/**
 * threads.commands' answer as the picker's list: names without their slash, sources as given
 * ("builtin" read as "session"), unique by name (the first wins), and the composer's own local
 * commands added when the session does not name them. Anything else (an older box's {}) gives the
 * static list.
 * @param {unknown} list @returns {Command[]}
 */
export function normalizeCommands(list) {
  if (!Array.isArray(list) || !list.length) return [...COMMANDS];
  /** @type {Map<string, Command>} */
  const out = new Map();
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const name = String(/** @type {any} */ (c).name ?? "").replace(/^\//, "").trim();
    if (!name || /\s/.test(name) || out.has(name)) continue;
    const src = String(/** @type {any} */ (c).source ?? "session");
    /** @type {Command} */
    const cmd = { name, description: String(/** @type {any} */ (c).description ?? ""), source: src === "builtin" || src === "built-in" ? "session" : src };
    const hint = /** @type {any} */ (c).argumentHint ?? /** @type {any} */ (c).hint;
    if (hint) cmd.hint = String(hint);
    const local = COMMANDS.find(x => x.local && x.name === name);
    if (local) cmd.local = local.local;
    out.set(name, cmd);
  }
  for (const c of COMMANDS) if (c.local && !out.has(c.name)) out.set(c.name, c);
  return [...out.values()];
}
