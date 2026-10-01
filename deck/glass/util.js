// @ts-check
// Small shared pieces for the Glass views: a few icons the Deck's set does not have, plain-words
// errors, sizes and times, and who "a surface" is.

const NS = "http://www.w3.org/2000/svg";

/** Glass-only icons, 16 grid, 1.5 stroke, drawn with createElementNS (no markup is parsed). */
const P = {
  pointer: ["M3.5 2l9 6.2-4 .7 2.4 4.6-1.8.9-2.4-4.6-3.2 2.8z"],
  left: ["M10 3.5L5.5 8l4.5 4.5"],
  back: ["M6 4L2.5 7.5 6 11", "M3 7.5h7a3.5 3.5 0 0 1 0 7H8"],
  eye: ["M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z", "M10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"],
  folder: ["M2 4.5h4.2l1.4 1.5H14v6.5H2z"],
  upload: ["M8 11V3", "M5 6l3-3 3 3", "M3 13.5h10"],
  download: ["M8 3v8", "M5 8l3 3 3-3", "M3 13.5h10"],
  trash: ["M3 4.5h10", "M6.5 4.5V3h3v1.5", "M4.5 4.5l.7 9h5.6l.7-9"],
  move: ["M2.5 8h11", "M10.5 5l3 3-3 3"],
  plus: ["M8 3.5v9M3.5 8h9"],
  full: ["M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"],
  keyboard: ["M1.5 4.5h13v7h-13z", "M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6"],
  shield: ["M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4z", "M6 8l1.5 1.5L10.5 6.5"],
  file: ["M4 1.8h5l3 3v9.4H4z", "M9 1.8v3h3"],
  link: ["M6.5 9.5l3-3", "M7.5 4.5l1-1a2.8 2.8 0 014 4l-1 1M8.5 11.5l-1 1a2.8 2.8 0 01-4-4l1-1"],
  close: ["M4 4l8 8M12 4l-8 8"],
};

/** @param {keyof typeof P} name @param {number} [size] */
export function gicon(name, size = 14) {
  const s = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
    "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) s.setAttribute(k, String(v));
  for (const d of P[name] || []) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.append(p); }
  return s;
}

/** Error codes from glass.* in plain words. */
const WORDS = {
  outside_root: "That path is outside the folders Glass can reach.",
  denied_path: "That place holds keys or settings, so Glass keeps it closed.",
  not_found: "That is not there any more. Someone may have moved it.",
  exists: "Something with that name is already there.",
  too_large: "That file is larger than Glass takes in one upload.",
  presence_required: "This box still asks for a passkey to take the keyboard. Update the box: take-over needs none now.",
  not_holder: "Another screen has the keyboard, so this one cannot hand it back.",
  held: "Someone else has the keyboard right now.",
  shield_unavailable: "Signing in privately is not available on this box yet: the agent's computer cannot hide the page from the agent.",
  no_screen: "This computer has no screen to show.",
  offline: "The box did not answer. It may be asleep or out of reach.",
};

/** @param {any} err an ApiError or anything thrown */
export function errText(err) {
  if (!err) return "";
  if (err.missing && err.code !== "offline") return `The ${err.module || "glass"} module is not running on this machine.`;
  return WORDS[err.code] || String(err.message || err);
}

export function size(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "";
  n = Number(n);
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

/** A modified time as "14:32" today, "24 Sep" this year, else "24 Sep 2025". */
export function stamp(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms)), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o = /** @type {Intl.DateTimeFormatOptions} */ ({ day: "numeric", month: "short" });
  if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
  return d.toLocaleDateString([], o);
}

/** Elapsed ms as 2:14 or 1:02:14. */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** "phone", "laptop" or "Lumen" for a surface claim like "phone:ab12". */
export function surfaceKind(surface) {
  const k = String(surface || "").split(":")[0];
  return k === "phone" ? "a phone" : k === "capsule" ? "Lumen" : k === "deck" ? "a laptop" : k ? k : "another screen";
}

/**
 * "Your phone", "Your laptop" or "Your Lumen": only the owner can take over or watch, so another
 * screen holding the keyboard is always one of theirs.
 */
export function yourDevice(surface) {
  const k = String(surface || "").split(":")[0];
  return k === "phone" ? "Your phone" : k === "capsule" ? "Your Lumen" : k === "deck" || k === "glass" ? "Your laptop" : "Your other screen";
}

const store = (() => { try { return window.localStorage; } catch { return null; } })();

/** This browser's surface id: deck:<id>, or phone:<id> on a narrow or touch screen. */
export function surfaceId() {
  let id = "";
  try { id = store?.getItem("vyre.surface") || ""; } catch {}
  if (!/^[a-z0-9]{6,32}$/.test(id)) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
    try { store?.setItem("vyre.surface", id); } catch {}
  }
  return `${isPhone() ? "phone" : "deck"}:${id}`;
}

export function isPhone() {
  return window.innerWidth < 600 || matchMedia("(pointer: coarse)").matches;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** A viewer list or count as a number. */
export function viewerCount(v) {
  return Array.isArray(v) ? v.length : Number(v) || 0;
}

/** The surface that holds the keyboard, from a targets row or an event payload. */
export function holderOf(takeover) {
  if (!takeover) return null;
  if (typeof takeover === "string") return { surface: takeover, since: null, private: false };
  return { surface: takeover.surface || null, since: takeover.since || null, private: !!takeover.private };
}
