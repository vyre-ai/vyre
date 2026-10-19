// @ts-check
// Asking to join and answering asks: the words, and the four words both sides read to each other so the approver knows whose device asked. Pure.
import { sha256 } from "@noble/hashes/sha256";
import { fingerprintWords } from "../../src/real/join-team.js";

/** The words on the asker's screens and the owner's, in one place. */
export const ASK_COPY = Object.freeze({
  joinTitle: "Where are you joining?",
  joinLead: "Paste the invite link someone sent you, or type the Space's address to ask to join.",
  addressHelp: "Or just the address, like juniper.vyre.run",
  waitingTitle: "Waiting for someone to let you in.",
  waitingLead: "We'll tell you when they do. They'll check these four words with you first.",
  closed: "This Space only takes invites.",
  notAccepted: "Not accepted.",
  approved: "You're in. Joining now.",
  yourWords: "Your four words",
  settingTitle: "Let people ask to join",
  settingHelp: "Off by default. When on, anyone can ask this Space to let them in. You see each ask, check their four words with them, and approve or decline.",
  reviewTitle: (/** @type {string} */ who) => `${who} asks to join`,
  reviewHelp: "Read these four words to them (or ask them to read theirs) before you approve.",
  approve: "Approve",
  decline: "Decline",
  noteLabel: "Their note",
});

/** The four words for a device's entry id (what the asker sees and what the approver is shown). @param {string[] | undefined} words the 2048-word list @param {string} entry */
export function entryWords(words, entry) {
  if (!words || words.length < 2048 || !/^[a-z2-7]{26}$/.test(String(entry))) return null;
  const hex = Array.from(sha256(new TextEncoder().encode(`vyre-ask-entry\n${entry}`)), (b) => b.toString(16).padStart(2, "0")).join("");
  return fingerprintWords(words, hex);
}

/** Whether what was typed is an address to ask (a Space's name, or name.vyre.run) and not an invite link. @param {string} text */
export function askAddressOf(text) {
  const t = String(text || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (/[/?#:]/.test(t)) return null;
  const name = t.replace(/\.vyre\.run$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) && !t.includes("..") ? name : null;
}

/** What the asker's screen does for an answer: wait, join (approved), or say the fixed words. @param {{ state?: string, link?: string, words?: string } | null | undefined} r */
export function nextForAsk(r) {
  const s = r && r.state;
  if (s === "waiting") return { kind: "wait" };
  if (s === "approved" && r && typeof r.link === "string" && r.link) return { kind: "join", link: r.link };
  if (s === "not_accepted") return { kind: "said", words: ASK_COPY.notAccepted };
  return { kind: "said", words: ASK_COPY.closed };
}
