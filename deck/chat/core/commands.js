// @ts-check
// Derived from Paseo (https://github.com/getpaseo/paseo), packages/app/src/utils/agent-command-autocomplete.ts
// and packages/app/src/client-slash-commands/index.ts,
// Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0. Modified for Vyre: plain JS, "/" only at the start of the message, a static list in place of the provider's.
//
// "/" commands for the composer's picker: where the command being typed is (the caret must be in
// the first word, which starts with "/"), which commands match it best, and the text once one is
// picked. No DOM: shared core, tested on its own (commands.test.js).
//
// Where the list comes from. Claude Code names its commands in the system init message
// (slash_commands), but the Switchboard keeps only the session id and model from it
// (core/switchboard/translate.js), so no thread record or threads.get carries them. Until one
// does, the picker offers this static list: Claude Code's built-in commands that work in a
// session the box runs, and the one the Vyre plugin adds (harness/commands/vyre.md). Whatever
// is typed still goes to threads.send verbatim; the list only helps to find a name.

import { scoreFields, compareScores } from "./match.js";

/** @typedef {{ name: string, description: string, hint?: string, aliases?: string[], source: "session" | "vyre" }} Command */

/** @type {readonly Command[]} */
export const COMMANDS = Object.freeze([
  { name: "compact", description: "Summarise the conversation so far to free up context", hint: "[what to keep]", source: "session" },
  { name: "context", description: "Show how much of the context window is in use", source: "session" },
  { name: "cost", description: "Show what this session has cost so far", source: "session" },
  { name: "clear", description: "Start the conversation over", aliases: ["reset", "new"], source: "session" },
  { name: "init", description: "Write a project guide for this folder", source: "session" },
  { name: "review", description: "Review a pull request", hint: "[pr]", source: "session" },
  { name: "rename", description: "Rename this session", hint: "<name>", source: "session" },
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
