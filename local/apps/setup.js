// @ts-check
// setup: an app's one-time setup, done when a person first asks for something that needs it.
//
// Only Clock needs any. Its timer and alarm have no AppleScript; they are App Intents, which a
// shortcut can run without opening Clock. So Vyre writes two shortcuts, "Vyre Timer" and "Vyre
// Alarm", signs them with `shortcuts sign --mode anyone` (Shortcuts refuses to import an unsigned
// file), and opens each signed file, which shows Shortcuts' Add Shortcut button: one click each.
//
// A shortcut file is a property list whose actions name Shortcuts' internal identifiers. Those
// are not documented, and some could not be checked where this was written, so they sit in one
// table below (ACTIONS) for the check on a real Mac to correct. If an import shows an unknown
// action, the steps Vyre returns include how to build both shortcuts by hand, three steps each.

import fs from "node:fs";
import path from "node:path";
import { TIMER, ALARM } from "./adapters/clock.js";
import { AppsError } from "./env.js";

/**
 * Shortcuts' action identifiers. VERIFIED ones are long-standing actions seen in shared
 * shortcuts. UNVERIFIED ones are the best known and must be checked on a real Mac: import the
 * file, and if Shortcuts shows the action as unknown or with empty fields, build that shortcut
 * by hand (BY_HAND) and put the right identifier and parameter names here.
 */
export const ACTIONS = {
  getText: "is.workflow.actions.detect.text", // VERIFIED: Get Text from Input
  getNumbers: "is.workflow.actions.detect.number", // VERIFIED: Get Numbers from Input
  getDictionary: "is.workflow.actions.detect.dictionary", // VERIFIED: Get Dictionary from Input
  getValue: "is.workflow.actions.getvalueforkey", // VERIFIED: Get Dictionary Value
  startTimer: "is.workflow.actions.timer.start", // UNVERIFIED on macOS: Clock's Start Timer (WFDuration quantity)
  createAlarm: "com.apple.mobiletimer-framework.MobileTimerIntents.MTCreateAlarmIntent", // UNVERIFIED: Clock's Create Alarm
};

// Fixed ids for each action's output, so the files come out the same every time.
const U = {
  text: "8C1E3B0A-4F0D-4E7A-9C11-0A5F1D2E3B01",
  number: "8C1E3B0A-4F0D-4E7A-9C11-0A5F1D2E3B02",
  dict: "8C1E3B0A-4F0D-4E7A-9C11-0A5F1D2E3B03",
  time: "8C1E3B0A-4F0D-4E7A-9C11-0A5F1D2E3B04",
  label: "8C1E3B0A-4F0D-4E7A-9C11-0A5F1D2E3B05",
};

const input = { Value: { Type: "ExtensionInput" }, WFSerializationType: "WFTextTokenAttachment" };
const output = (/** @type {string} */ uuid, /** @type {string} */ name) => ({ Value: { OutputUUID: uuid, Type: "ActionOutput", OutputName: name }, WFSerializationType: "WFTextTokenAttachment" });
const inText = (/** @type {string} */ uuid, /** @type {string} */ name) => ({
  Value: { string: "￼", attachmentsByRange: { "{0, 1}": { OutputUUID: uuid, Type: "ActionOutput", OutputName: name } } },
  WFSerializationType: "WFTextTokenString",
});
const action = (/** @type {string} */ id, /** @type {Record<string, any>} */ params) => ({ WFWorkflowActionIdentifier: id, WFWorkflowActionParameters: params });

/** The frame every shortcut file has: it takes text or a file (what --input-path hands over). */
function shortcut(/** @type {any[]} */ actions) {
  return {
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowClientVersion: "2302.0.4",
    WFWorkflowIcon: { WFWorkflowIconStartColor: 4292093695, WFWorkflowIconGlyphNumber: 59446 },
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowInputContentItemClasses: ["WFStringContentItem", "WFGenericFileContentItem"],
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: [],
    WFWorkflowImportQuestions: [],
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
  };
}

/** Vyre Timer: its input is a number of seconds, as text in a file. */
export function timerShortcut() {
  return shortcut([
    action(ACTIONS.getText, { UUID: U.text, WFInput: input }),
    action(ACTIONS.getNumbers, { UUID: U.number, WFInput: output(U.text, "Text") }),
    action(ACTIONS.startTimer, {
      // UNVERIFIED: the magnitude as a variable attachment, the form a quantity field takes a variable in.
      WFDuration: { Value: { Magnitude: output(U.number, "Numbers"), Unit: "sec" }, WFSerializationType: "WFQuantityFieldValue" },
    }),
  ]);
}

/** Vyre Alarm: its input is JSON, {"time": "07:00", "label": "..."}. */
export function alarmShortcut() {
  return shortcut([
    action(ACTIONS.getText, { UUID: U.text, WFInput: input }),
    action(ACTIONS.getDictionary, { UUID: U.dict, WFInput: output(U.text, "Text") }),
    action(ACTIONS.getValue, { UUID: U.time, WFInput: output(U.dict, "Dictionary"), WFDictionaryKey: "time" }),
    action(ACTIONS.getValue, { UUID: U.label, WFInput: output(U.dict, "Dictionary"), WFDictionaryKey: "label" }),
    // UNVERIFIED parameter names: the Create Alarm intent's time and label.
    action(ACTIONS.createAlarm, { time: inText(U.time, "Dictionary Value"), label: inText(U.label, "Dictionary Value") }),
  ]);
}

const esc = (/** @type {string} */ s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A value as XML property list text. Strings, whole numbers, reals, booleans, arrays and dicts. */
export function plist(/** @type {any} */ value) {
  const one = (/** @type {any} */ v, /** @type {string} */ pad) => {
    if (typeof v === "string") return `${pad}<string>${esc(v)}</string>`;
    if (typeof v === "boolean") return `${pad}<${v}/>`;
    if (typeof v === "number") return Number.isInteger(v) ? `${pad}<integer>${v}</integer>` : `${pad}<real>${v}</real>`;
    if (Array.isArray(v)) return v.length ? `${pad}<array>\n${v.map(x => one(x, pad + "\t")).join("\n")}\n${pad}</array>` : `${pad}<array/>`;
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      if (!keys.length) return `${pad}<dict/>`;
      return `${pad}<dict>\n${keys.map(k => `${pad}\t<key>${esc(k)}</key>\n${one(v[k], pad + "\t")}`).join("\n")}\n${pad}</dict>`;
    }
    throw new Error(`a property list cannot hold ${typeof v}`);
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${one(value, "")}\n</plist>\n`;
}

export const WHY = "Clock's timer and alarm have no scripting; a shortcut runs them without opening Clock. Add each one once.";

/** How to build both by hand, for when an import shows an unknown action. */
export const BY_HAND = [
  `If Shortcuts says an action is unknown, make them by hand in the Shortcuts app instead.`,
  `${TIMER}: 1) New shortcut named "${TIMER}", add "Get Text from Input" on Shortcut Input. 2) Add "Get Numbers from Input" on that Text. 3) Add Clock's "Start Timer" with the Numbers as the duration, in seconds.`,
  `${ALARM}: 1) New shortcut named "${ALARM}", add "Get Text from Input" on Shortcut Input. 2) Add "Get Dictionary from Input" on that Text. 3) Add Clock's "Create Alarm", with the time set to "Get Dictionary Value" for key time, and the label to the value for key label.`,
];

/**
 * Clock's setup: write, sign and open the two shortcuts, unless they are already there.
 * @param {import("./env.js").Env} env @param {string} dir the folder under the Vyre home to keep them in
 * @returns {Promise<{ ready: boolean, steps: string[], files: string[], failed?: string[] }>}
 */
export async function setupClock(env, dir) {
  // Refused here, before a file is written, when signing or opening would be refused after.
  env.ready("Setting up Clock");
  const have = await env.shortcuts.list();
  const missing = [{ name: TIMER, build: timerShortcut }, { name: ALARM, build: alarmShortcut }].filter(s => !have.includes(s.name));
  if (!missing.length) return { ready: true, steps: [`Clock is set up: ${TIMER} and ${ALARM} are in Shortcuts.`], files: [] };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Sign both, then open both. One that fails does not stop the other; the steps say which.
  /** @type {{ name: string, file: string }[]} */
  const signed = [];
  /** @type {string[]} */
  const problems = [];
  for (const s of missing) {
    const unsigned = path.join(dir, `${s.name}.unsigned.shortcut`), out = path.join(dir, `${s.name}.shortcut`);
    // A signed file left from an earlier try would be opened even if signing failed now.
    fs.rmSync(out, { force: true });
    fs.writeFileSync(unsigned, plist(s.build()));
    try { await env.shortcuts.sign(unsigned, out); signed.push({ name: s.name, file: out }); }
    catch (e) { problems.push(`${s.name} could not be signed: ${/** @type {Error} */ (e).message}`); }
    finally { fs.rmSync(unsigned, { force: true }); }
  }
  /** @type {string[]} */
  const opened = [];
  for (const s of signed) {
    try { await env.openFile(s.file); opened.push(s.name); }
    catch (e) { problems.push(`${s.name} could not be opened: ${/** @type {Error} */ (e).message}. Open ${s.file} yourself.`); }
  }
  if (!signed.length) throw new AppsError("failed", `${problems.join("; ")}. ${BY_HAND[0]}`);
  return {
    ready: false,
    steps: [WHY, ...opened.map(n => `Shortcuts has opened ${n}: click Add Shortcut.`), ...problems,
      "Then ask again, for example: timer 10 min.", ...BY_HAND],
    files: signed.map(s => s.file),
    ...(problems.length ? { failed: problems } : {}),
  };
}

/** The setup for an app, or a refusal for an app that needs none. */
export function setupFor(/** @type {string} */ adapterId) {
  if (adapterId === "clock") return setupClock;
  return null;
}
