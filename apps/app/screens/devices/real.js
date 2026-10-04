// @ts-check
// What the box answers, shaped for the Devices and pairing screens. Pure, so Node tests it with the answers
// captured from a real vyred (relay.devices.list, spaces.list, wink.pair.targets, wink.phone.open,
// wink.phone.pairing, wink.pair.status). No React, no calls.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Aug" for a time in ms, "" for none. */
export const dayOf = (/** @type {number | null | undefined} */ ms) => {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/** "Now", "4 min ago", "3 h ago", "Yesterday" or a day. */
export function agoOf(/** @type {number | null | undefined} */ ms, /** @type {number} */ now = Date.now(), /** @type {boolean} */ online = false) {
  if (online) return "Now";
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "Not yet";
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 1) return "Now";
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;
  if (m < 48 * 60) return "Yesterday";
  return dayOf(ms);
}

/** The device kind the screens draw: phone, computer or server. relay.devices.list kinds are app, web and the like. */
/** @param {string} k @returns {"phone" | "server" | "computer"} */
export const deviceKind = (k) => (k === "app" || k === "phone" ? "phone" : k === "server" ? "server" : "computer");

const ALLOWS = { phone: "Does everything you can, until you remove it.", computer: "Opens your projects and your vault, until you remove it.", server: "Runs your spaces and keeps working when your computer sleeps." };

/**
 * relay.devices.list rows as the screens' device rows. `storage` is "software" or "hardware" when the box reports where the key
 * was made; until it does, no software line shows (nothing is invented).
 * @param {unknown} data the tool's answer, { devices: [...] }
 * @param {number} [now]
 */
export function deviceRows(data, now = Date.now()) {
  const list = /** @type {any} */ (data)?.devices;
  if (!Array.isArray(list)) return [];
  return list.filter((d) => d && typeof d.id === "string" && typeof d.name === "string").map((d) => {
    const device = deviceKind(String(d.kind));
    return {
      id: d.id, kind: /** @type {const} */ ("Device"), device, family: /** @type {const} */ ("device"), name: d.name, allows: ALLOWS[device],
      since: dayOf(d.pairedAt), last: agoOf(d.lastSeen, now, d.online === true),
      ...(d.storage === "software" ? { software: true } : {}),
    };
  });
}

/**
 * spaces.list as { id: name } plus the ids in order. A space shows its display name, else its label.
 * @param {unknown} data
 */
export function spaceNames(data) {
  /** @type {Record<string, string>} */ const names = {};
  if (!Array.isArray(data)) return names;
  for (const s of data) if (s && typeof s.id === "string") names[s.id] = String(s.displayName || s.label || s.name || s.id);
  return names;
}

/** Every device sees the spaces its person is in; the box does not report a per-device join. @param {string[]} deviceIds @param {Record<string, string>} names */
export const deviceSpaces = (deviceIds, names) => Object.fromEntries(deviceIds.map((id) => [id, Object.keys(names)]));

/** The text a server's QR holds, rebuilt from a parsed code, for wink.pair.server's `payload`. @param {any} c a parseWinkCode result with ok true */
export function payloadOf(c) {
  if (c.kind === "offer") return c.offer;
  return `vyre://wink/2?t=${c.ticket}&r=${encodeURIComponent(c.relay || "")}${c.for === "phone" ? "&k=phone" : ""}`;
}

/** wink.pair.targets: the "Pair to" choices, you first. @param {unknown} data */
export function targetsOf(data) {
  const t = /** @type {any} */ (data)?.targets;
  if (!Array.isArray(t)) return [];
  return t.filter((x) => x && typeof x.id === "string" && (x.kind === "identity" || x.kind === "space")).map((x) => ({ id: x.id, kind: x.kind, label: String(x.label || x.id) }));
}

/**
 * wink.pair.status as what the screen does next.
 * phase: wait (keep polling, nothing to show), words (show them, the person says yes at the server), done, fail (say why).
 * @param {any} r
 * @returns {{ phase: "wait" | "words" | "done" | "fail", words?: [string, string, string], say?: string }}
 */
export function pairPhase(r) {
  const s = r && r.state;
  if (s === "done") return { phase: "done" };
  if (s === "failed") return { phase: "fail", say: r.reason || "The pairing failed. Nothing was paired." };
  if (s === "expired") return { phase: "fail", say: "The pairing ran out of time. Nothing was paired. Start again." };
  if (s === "confirm" && wordsOf(r.words)) return { phase: "words", words: /** @type {[string, string, string]} */ (wordsOf(r.words)) };
  return { phase: "wait" };
}

/** Three words from an array or a spaced string, else null. @param {unknown} w */
export function wordsOf(w) {
  const a = Array.isArray(w) ? w.map(String) : typeof w === "string" ? w.trim().split(/\s+/) : [];
  return a.length === 3 && a.every(Boolean) ? /** @type {[string, string, string]} */ (a.map((x) => x.toLowerCase())) : null;
}

/**
 * wink.phone.pairing: is a new device asking now? { asking: false } or { asking: true, name, words, until, line }.
 * @param {any} r
 * @returns {{ asking: false } | { asking: true, name: string, words: [string, string, string], line: string }}
 */
export function phoneAsk(r) {
  const w = r && r.asking ? wordsOf(r.words) : null;
  if (!w) return { asking: false };
  return { asking: true, name: String(r.name || "A new device"), words: w, line: String(r.line || "") };
}

/** wink.phone.pair.answer answered { answered, yes } : was the device added? @param {any} r */
export const added = (r) => Boolean(r && r.answered && r.yes);
