// @ts-check
// The composer's rules, shared by the Deck and the phone (no DOM, no Node APIs): the same keys as
// Claude Code in the terminal, defined once here so both surfaces read one map.
//
// - What the draft is, by its first character: "/" a command, "!" a shell command run in the
//   session's folder, "#" something to remember (CLAUDE.md), "@role " a project teammate's own
//   turn (teammates.md section 2 - team_ask, not this session's), anything else a message. An "@"
//   mention is also found anywhere at the caret (a different feature: inserting a reference).
// - Enter: idle sends; while a turn runs a message steers it (joins at its next step) unless
//   Alt+Enter, or the "Queue for after this turn" toggle, queues it for after. A command typed
//   while a turn runs is queued (a command is not something to steer with). Shift+Enter is a new
//   line; on a touch screen Enter is a new line and the send button sends.
// - Esc: closes a picker; stops a running turn; leaves the shell or memory mode; twice within
//   800 ms with an empty draft opens the rewind picker, with words in the draft clears them.
// - Shift+Tab: the next permission mode, over default, acceptEdits and plan (threads.mode never
//   takes bypass, so Shift+Tab never reaches it).
// - Up in an empty composer: the last message sent (again for older), or, when messages wait in
//   the queue, the newest of those to edit.
// - Pasted images: a count cap and a size cap, png, jpeg, gif and webp only.

/** @typedef {"message"|"command"|"shell"|"memory"|"teammate"} DraftKind */
/** @typedef {"steer"|"queue"} SendMode */

// ---- models --------------------------------------------------------------------------------

/** The model's family name, never the vendor's: a full Opus id reads as opus. @param {string|null|undefined} m */
export const shortModel = m => (m ? (/(opus|sonnet|haiku|fable)/i.exec(m)?.[1]?.toLowerCase() || String(m).replace(/^claude-/i, "")) : null);

/**
 * The model picker's rows: the box's aliases (sessions.models.get's `aliases`, its one list), then
 * every other id it names, from its per-purpose map ({purposes: {chat: {model}, ...}}, "Used for
 * chat, agent") and this thread's own (thread.started, the record). "now" marks the thread's
 * model: the exact id, else its family's alias. No list lives here (test/cohesion-drift.test.js).
 * @param {{ current?: string|null, purposes?: any, aliases?: any, seen?: (string|null|undefined)[] }} o
 * @returns {{ id: string, label: string, description?: string, now: boolean }[]}
 */
export function modelChoices(o = {}) {
  /** @type {any[]} */
  const aliases = Array.isArray(o.aliases) ? o.aliases.filter((/** @type {any} */ m) => m && typeof m.id === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(m.id)) : [];
  /** @type {Map<string, { id: string, label: string, description?: string, now: boolean }>} */
  const rows = new Map(aliases.map((/** @type {any} */ m) => [m.id, { id: m.id, label: String(m.label || m.id), ...(m.description ? { description: String(m.description) } : {}), now: false }]));
  /** @type {Map<string, string[]>} */
  const uses = new Map();
  const purposes = o.purposes && typeof o.purposes === "object" ? o.purposes : {};
  for (const [purpose, v] of Object.entries(purposes)) {
    const id = typeof v === "string" ? v : v && typeof v === "object" && typeof v.model === "string" ? v.model : null;
    if (!id) continue;
    (uses.get(id) || uses.set(id, []).get(id))?.push(purpose);
  }
  const ok = (/** @type {any} */ id) => typeof id === "string" && /^[A-Za-z0-9._:\[\]-]{1,80}$/.test(id);
  for (const id of [...uses.keys(), o.current, ...(o.seen || [])]) if (ok(id) && !rows.has(/** @type {string} */ (id))) rows.set(/** @type {string} */ (id), { id: /** @type {string} */ (id), label: /** @type {string} */ (id), now: false });
  for (const [id, ps] of uses) { const r = rows.get(id); if (r) r.description = "Used for " + ps.join(", "); }
  const cur = o.current || null;
  const exact = cur ? rows.get(cur) : undefined;
  if (exact) exact.now = true;
  else if (cur) { const fam = rows.get(/** @type {string} */ (shortModel(cur))); if (fam) fam.now = true; }
  return [...rows.values()];
}

// ---- modes ---------------------------------------------------------------------------------

/** Claude Code's permission modes, in its order (bypass only ever read, from a session started in it). */
export const MODES = Object.freeze(["default", "acceptEdits", "plan", "bypassPermissions"]);
/** What Shift+Tab walks: the modes threads.mode takes. Never bypass. */
export const DEFAULT_MODES = Object.freeze(["default", "acceptEdits", "plan"]);
/** The chip under the composer. */
export const MODE_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  default: "Asks first", acceptEdits: "Accepts edits", plan: "Plan mode", bypassPermissions: "Doesn't ask",
}));

/** @param {string|null|undefined} mode */
export const modeLabel = mode => MODE_LABELS[mode || "default"] || String(mode);

/**
 * The mode after `current`, over the three threads.mode takes (narrowed to the ones the session
 * offers, when it says), in their usual order. Bypass is never reached; from bypass (a session
 * started in it) the next is default.
 * @param {string|null|undefined} current @param {readonly string[]|null|undefined} [offered]
 */
export function nextMode(current, offered) {
  const narrowed = offered && offered.length ? DEFAULT_MODES.filter(m => offered.includes(m)) : [];
  const order = narrowed.length ? narrowed : [...DEFAULT_MODES];
  const i = order.indexOf(current || "default");
  return order[(i + 1) % order.length];
}

// ---- the draft -----------------------------------------------------------------------------

/**
 * An "@role" at the very start of the draft, lowercased - the SLUG charset agentName already uses
 * (core/computers', core/sight's AGENT regex: a-z first, then a-z0-9-, 41 chars). Followed by
 * whitespace and the rest of the message, or nothing yet (still typing the name) - existence in
 * the project is a send-time question (team.ask's own not_found), not this function's.
 * @param {string} text @returns {string|null}
 */
export function teammateRole(text) {
  const m = /^@([A-Za-z][A-Za-z0-9-]{0,40})(?=\s|$)/.exec(String(text ?? ""));
  return m ? m[1].toLowerCase() : null;
}

/** @param {string} text @returns {DraftKind} */
export function draftKind(text) {
  const t = String(text ?? "");
  const c = t[0];
  if (c === "/") return "command";
  if (c === "!") return "shell";
  if (c === "#") return "memory";
  if (c === "@" && teammateRole(t)) return "teammate";
  return "message";
}

/** The draft without its mode character or, for a teammate, the "@role " itself, trimmed. @param {string} text */
export function draftBody(text) {
  const t = String(text ?? "");
  const k = draftKind(t);
  if (k === "shell" || k === "memory") return t.slice(1).trim();
  if (k === "teammate") return t.replace(/^@[A-Za-z][A-Za-z0-9-]{0,40}\s*/, "").trim();
  return t.trim();
}

/** What the composer calls each mode, for its label ("Shell", "Memory"); null for a message. @param {DraftKind} kind */
export const kindLabel = kind => ({ command: "Command", shell: "Shell", memory: "Memory", teammate: "Teammate", message: null })[kind] ?? null;

/** @typedef {{ start: number, end: number, query: string }} MentionRange */

/**
 * The "@" mention at the caret: an "@" at the start or after a space (or an opening bracket or
 * quote), then no whitespace up to the caret. Null when there is none.
 * @param {string} text @param {number} caret @returns {MentionRange|null}
 */
export function findMention(text, caret) {
  const t = String(text ?? "");
  const end = Math.max(0, Math.min(caret, t.length));
  for (let i = end - 1; i >= 0; i--) {
    const ch = t[i];
    if (/\s/.test(ch)) return null;
    if (ch === "@") {
      const before = i === 0 ? "" : t[i - 1];
      if (i === 0 || /[\s("'`[{]/.test(before)) return { start: i, end, query: t.slice(i + 1, end) };
      return null; // an email address, not a mention
    }
  }
  return null;
}

/**
 * The text with a path in place of the mention, and the caret after it and one space. A path
 * with whitespace is quoted, as Claude Code reads it.
 * @param {string} text @param {MentionRange} range @param {string} path
 */
export function applyMention(text, range, path) {
  const before = text.slice(0, range.start), after = text.slice(range.end);
  const word = "@" + (/\s/.test(path) ? `"${path}"` : path);
  const gap = after.startsWith(" ") ? "" : " ";
  return { text: before + word + gap + after, caret: before.length + word.length + 1 };
}

/** The name written after a "#": plain when it is one word of letters, digits, dots, dashes and underscores, else quoted. @param {string} name */
export const vaultToken = name => "#" + (/^[A-Za-z0-9][\w.-]*$/.test(name) ? name : `"${String(name).replace(/"/g, "")}"`);

/**
 * The "#" vault mention at the caret: a "#" after a space or an opening bracket or quote (never the very first
 * character, which is the save-a-memory mode), then no whitespace up to the caret. A name with spaces is picked, not typed.
 * @param {string} text @param {number} caret @returns {MentionRange|null}
 */
export function findVaultMention(text, caret) {
  const t = String(text ?? "");
  const end = Math.max(0, Math.min(caret, t.length));
  for (let i = end - 1; i >= 1; i--) {
    const ch = t[i];
    if (/\s/.test(ch)) return null;
    if (ch === "#") return /[\s("'`[{]/.test(t[i - 1]) ? { start: i, end, query: t.slice(i + 1, end).replace(/^"/, "") } : null;
  }
  return null;
}

/** The text with a vault token in place of the mention, and the caret after it and one space. @param {string} text @param {MentionRange} range @param {string} name */
export function applyVault(text, range, name) {
  const before = text.slice(0, range.start), after = text.slice(range.end);
  const word = vaultToken(name);
  const gap = after.startsWith(" ") ? "" : " ";
  return { text: before + word + gap + after, caret: before.length + word.length + 1 };
}

/** Every vault token in a draft that is one of `names` (a "#" at the very start is a memory, never a token). @param {string} text @param {Set<string>} names @returns {{ start: number, end: number, name: string }[]} */
export function vaultTokens(text, names) {
  const out = [], t = String(text ?? ""), re = /(?<=[\s("'`[{])#(?:"([^"\n]+)"|([A-Za-z0-9][\w.-]*))/g;
  for (let m; (m = re.exec(t));) { const name = m[1] ?? m[2]; if (m.index >= 1 && names.has(name)) out.push({ start: m.index, end: m.index + m[0].length, name }); }
  return out;
}

/** Vault names for the picker: names starting with the query first, then names containing it, each by name. @param {{ name: string }[]} items @param {string} query */
export function rankVault(items, query) {
  const q = String(query ?? "").toLowerCase();
  const tier = (/** @type {string} */ n) => { const l = n.toLowerCase(); return !q || l.startsWith(q) ? 0 : l.includes(q) ? 1 : 2; };
  return items.filter(i => tier(i.name) < 2).sort((a, b) => tier(a.name) - tier(b.name) || a.name.localeCompare(b.name));
}

/**
 * Files for the "@" picker: paths relative to the folder, best match first; ties by recency
 * (an `mtime` when the list has one), then by length. Only paths inside `cwd` are kept.
 * @param {{ path: string, mtime?: number }[]} files @param {string} query @param {string|null} cwd
 * @param {(q: string, p: string) => ({ tier: number, offset: number, spread?: number }|null)} score scorePath from match.js
 * @param {(a: any, b: any) => number} compare compareScores from match.js
 * @param {number} [limit]
 * @returns {{ path: string, rel: string, mtime?: number }[]}
 */
export function rankFiles(files, query, cwd, score, compare, limit = 12) {
  const base = cwd ? String(cwd).replace(/\/+$/, "") + "/" : "";
  const seen = new Set();
  const out = [];
  for (const f of files || []) {
    if (!f || typeof f.path !== "string") continue;
    if (base && !f.path.startsWith(base)) continue;
    const rel = base ? f.path.slice(base.length) : f.path;
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const s = score(query, rel);
    if (!s) continue;
    out.push({ f, rel, s });
  }
  out.sort((a, b) => compare(a.s, b.s) || (b.f.mtime ?? 0) - (a.f.mtime ?? 0) || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
  return out.slice(0, limit).map(x => ({ path: x.f.path, rel: x.rel, ...(x.f.mtime !== undefined ? { mtime: x.f.mtime } : {}) }));
}

// ---- history (Up and Down) ------------------------------------------------------------------

export const HISTORY_LIMIT = 100;

/** @typedef {{ entries: string[], at: number, draft: string, limit: number }} History */

/** @param {number} [limit] @returns {History} */
export function createHistory(limit = HISTORY_LIMIT) {
  return { entries: [], at: -1, draft: "", limit };
}

/** A sent message joins the ring (newest last), not twice in a row; recalling starts over. @param {History} h @param {string} text */
export function remember(h, text) {
  const t = String(text ?? "").trim();
  h.at = -1; h.draft = "";
  if (!t || h.entries[h.entries.length - 1] === t) return;
  h.entries.push(t);
  if (h.entries.length > h.limit) h.entries.splice(0, h.entries.length - h.limit);
}

/**
 * Up ("up") gives the next older message; Down ("down") the next newer, and past the newest the
 * draft that was there before recalling. Null when there is nowhere to go.
 * @param {History} h @param {"up"|"down"} dir @param {string} current what the composer holds now
 * @returns {string|null}
 */
export function recall(h, dir, current) {
  const n = h.entries.length;
  if (dir === "up") {
    if (!n) return null;
    if (h.at === -1) { h.draft = current; h.at = n - 1; }
    else if (h.at > 0) h.at--;
    else return null;
    return h.entries[h.at];
  }
  if (h.at === -1) return null;
  if (h.at < n - 1) { h.at++; return h.entries[h.at]; }
  h.at = -1;
  return h.draft;
}

/** Is the composer showing a recalled message? @param {History} h */
export const recalling = h => h.at !== -1;

/** Stop recalling (the person typed, or Esc cleared it). @param {History} h */
export function stopRecall(h) { h.at = -1; h.draft = ""; }

/**
 * One ring per thread, kept to `max` threads (the least recently used goes). `toJSON` and `load`
 * let a surface keep them across reloads.
 * @param {number} [limit] @param {number} [max]
 */
export function historyStore(limit = HISTORY_LIMIT, max = 50) {
  /** @type {Map<string, History>} */
  const rings = new Map();
  return {
    /** @param {string} thread */
    get(thread) {
      let h = rings.get(thread);
      if (h) { rings.delete(thread); rings.set(thread, h); return h; }
      h = createHistory(limit);
      rings.set(thread, h);
      while (rings.size > max) rings.delete(/** @type {string} */ (rings.keys().next().value));
      return h;
    },
    toJSON() { return Object.fromEntries([...rings].map(([k, h]) => [k, h.entries])); },
    /** @param {any} data */
    load(data) {
      if (!data || typeof data !== "object") return;
      for (const [k, v] of Object.entries(data)) {
        if (!Array.isArray(v)) continue;
        const h = createHistory(limit);
        h.entries = v.filter(x => typeof x === "string").slice(-limit);
        rings.set(k, h);
      }
    },
  };
}

/**
 * What Up does: in an empty composer with messages waiting in the queue, edit the newest of them;
 * in an empty composer (or while recalling, on the first line) recall; else nothing (the caret
 * moves in the text).
 * @param {{ text: string, firstLine: boolean, recalling: boolean, queued: number }} o
 * @returns {"edit-queued"|"recall"|"none"}
 */
export function upAction(o) {
  const empty = !String(o.text ?? "").trim();
  if (empty && o.queued > 0) return "edit-queued";
  if (empty || (o.recalling && o.firstLine)) return "recall";
  return "none";
}

// ---- Enter ---------------------------------------------------------------------------------

/**
 * @typedef {{ do: "newline" } | { do: "none" } | { do: "pick" }
 *   | { do: "send", kind: DraftKind, mode: SendMode|null } | { do: "refuse", why: "images-queue" }} EnterAction
 */

/**
 * What a press of Enter (or the send button, `button: true`) does.
 * @param {{ text: string, running: boolean, shift?: boolean, alt?: boolean, meta?: boolean, ctrl?: boolean,
 *   queueToggle?: boolean, composing?: boolean, touch?: boolean, pickerOpen?: boolean, images?: number, button?: boolean, hold?: boolean }} o
 *   hold: the send button was long-pressed (the phone's way to queue).
 *   A message with images is never queued (refused, why "images-queue"): the box keeps a queued
 *   message's words only, so its images would be lost. It can be sent as a steer or after the turn.
 * @returns {EnterAction}
 */
export function enterAction(o) {
  if (o.composing) return { do: "none" };
  if (!o.button) {
    if (o.pickerOpen && !o.shift) return { do: "pick" };
    if (o.shift) return { do: "newline" };
    // A phone keyboard has no Shift: Enter is a new line there, and the send button sends.
    if (o.touch && !o.meta && !o.ctrl) return { do: "newline" };
  }
  const text = String(o.text ?? "");
  if (!text.trim() && !(o.images && o.images > 0)) return { do: "none" };
  const kind = draftKind(text);
  if (kind === "shell" || kind === "memory" || kind === "teammate") return draftBody(text) ? { do: "send", kind, mode: null } : { do: "none" };
  if (!o.running) return { do: "send", kind, mode: null };
  if (kind === "command") return o.images && o.images > 0 ? { do: "refuse", why: "images-queue" } : { do: "send", kind, mode: "queue" };
  const queue = !!(o.alt || o.queueToggle || o.hold);
  if (queue && o.images && o.images > 0) return { do: "refuse", why: "images-queue" };
  return { do: "send", kind, mode: queue ? "queue" : "steer" };
}

// ---- Esc -----------------------------------------------------------------------------------

export const ESC_WINDOW = 800;

/** @typedef {{ last: number, window: number }} EscState */

/** @param {number} [window] @returns {EscState} */
export const createEsc = (window = ESC_WINDOW) => ({ last: 0, window });

/**
 * One press of Esc. The first press arms a second; a second within the window with an empty
 * draft rewinds, with words in it clears them. A picker open takes the press and disarms.
 * @param {EscState} st
 * @param {{ now: number, running: boolean, text: string, pickerOpen?: boolean, recalled?: boolean }} o
 * @returns {"close"|"interrupt"|"rewind"|"clear"|"leave-mode"|"none"}
 */
export function escape(st, o) {
  if (o.pickerOpen) { st.last = 0; return "close"; }
  const text = String(o.text ?? "");
  const second = st.last > 0 && o.now - st.last <= st.window;
  if (second) {
    st.last = 0;
    return text.trim() ? "clear" : "rewind";
  }
  st.last = o.now;
  if (o.running) return "interrupt";
  const kind = draftKind(text);
  if (kind === "shell" || kind === "memory" || kind === "teammate") return "leave-mode";
  if (o.recalled) return "clear";
  return "none";
}

// ---- the key map ---------------------------------------------------------------------------

/**
 * Every binding, once. `keys` are what keyOf() gives ("Mod" is Cmd on a Mac, Ctrl elsewhere;
 * "Escape Escape" is two presses). `label` is how the Deck prints it; `tap` how the phone does it.
 * @typedef {{ id: string, keys: string[], label: string, does: string, tap?: string, prefix?: string }} Binding
 * @type {readonly Binding[]}
 */
export const KEYMAP = Object.freeze([
  { id: "stop", keys: ["Escape"], label: "Esc", does: "Stop now", tap: "Stop" },
  { id: "rewind", keys: ["Escape Escape"], label: "Esc Esc", does: "Rewind to an earlier message", tap: "Rewind in the menu" },
  { id: "mode", keys: ["Shift+Tab"], label: "⇧Tab", does: "Next mode", tap: "The mode chip" },
  { id: "send", keys: ["Enter"], label: "⏎", does: "Send, or steer while it works", tap: "Send" },
  { id: "queue", keys: ["Alt+Enter"], label: "⌥⏎", does: "Queue for after the turn", tap: "Hold Send" },
  { id: "newline", keys: ["Shift+Enter"], label: "⇧⏎", does: "New line", tap: "Return" },
  { id: "recall", keys: ["ArrowUp"], label: "↑", does: "Recall your last message, or edit a queued one" },
  { id: "thinking", keys: ["Alt+T"], label: "⌥T", does: "Thinking on or off", tap: "The thinking chip" },
  { id: "thinking-view", keys: ["Ctrl+O"], label: "⌃O", does: "Show or hide the thinking" },
  { id: "tasks", keys: ["Ctrl+B"], label: "⌃B", does: "Background tasks", tap: "The tasks pill" },
  { id: "voice", keys: ["Ctrl+M"], label: "⌃M", does: "Tap to talk, hold to push-to-talk", tap: "The mic button" },
  { id: "paste", keys: ["Mod+V"], label: "⌘V", does: "Paste an image" },
  { id: "command", keys: [], prefix: "/", label: "/", does: "Commands and skills" },
  { id: "mention", keys: [], prefix: "@", label: "@", does: "Files in the project" },
  { id: "shell", keys: [], prefix: "!", label: "!", does: "Shell in the session's folder" },
  { id: "memory", keys: [], prefix: "#", label: "#", does: "Save a memory" },
]);

/** @param {string} id */
export const binding = id => KEYMAP.find(b => b.id === id) || null;

/**
 * A key event as the key map writes it: modifiers in the order Mod/Ctrl, Alt, Shift, then the
 * key. Alt+letter reads the physical key (a Mac's Option+T types "†").
 * @param {{ key: string, code?: string, shiftKey?: boolean, altKey?: boolean, metaKey?: boolean, ctrlKey?: boolean }} e
 * @param {boolean} [mac] Cmd is Mod (else Ctrl is)
 */
export function keyOf(e, mac = false) {
  let k = e.key;
  if (e.altKey && e.code && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (k && k.length === 1) k = k.toUpperCase();
  const parts = [];
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (e.ctrlKey && mac) parts.push("Ctrl");
  if (e.metaKey && !mac) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && k.length > 1) parts.push("Shift");
  parts.push(k);
  return parts.join("+");
}

/**
 * The binding a key press is, or null. "Ctrl+O" matches Ctrl on any platform; "Mod+V" Cmd on a
 * Mac and Ctrl elsewhere.
 * @param {{ key: string, code?: string, shiftKey?: boolean, altKey?: boolean, metaKey?: boolean, ctrlKey?: boolean }} e
 * @param {boolean} [mac]
 * @returns {string|null}
 */
export function actionFor(e, mac = false) {
  const k = keyOf(e, mac);
  // The same press written with Ctrl rather than Mod, for bindings that name Ctrl itself.
  const ctrl = e.ctrlKey && !mac ? k.replace(/^Mod\+/, "Ctrl+") : k;
  for (const b of KEYMAP) if (b.keys.includes(k) || b.keys.includes(ctrl)) return b.id;
  return null;
}

// ---- pasted images -------------------------------------------------------------------------

export const IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** threads.send's own caps (core/switchboard IMAGES, sessions 034c71e5): at most 5, 5 MB each. */
export const MAX_IMAGES = 5;
/** The limit for one image, as the box measures it: its base64 length times 3/4. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** @typedef {{ media_type: string, data: string, name?: string, size: number }} Attachment */

/** Bytes a base64 string decodes to. @param {string} b64 */
export const b64Bytes = b64 => {
  const s = String(b64 ?? "");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(s.length * 3 / 4) - pad);
};

/**
 * One more image, or why not. Returns the new list (the old one is not changed).
 * @param {readonly Attachment[]} list @param {{ media_type: string, data: string, name?: string, size?: number }} img
 * @param {{ max?: number, maxBytes?: number }} [caps]
 * @returns {{ list: Attachment[], error?: string }}
 */
export function addImage(list, img, caps = {}) {
  const max = caps.max ?? MAX_IMAGES, maxBytes = caps.maxBytes ?? MAX_IMAGE_BYTES;
  if (!img || !IMAGE_TYPES.includes(img.media_type)) return { list: [...list], error: "Only PNG, JPEG, GIF and WebP images can be attached." };
  if (list.length >= max) return { list: [...list], error: `At most ${max} images in one message.` };
  const size = typeof img.size === "number" ? img.size : b64Bytes(img.data);
  // The box counts base64 length * 3/4, which rounds a file's bytes up to a multiple of 3.
  if (3 * Math.ceil(size / 3) > maxBytes) return { list: [...list], error: `That image is over ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  if (!img.data) return { list: [...list], error: "That image is empty." };
  return { list: [...list, { media_type: img.media_type, data: img.data, size, ...(img.name ? { name: img.name } : {}) }] };
}

/** @param {readonly Attachment[]} list @param {number} i */
export const removeImage = (list, i) => list.filter((_, j) => j !== i);

/** What threads.send takes. @param {readonly Attachment[]} list */
export const sendImages = list => list.map(a => ({ media_type: a.media_type, data: a.data }));

// ---- ids -----------------------------------------------------------------------------------

/** A v4 uuid: crypto's when there is one (browsers, Node), else from Math.random (older phone runtimes). */
export function newUuid() {
  const c = /** @type {any} */ (globalThis).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const h = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  h[12] = "4";
  h[16] = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
