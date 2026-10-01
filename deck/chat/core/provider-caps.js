// @ts-check
// What chat may offer for a session, from what its provider declares (PLAN.md C14b; the flags are
// lib/caps-flags). Pure: no DOM and no tool calls, so every surface and test reads the same answer.
//
// Two sources, never mixed up (reviewer-2 M1 on the native-core plan):
//   live      providers.list's caps for the session's provider now. Every control that ACTS
//             (rewind, fork, model switch, interrupt, resume, send an image) reads this, so an
//             adapter upgrade that dropped a feature never leaves a button that fails.
//   snapshot  threads.get's caps, what the session ran under. Only for RENDERING what already
//             happened (a finished plan card, an old usage line).
//
// Each control comes back as { state: "on" | "off" | "hidden", reason? }. "hidden" is for a
// control whose absence is expected (no mode chip on a provider with no modes); "off" is for one a
// person would look for, with a one-line reason in plain words ("ChatGPT can't rewind yet").
// Which controls hide and which explain is app-design's call; HIDE below is the proposal until
// their capability board lands.

import { normalizeCaps } from "../../../lib/caps-flags/index.js";

/** @typedef {{ state: "on" | "off" | "hidden", reason?: string }} Control */

/** Controls that disappear, rather than explain, when the provider lacks them (app-design to confirm). */
export const HIDE = new Set(["modes", "plan", "thinking", "effort", "tasks", "subagents", "usage", "remember"]);

/**
 * A provider's live caps from providers.list, normalized; all off when the provider is unknown
 * (a session whose provider was removed), so nothing offers what can't run.
 * @param {any[]|null|undefined} providers providers.list's rows
 * @param {string|null|undefined} provider
 */
export function liveCaps(providers, provider) {
  const row = (providers || []).find(p => p && p.provider === provider);
  return normalizeCaps(row ? row.caps : null);
}

/** A thread's snapshot caps from threads.get, normalized; for rendering past items only. @param {any} thread */
export const snapshotCaps = thread => normalizeCaps(thread ? thread.caps : null);

/**
 * The state of every chat control for a provider's live caps.
 * @param {Record<string, any>} caps normalizeCaps' output (liveCaps)
 * @param {string} label the provider as a person knows it ("Claude", "ChatGPT", "Gemini")
 * @returns {Record<string, Control>}
 */
export function controls(caps, label) {
  const who = String(label || "This AI");
  /** @param {string} name @param {boolean} on @param {string} why the one-line reason, in plain words */
  const c = (name, on, why) => on ? { state: /** @type {const} */ ("on") }
    : HIDE.has(name) ? { state: /** @type {const} */ ("hidden") }
    : { state: /** @type {const} */ ("off"), reason: why };
  const cant = (/** @type {string} */ what) => `${who} can't ${what} yet`;
  return {
    steer: c("steer", caps.steer, `${who} reads a new message after the current turn ends`),
    queue: c("queue", caps.queue, cant("queue messages")),
    interrupt: c("interrupt", caps.interrupt, cant("be stopped mid-turn")),
    resume: c("resume", caps.resume, cant("pick up a closed session")),
    rewind: c("rewind", caps.rewind.conversation, cant("rewind a conversation")),
    rewindCode: c("rewindCode", caps.rewind.code, cant("undo its file changes")),
    fork: c("fork", caps.fork, cant("fork a session")),
    modes: c("modes", caps.modes.length > 0, cant("switch modes")),
    plan: c("plan", caps.plan, cant("plan first")),
    questions: c("questions", caps.questions, cant("ask you questions")),
    thinking: c("thinking", caps.thinking, cant("show its thinking")),
    effort: c("effort", caps.effort, cant("change its effort")),
    images: c("images", caps.images, cant("read images")),
    commands: c("commands", caps.commands, cant("run slash commands")),
    tasks: c("tasks", caps.tasks, cant("run background tasks")),
    subagents: c("subagents", caps.subagents, cant("run subagents")),
    modelSwitch: c("modelSwitch", caps.model_switch, `${who} keeps its model for the whole session`),
    usage: c("usage", caps.usage !== "none", cant("report usage")),
    remember: c("remember", caps.remember !== null, cant("keep project memory in a file")),
  };
}

/**
 * What the context meter can show: "full" (context, tokens and cost), "context" (occupancy only,
 * ACP's coarse usage), or null (nothing, never zeros).
 * @param {Record<string, any>} caps
 */
export const meter = caps => caps.usage === "detailed" ? "full" : caps.usage === "coarse" ? "context" : null;
