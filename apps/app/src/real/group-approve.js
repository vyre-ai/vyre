// @ts-check
// A held group as one card (SPEC-0.3.0 11.8, over session-transfer's 11.3 server): the assistant's calls that wait together, each item's exact words, a drop or an edit on any, and one yes.
// The phone signs EACH approved item over that item's own payload hash and sends the proofs together (approvals.answer-group); an item left out, dropped, edited-after-signing or shown only
// in part is not covered. This file is the pure half; the card is apps/app/screens/shell/GroupApprovals.tsx.
import { hashMatches } from "./payload-hash.js";
import { cardsFrom } from "./phone-approve.js";

/** @typedef {import("./phone-approve.js").Pending & { readAll?: boolean, group?: string, words?: { field: string, text: string, cut?: boolean }[], partial?: boolean, edited?: boolean, line?: string, request?: { op: string, fields: Record<string, any> } }} Item */
/** @typedef {{ id: string, line: string, items: Item[] }} Group */

/**
 * The groups of an approvals.pending answer, each with its items in the order the server lists them. A card with no group is not in one (it stays a single card).
 * @param {any} answer @returns {Group[]}
 */
export function groupsFrom(answer) {
  const cards = /** @type {Item[]} */ (cardsFrom(answer));
  /** @type {Map<string, Group>} */ const by = new Map();
  const lines = new Map((Array.isArray(answer && answer.groups) ? answer.groups : []).map((/** @type {any} */ g) => [String(g.id), String(g.line || "")]));
  for (const c of cards) {
    if (!c.group) continue;
    /** @type {Group} */ const g = by.get(c.group) || { id: c.group, line: lines.get(c.group) || "", items: [] };
    g.items.push(c);
    by.set(c.group, g);
  }
  return [...by.values()];
}

/** The single cards: everything not in a group. @param {any} answer */
export const singlesFrom = (answer) => cardsFrom(answer).filter((c) => !(/** @type {Item} */ (c)).group);

/** What an item says it will do, as lines to read: every word the yes covers, flagged when it was cut for length. @param {Item} item */
export function wordLines(item) {
  return (item.words ?? []).map((w) => ({ field: w.field.replace(/_/g, " "), text: w.text, cut: Boolean(w.cut) }));
}

/** The one line over a group's button: how many it will approve of how many. @param {Group} g @param {Set<string>} dropped */
export function yesLabel(g, dropped) {
  const n = g.items.filter((i) => !dropped.has(i.id) && !i.partial).length;
  return n === 0 ? "Nothing to approve" : n === g.items.length ? `Approve all ${n}` : `Approve ${n} of ${g.items.length}`;
}

/**
 * Say yes once: sign each approved item over its own payload hash, then answer the group. An item the person dropped is sent as a no and signs nothing; an item shown only in part is left out.
 * A hash the server gave that is not the hash of the fields shown is refused before the key is asked (AP-1). One failed signature stops everything: nothing is sent half-signed.
 * @param {{ group: Group, dropped?: Set<string>, signer: import("./phone-approve.js").Signer | null, call: (tool: string, input: Record<string, unknown>) => Promise<any>, person: string }} a
 * @returns {Promise<{ group: string, results: { id: string, answered: string, why?: string }[] }>}
 */
export async function approveGroup({ group, dropped = new Set(), signer, call, person }) {
  if (!person) throw Object.assign(new Error("no person id"), { code: "no_person" });
  if (!signer) throw Object.assign(new Error("no signer"), { code: "no_signer" });
  const yes = group.items.filter((i) => !dropped.has(i.id) && !i.partial);
  for (const i of yes) if (!hashMatches(i)) throw Object.assign(new Error("the hash does not match what the card shows"), { code: "hash_mismatch" });
  /** @type {Record<string, any>} */ const proofs = {};
  const reqs = yes.map((i) => ({ op: i.op, space: i.space, fields: i.fields, payload_hash: i.payload_hash, prompt: i.line || i.title, person }));
  // A signer with a batch call asks for the face once for all of them (iPhone); one that answers null (Android prompts per use of the key) or has none signs one at a time
  let signed = typeof signer.signMany === "function" ? await signer.signMany(reqs) : null;
  if (!signed) signed = await reqs.reduce(async (acc, r) => { const out = await acc; out.push(await signer.signPresence(r)); return out; }, /** @type {Promise<any[]>} */ (Promise.resolve([])));
  yes.forEach((i, k) => {
    if (!signed[k] || signed[k].payload_hash !== i.payload_hash) throw Object.assign(new Error("the signed proof is not for this card"), { code: "needs_presence" });
    proofs[i.id] = signed[k];
  });
  const decisions = [...yes.map((i) => ({ id: i.id, approve: true })), ...group.items.filter((i) => dropped.has(i.id)).map((i) => ({ id: i.id, approve: false }))];
  const r = await call("approvals.answer-group", { group: group.id, decisions, proofs });
  return r;
}

/** Change some of the words of one item: the new hash and words come back, and that is what must be signed. @param {Item} item @param {Record<string, string>} edits @param {(tool: string, input: Record<string, unknown>) => Promise<any>} call @returns {Promise<Item>} */
export async function editItem(item, edits, call) {
  const r = await call("approvals.edit-item", { id: item.id, edits });
  if (!r || typeof r.payload_hash !== "string") throw Object.assign(new Error("the edit was not accepted"), { code: "bad_input" });
  // the card's signed fields change with its words: the request the server now holds is what the key will sign, read back before it is asked for
  return { ...item, payload_hash: r.payload_hash, words: r.words ?? item.words, edited: true, ...(r.partial ? { partial: true } : { partial: false }), ...(r.line ? { line: r.line } : {}) };
}

/** What a result list closes with: "Sent 3 emails. Each is logged on its client." (the log line only where the sent mail was filed), "Sent 2 emails; 1 dropped." */
const NOUN = [[/mail\.send|email/i, "email", "emails"], [/message|sms|text/i, "message", "messages"], [/invite|event/i, "invite", "invites"]];
/** @param {{ id: string, answered: string }[]} results @param {Group} group @param {{ logged?: boolean }} [o] */
export function closingLine(results, group, o = {}) {
  const sent = results.filter((r) => r.answered === "approved").length, dropped = results.filter((r) => r.answered === "dropped").length, waiting = results.filter((r) => r.answered === "waiting").length;
  // The tool a card is for is `request.op`: a card's own `op` is the act the key signs (task.outward_act for every outward call), the same for emails, posts and payments.
  const toolOf = (/** @type {Item} */ i) => (i.request && i.request.op) || i.op || "";
  const op = group.items[0] ? toolOf(group.items[0]) : "";
  const same = group.items.every((i) => toolOf(i) === op);
  const n = NOUN.find(([re]) => same && /** @type {RegExp} */ (re).test(op));
  const noun = n ? (sent === 1 ? n[1] : n[2]) : sent === 1 ? "thing" : "things";
  if (!sent) return dropped && !waiting ? "Nothing was sent." : waiting ? `${waiting} still ${waiting === 1 ? "waits" : "wait"} for you.` : "Nothing was sent.";
  const head = `Sent ${sent} ${noun}`;
  const tail = [dropped ? `${dropped} dropped` : "", waiting ? `${waiting} still ${waiting === 1 ? "waits" : "wait"}` : ""].filter(Boolean).join(", ");
  const log = o.logged && n && n[1] === "email" ? " Each is logged on its client." : "";
  return `${head}${tail ? `; ${tail}` : ""}.${log}`;
}

/**
 * Read an item to its end: approvals.item-view pages (about 50 values or 8000 characters each) until `next` is null, a long value arriving in parts that are joined. Returns the item with
 * every word, marked read (it stays `partial`: it is approved on its own, never with the group). The server refuses a yes on a part-shown item until this has been done (needs_view), and editing starts the reading again.
 * @param {Item} item @param {(tool: string, input: Record<string, unknown>) => Promise<any>} call @returns {Promise<Item>}
 */
export async function readAll(item, call) {
  /** @type {{ field: string, text: string, cut?: boolean }[]} */ const words = [];
  let offset = 0;
  for (let page = 0; page < 500; page++) {
    const r = await call("approvals.item-view", { id: item.id, offset });
    if (!r || !Array.isArray(r.words)) throw Object.assign(new Error("the item could not be read"), { code: "bad_input" });
    for (const w of r.words) {
      const last = words[words.length - 1];
      if (w.part && last && last.field === w.field) last.text += w.text;
      else words.push({ field: w.field, text: w.text });
    }
    if (r.next === null || r.next === undefined) return { ...item, words, readAll: true };
    offset = r.next;
  }
  throw Object.assign(new Error("the item is too long to read here"), { code: "too_long" });
}
