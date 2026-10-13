// @vyre/ui tasks: the kinds of ask a Needs you card can be, and what each one needs on screen (pure, no React, no store; ask-model.test.js).
// The card model (model.js cardModel) says what the words and buttons are; this says which control answers it, where an answered file lands,
// where "Open chat" goes, when "Later" brings a card back, and which cards fold into one group.

import { hourOf } from "../../src/time/show.js";

/** Credentials a stuck task names: its suggested fix points at a Vault item, or says a password, key, token or sign-in is the problem. */
const CREDENTIAL = /\b(vault|password|passphrase|credential|api key|token|sign-?in|log ?in)\b/i;

/**
 * The control a card asks the person to use.
 * @param {{ reason: "check"|"do"|"stuck"|null, inline?: { kind: string }, actions: { id: string }[] }} card cardModel's result
 * @param {any} task
 * @returns {"date"|"text"|"file"|"yes_no"|"send"|"check"|"credential"|"stuck"|"todo"|"watch"}
 */
export function askKind(card, task) {
  const has = (/** @type {string} */ id) => card.actions.some((a) => a.id === id);
  if (card.reason === "check") return task.output?.kind === "sent" ? "send" : "check";
  if (card.reason === "stuck") return vaultItemOf(task) !== null || CREDENTIAL.test(`${task.stuck?.reason || ""} ${task.stuck?.suggested_fix?.text || ""}`) ? "credential" : "stuck";
  if (card.reason === "do") {
    if (card.inline) return card.inline.kind === "date" ? "date" : "text";
    if (has("file")) return "file";
    if (has("yes")) return "yes_no";
    return "todo";
  }
  return "watch";
}

/**
 * The Vault item a stuck task is about, or null: the fix's own `open_vault_item` resource (a urn or a bare name), else a name the fix text puts in quotes
 * ("Update the "court-portal" password in the Vault"). Never a guess from other words.
 * @param {any} task
 */
export function vaultItemOf(task) {
  const fix = task?.stuck?.suggested_fix;
  const act = fix && fix.action;
  if (act && act.kind === "open_vault_item" && typeof act.resource === "string" && act.resource) return act.resource.split("/").pop() || null;
  const quoted = /["“']([A-Za-z0-9][A-Za-z0-9 ._-]{1,60})["”']/.exec(String(fix?.text || ""));
  return quoted && /vault/i.test(String(fix?.text)) ? quoted[1] : null;
}

/** The path the Vault opens at to add that item, prefilled: /u/vault?add=<name>&kind=<login|api-key>. @param {any} task */
export function vaultAddRoute(task) {
  const item = vaultItemOf(task);
  const kind = /password|sign-?in|log ?in/i.test(`${task?.stuck?.reason || ""} ${task?.stuck?.suggested_fix?.text || ""}`) ? "login" : "api-key";
  return `/u/vault?add=${item ? encodeURIComponent(item) : "1"}&kind=${kind}`;
}

const clean = (/** @type {string} */ s) => s.replace(/[\\:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
const idOf = (/** @type {unknown} */ urn) => (typeof urn === "string" && urn ? urn.split("/").pop() || "" : "");

/**
 * Where an answered file lands in the space's Files, and how the card says so. The ask can name a folder itself (an output target with a "/" in it); else the
 * task's project folder, else the record's, else a catch-all. Never a path that climbs out ("..") or starts with a slash.
 * @param {any} task @param {{ recordTitle?: string }} [o]
 * @returns {{ folder: string, words: string }}
 */
export function landing(task, o = {}) {
  const target = typeof task?.output?.target === "string" ? task.output.target.trim() : "";
  const named = target.includes("/") ? target.split("/").map(clean).filter((p) => p && p !== "..").join("/") : "";
  if (named) return { folder: named, words: `Goes in ${named}.` };
  const project = idOf(task?.project);
  if (project) return { folder: `Projects/${project}/files`, words: `Goes in the project's files${target ? `, as ${target}` : ""}.` };
  const rec = clean(o.recordTitle || "");
  if (rec) return { folder: `Records/${rec}`, words: `Goes in ${rec}'s files${target ? `, as ${target}` : ""}.` };
  return { folder: "Task files", words: `Goes in Task files${target ? `, as ${target}` : ""}.` };
}

/** A file name safe to put at a path: the base name only. @param {string} name */
export const fileNameOf = (name) => clean(String(name).split(/[\\/]/).pop() || "file") || "file";

/**
 * Where "Open chat" goes for a card, from what the task carries: the chat that works it (`form.thread`, written when the agent is woken), the chat that made it (`session`), else its record, else the Flow that gave it. null when the
 * task names none of them (a manual to-do).
 * @param {any} task @returns {{ route: string, label: string } | null}
 */
export function openTarget(task) {
  if (typeof task?.form?.thread === "string" && task.form.thread) return { route: `/u/chats/${encodeURIComponent(task.form.thread)}`, label: "Open chat" };
  if (typeof task?.session === "string" && task.session) return { route: `/u/chats/${encodeURIComponent(task.session)}`, label: "Open chat" };
  if (typeof task?.record === "string" && task.record) return { route: `/u/record/${encodeURIComponent(idOf(task.record))}`, label: "Open record" };
  if (typeof task?.flow === "string" && task.flow) return { route: `/u/flows/${encodeURIComponent(task.flow)}`, label: "Open Flow" };
  return null;
}

// ------------------------------------------------------------------------------------------------------------------------------ Later

const HOUR = 3_600_000;

/** The next time the clock reads `hour` o'clock (this device's zone) after `now`. @param {number} now @param {number} [hour] */
export function nextMorning(now, hour = 8) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** The choices under "Later". Tonight is left out after 6 pm, tomorrow is never today. @param {number} now @returns {{ id: string, label: string, until: number }[]} */
export function laterChoices(now) {
  const out = [{ id: "hour", label: "In an hour", until: now + HOUR }];
  if (hourOf(now) < 18) { const t = new Date(now); t.setHours(18, 0, 0, 0); out.push({ id: "evening", label: "This evening", until: t.getTime() }); }
  out.push({ id: "morning", label: "Tomorrow morning", until: nextMorning(now) });
  const w = new Date(now); w.setDate(w.getDate() + ((8 - w.getDay()) % 7 || 7)); w.setHours(8, 0, 0, 0);
  out.push({ id: "monday", label: "Next Monday", until: w.getTime() });
  return out;
}

/** The ids not snoozed at `now`. A snooze that has run out is gone. @param {Record<string, number>} snoozed id -> until @param {number} now */
export function stillSnoozed(snoozed, now) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [id, until] of Object.entries(snoozed || {})) if (typeof until === "number" && until > now) out[id] = until;
  return out;
}

/** The snooze table as stored text read back, or {} when it is anything else. @param {unknown} raw */
export function readSnoozed(raw) {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    /** @type {Record<string, number>} */
    const out = {};
    for (const [k, u] of Object.entries(v)) if (typeof u === "number" && Number.isFinite(u)) out[k] = u;
    return out;
  } catch { return {}; }
}

// ------------------------------------------------------------------------------------------------------------------------------ groups

/** More than this many cards from one place fold into one group. */
export const GROUP_OVER = 3;

/**
 * Fold the cards that come from one project or Flow into a group when there are more than three of them. Order stays: a group sits where its first card was.
 * @template T
 * @param {T[]} list @param {(item: T) => string | null | undefined} keyOf the project or Flow a card is from, or nothing
 * @returns {({ group: false, item: T } | { group: true, key: string, items: T[] })[]}
 */
export function groupAsks(list, keyOf) {
  /** @type {Map<string, T[]>} */
  const by = new Map();
  for (const it of list) { const k = keyOf(it); if (k) by.set(k, [...(by.get(k) || []), it]); }
  const big = new Set([...by].filter(([, v]) => v.length > GROUP_OVER).map(([k]) => k));
  /** @type {({ group: false, item: T } | { group: true, key: string, items: T[] })[]} */
  const out = [];
  const placed = new Set();
  for (const it of list) {
    const k = keyOf(it);
    if (k && big.has(k)) { if (!placed.has(k)) { placed.add(k); out.push({ group: true, key: k, items: by.get(k) || [] }); } } else out.push({ group: false, item: it });
  }
  return out;
}

/** Where a card is from, for grouping: its project, else its Flow. @param {any} task */
export const groupKeyOf = (task) => idOf(task?.project) ? `project:${idOf(task.project)}` : typeof task?.flow === "string" && task.flow ? `flow:${task.flow}` : null;

// ------------------------------------------------------------------------------------------------------------------------------ dates

const p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
/** 2026-10-28 for a Date, in this device's zone. @param {Date} d */
export const dayText = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
/** The date a text is, or null: 2026-10-28 only, and only a real day. @param {string} s */
export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? dayText(d) : null;
}
/** The quick days under a date picker: today, tomorrow, next week. @param {number} now @returns {{ label: string, value: string }[]} */
export function quickDays(now) {
  const at = (/** @type {number} */ n) => { const d = new Date(now); d.setDate(d.getDate() + n); return dayText(d); };
  return [{ label: "Today", value: at(0) }, { label: "Tomorrow", value: at(1) }, { label: "In a week", value: at(7) }];
}
