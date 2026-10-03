// @ts-check
// The group side of a chat (DESIGN-chat.md, "Group chats"). Pure: no React, no clock.
// Every chat is a group chat; a one-to-one is a group of two. core/stream frames carry
// `author` ("person:<id>" | "assistant:<id>" | "model:<id>"), for assistants `acts_for` (the asker)
// and `message`. frames.js folds the transcript rows; this folds what is about the people in it:
// who is here, who is typing or working, reactions, pins, threads, mentions, the read marker,
// fan-out sets and cut notes. It never changes a row; it only answers questions about one.
//
// Row keys match frames.js: "u:<message>" for a person's message, "a:<message>" for an answer.

/**
 * @typedef {{ cur: number, type: string, author?: string, acts_for?: string, message?: string, data?: any }} GFrame
 * @typedef {{ id: string, family: "person" | "assistant" | "model", name: string, role?: string }} Participant
 * @typedef {{ message: string, author?: string }} FanoutMember
 * @typedef {{ group: string, message: string | null, members: FanoutMember[], kept: string | null }} Fanout
 */

/** "assistant:kit" -> { family: "assistant", id: "kit" }. A bare id is a person. @param {unknown} who */
export function parseWho(who) {
  const s = String(who ?? "");
  const i = s.indexOf(":");
  if (i < 0) return { family: /** @type {"person"} */ ("person"), id: s };
  const f = s.slice(0, i);
  return { family: /** @type {"person" | "assistant" | "model"} */ (f === "assistant" || f === "model" ? f : "person"), id: s.slice(i + 1) };
}

/** @param {string} id @param {Record<string, string>} [names] */
export const nameOf = (id, names = {}) => names[id] ?? parseWho(id).id;

/** Names show with a capital when they are people ("Chris"); assistants keep their own spelling ("kit"). @param {string} s */
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * The author line of one message: the name, the family (for the avatar), and a quiet second part.
 * An assistant that acts for a person says so: "kit, for Chris", "juno, for you". A model or a
 * person has no second part.
 * @param {{ author?: string | null, acts_for?: string | null, viewer: string, names?: Record<string, string> }} o
 */
export function authorLabel({ author, acts_for, viewer, names = {} }) {
  const a = parseWho(author ?? viewer);
  const name = names[String(author ?? viewer)] ?? (a.family === "model" ? cap(a.id) : a.id);
  if (a.family !== "assistant" || !acts_for) return { name, family: a.family, sub: /** @type {string | null} */ (null) };
  const asker = parseWho(acts_for);
  const you = String(acts_for) === viewer;
  return { name, family: a.family, sub: you ? "for you" : "for " + cap(names[String(acts_for)] ?? asker.id) };
}

/**
 * The faces in the header: everyone but the viewer (a chat with one assistant shows that assistant),
 * at most `max`, then "+n".
 * @param {readonly { id: string, name: string, family: string }[]} participants @param {string} viewer @param {number} [max]
 */
export function avatarStack(participants, viewer, max = 3) {
  const others = participants.filter((p) => p.id !== viewer);
  const list = others.length ? others : [...participants];
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
}

/**
 * Where the "New" divider goes: before the first message after the read marker that someone else
 * wrote. With no marker there is nothing to call new.
 * @param {readonly { key: string, cur: number, author?: string }[]} messages in arrival order
 * @param {number} upto the read marker's cursor @param {string} viewer
 * @returns {{ key: string | null, count: number }}
 */
export function unreadDivider(messages, upto, viewer) {
  if (!(upto > 0)) return { key: null, count: 0 };
  let key = null;
  let count = 0;
  for (const m of messages) {
    if (m.cur <= upto || m.author === viewer) continue;
    if (key === null) key = m.key;
    count++;
  }
  return { key, count };
}

/**
 * The presence line above the composer: "alex is typing", "kit is running the tests".
 * @param {Iterable<[string, { state: string, doing?: string }]>} presence @param {string} viewer @param {Record<string, string>} [names]
 */
export function presenceLine(presence, viewer, names = {}) {
  const typing = [];
  const doing = [];
  for (const [who, p] of presence) {
    if (who === viewer) continue;
    const n = nameOf(who, names);
    if (p.state === "typing") typing.push(n);
    else if (p.state === "doing") doing.push(`${n} is ${p.doing || "working"}`);
  }
  const parts = [];
  if (typing.length === 1) parts.push(`${typing[0]} is typing`);
  else if (typing.length === 2) parts.push(`${typing[0]} and ${typing[1]} are typing`);
  else if (typing.length > 2) parts.push(`${typing.length} people are typing`);
  parts.push(...doing.slice(0, 2));
  if (doing.length > 2) parts.push(`${doing.length - 2} more working`);
  return parts.join(" · ");
}

/**
 * What a viewer sees on an approval: the buttons when they asked, a quiet "waiting for Chris" when
 * somebody else did. An ask with no known asker belongs to the viewer.
 * @param {{ asker?: string | null, viewer: string, names?: Record<string, string> }} o
 */
export function askAudience({ asker, viewer, names = {} }) {
  if (!asker || asker === viewer) return { mine: true, waitingFor: /** @type {string | null} */ (null) };
  return { mine: false, waitingFor: cap(names[asker] ?? parseWho(asker).id) };
}

/** Which fan-out answer a tap keeps. `id` is a message id or an author. @param {Fanout | undefined} fo @param {string} id */
export function fanoutKeep(fo, id) {
  if (!fo || fo.kept) return { ok: false, keep: /** @type {string | null} */ (null) };
  const m = fo.members.find((x) => x.message === id || x.author === id);
  return m ? { ok: true, keep: m.message } : { ok: false, keep: null };
}

/** Whether a message that mentions the viewer: by a mention frame or by "@name" in its text. @param {string} text @param {string} name */
export function textMentions(text, name) {
  if (!name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])@${esc}(?![\\w])`, "i").test(String(text ?? ""));
}

const SEALED_KEY = (/** @type {string} */ chat) => `vyre.chat.sealed-note.${chat}`;
/** Has this chat's sealed note been shown? Any storage error counts as "not yet", so it never hides a note by accident. @param {{ getItem(k: string): string | null } | null | undefined} storage @param {string} chat */
export function sealedNoteSeen(storage, chat) {
  try { return storage?.getItem(SEALED_KEY(chat)) === "1"; } catch { return false; }
}
/** @param {{ setItem(k: string, v: string): void } | null | undefined} storage @param {string} chat */
export function markSealedNoteSeen(storage, chat) {
  try { storage?.setItem(SEALED_KEY(chat), "1"); } catch { /* private window or no storage: it shows again next time */ }
}
/** The one line of the sealed note. @param {{ sealed: number, assistants: number }} o */
export function sealedNoteText({ sealed, assistants }) {
  const who = assistants > 1 ? "Assistants here" : "The assistant here";
  return sealed > 0
    ? `${who} can read this chat and the records you tag. ${sealed} sealed field${sealed === 1 ? "" : "s"} stay${sealed === 1 ? "s" : ""} hidden from them.`
    : `${who} can read this chat and the records you tag. Sealed fields never reach them.`;
}

/** @param {unknown} m @returns {FanoutMember | null} */
function member(m) {
  if (typeof m === "string") return { message: m };
  if (m && typeof m === "object" && typeof /** @type {any} */ (m).message === "string") return { message: /** @type {any} */ (m).message, author: /** @type {any} */ (m).author };
  return null;
}

/** @param {string} viewer */
export function createGroup(viewer) {
  // The box says who the viewer is (stream.open's `viewer`); until then it is what the screen was told.
  /** @type {Map<string, Participant>} */ const people = new Map();
  /** @type {Map<string, { state: string, doing?: string }>} */ const presence = new Map();
  /** @type {Map<string, Map<string, Set<string>>>} message -> emoji -> who */ const reactions = new Map();
  /** @type {Set<string>} */ const pins = new Set();
  /** @type {Map<string, string[]>} parent -> reply messages */ const replies = new Map();
  /** @type {Map<string, string>} reply message -> parent */ const parentOf = new Map();
  /** @type {Map<string, Set<string>>} */ const mentions = new Map();
  /** @type {Map<string, { key: string, cur: number, author?: string, acts_for?: string }>} message -> row facts, arrival order */ const msgs = new Map();
  /** @type {Map<string, { author?: string, acts_for?: string }>} */ const asks = new Map();
  /** @type {Map<string, Fanout>} */ const fanouts = new Map();
  /** @type {Map<string, string>} member message -> group */ const fanoutOf = new Map();
  /** @type {Map<string, string>} */ const cuts = new Map();
  let readUpto = 0;
  let last = 0;
  let rev = 0;
  let dividerCache = /** @type {{ rev: number, v: { key: string | null, count: number } } | null} */ (null);

  /** @param {string} message */ const keyOf = (message) => msgs.get(message)?.key;
  const names = () => Object.fromEntries([...people.values()].map((p) => [`${p.family}:${p.id}`, p.name]));

  function divider() {
    if (dividerCache && dividerCache.rev === rev) return dividerCache.v;
    const v = unreadDivider([...msgs.values()].filter((m) => !fanoutOf.has(m.key.slice(2))), readUpto, viewer);
    dividerCache = { rev, v };
    return v;
  }

  /**
   * Fold one frame. Returns the row keys it touched and whether header-level state (people,
   * presence, the marker) changed.
   * @param {GFrame} f
   */
  function apply(f) {
    const out = { touched: /** @type {string[]} */ ([]), meta: false };
    if (!f || typeof f.type !== "string") return out;
    const kind = f.type.replace(/^session\./, "");
    if (kind === "heartbeat") return out;
    if (kind === "reset") { people.clear(); presence.clear(); reactions.clear(); pins.clear(); replies.clear(); parentOf.clear(); mentions.clear(); msgs.clear(); asks.clear(); fanouts.clear(); fanoutOf.clear(); cuts.clear(); readUpto = 0; last = typeof f.data?.head === "number" ? f.data.head : f.cur; rev++; return { touched: [], meta: true }; }
    if (typeof f.cur !== "number" || f.cur <= last) return out;
    last = f.cur;
    const d = f.data ?? {};
    const message = f.message ?? d.message;
    /** @param {string | undefined} m */
    const touch = (m) => { const k = m && keyOf(m); if (k) out.touched.push(k); };

    // Who wrote which message. The first frame of a message fixes its cursor (its place in the order).
    if ((kind === "user-message" || kind === "text-delta") && message && !d.reasoning && d.state !== "cancelled" && d.state !== "queued") {
      const key = (kind === "user-message" ? "u:" : "a:") + message;
      if (!msgs.has(message)) {
        msgs.set(message, { key, cur: f.cur, author: f.author ?? (kind === "user-message" ? viewer : undefined), acts_for: f.acts_for });
        rev++;
        out.touched.push(key);
        out.meta = true; // the divider may move
      }
    }

    switch (kind) {
      case "participant-joined": {
        const id = String(d.who ?? f.author ?? "");
        if (!id) break;
        const w = parseWho(id);
        people.set(id, { id, family: w.family, name: String(d.name ?? w.id), role: d.role });
        out.meta = true;
        break;
      }
      case "participant-left": {
        if (people.delete(String(d.who ?? f.author ?? ""))) out.meta = true;
        break;
      }
      case "presence": {
        const who = String(d.who ?? f.author ?? "");
        if (!who) break;
        if (d.state === "typing" || d.state === "doing") presence.set(who, { state: d.state, doing: d.doing });
        else presence.delete(who);
        out.meta = true;
        break;
      }
      case "reaction": {
        const by = String(f.author ?? d.by ?? viewer);
        const emoji = String(d.emoji ?? "");
        if (!message || !emoji) break;
        let byEmoji = reactions.get(message);
        if (!byEmoji) reactions.set(message, (byEmoji = new Map()));
        let set = byEmoji.get(emoji);
        if (!set) byEmoji.set(emoji, (set = new Set()));
        if (d.remove) set.delete(by); else set.add(by);
        if (!set.size) byEmoji.delete(emoji);
        touch(message);
        break;
      }
      case "pin": {
        if (!message) break;
        if (d.pinned === false) pins.delete(message); else pins.add(message);
        touch(message);
        break;
      }
      case "thread-reply": {
        const parent = String(d.parent ?? "");
        if (!parent || !message) break;
        parentOf.set(message, parent);
        const l = replies.get(parent) ?? [];
        if (!l.includes(message)) l.push(message);
        replies.set(parent, l);
        touch(parent);
        touch(message);
        break;
      }
      case "mention": {
        const who = String(d.who ?? "");
        if (!message || !who) break;
        const s = mentions.get(message) ?? new Set();
        s.add(who);
        mentions.set(message, s);
        touch(message);
        break;
      }
      case "read-marker": {
        const upto = Number(d.upto);
        // Only the viewer's own marker moves their divider (another person's read state is not theirs).
        if (!Number.isFinite(upto) || (f.author && f.author !== viewer)) break;
        const before = divider().key;
        readUpto = Math.max(readUpto, upto);
        rev++;
        const after = divider().key;
        for (const k of [before, after]) if (k) out.touched.push(k);
        out.meta = true;
        break;
      }
      case "ask": {
        asks.set(String(d.ask_id), { author: f.author, acts_for: f.acts_for });
        out.touched.push("k:" + d.ask_id);
        break;
      }
      case "fanout": {
        const group = String(d.group ?? "");
        const members = /** @type {FanoutMember[]} */ ((Array.isArray(d.members) ? d.members : []).map(member).filter((/** @type {FanoutMember | null} */ m) => !!m));
        if (!group || !members.length) break;
        fanouts.set(group, { group, message: d.message ?? null, members, kept: null });
        for (const m of members) fanoutOf.set(m.message, group);
        rev++;
        for (const m of members) touch(m.message);
        break;
      }
      case "fanout-keep": {
        const fo = fanouts.get(String(d.group ?? ""));
        const r = fanoutKeep(fo, String(d.keep ?? ""));
        if (!fo || !r.ok || !r.keep) break;
        fo.kept = r.keep;
        rev++;
        for (const m of fo.members) touch(m.message);
        break;
      }
      case "text-cut": {
        if (!message) break;
        cuts.set(message, String(d.note ?? "Cut off here."));
        touch(message);
        break;
      }
      default:
        break;
    }
    if (out.meta || out.touched.length) rev++;
    return out;
  }

  return {
    apply,
    get rev() { return rev; },
    get last() { return last; },
    get readUpto() { return readUpto; },
    get viewer() { return viewer; },
    /** @param {string} v */ setViewer(v) { if (v && v !== viewer) { viewer = v; rev++; } },
    /** @returns {Participant[]} */ participants: () => [...people.values()],
    names,
    presence: () => presence,
    presenceLine: () => presenceLine(presence, viewer, names()),
    /** The row facts for a message id (author, acts_for), if a frame said. @param {string} message */
    author: (message) => msgs.get(message),
    /** The label for an `a:`/`u:` row key. @param {string} key */
    label(key) {
      const m = msgs.get(key.slice(2));
      return authorLabel({ author: m?.author ?? (key.startsWith("u:") ? viewer : undefined), acts_for: m?.acts_for, viewer, names: names() });
    },
    /** @param {string} key */ isMine: (key) => (msgs.get(key.slice(2))?.author ?? (key.startsWith("u:") ? viewer : "")) === viewer,
    /** @param {string} message */ reactions: (message) => [...(reactions.get(message) ?? new Map()).entries()].map(([emoji, who]) => ({ emoji, count: who.size, mine: who.has(viewer) })),
    /** @param {string} message */ pinned: (message) => pins.has(message),
    /** @param {string} message */ replyCount: (message) => replies.get(message)?.length ?? 0,
    /** @param {string} message */ parent: (message) => parentOf.get(message) ?? null,
    /** A message that mentions the viewer, by frame or by its text. @param {string} message @param {string} [text] */
    mentioned: (message, text) => (mentions.get(message)?.has(viewer) ?? false) || (!!text && textMentions(text, parseWho(viewer).id)),
    /** @param {string} message */ cut: (message) => cuts.get(message) ?? null,
    /** The ask's asker, for the card's audience. @param {string} askId */
    asker: (askId) => asks.get(askId)?.acts_for ?? asks.get(askId)?.author ?? null,
    /** The "New" divider: the key of the first unread row and how many are unread. */
    divider,
    /** The fan-out set this row's message belongs to: the set, and whether this row is its first member. @param {string} key */
    fanoutAt(key) {
      const message = key.slice(2);
      const g = fanoutOf.get(message);
      const fo = g ? fanouts.get(g) : undefined;
      if (!fo) return null;
      // The set draws at the first member that has a row, so it appears with the first answer, whichever member that is.
      const lead = fo.members.find((m) => msgs.has(m.message));
      return { fanout: fo, first: lead?.message === message };
    },
    /** @param {string} group */ fanout: (group) => fanouts.get(group),
    /** The assistants in the chat, for the composer's "ask all". */
    assistants: () => [...people.values()].filter((p) => p.family === "assistant"),
  };
}
