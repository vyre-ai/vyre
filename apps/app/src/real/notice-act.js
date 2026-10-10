// @ts-check
// Approve or Deny from a notice. A single held call's notice carries two buttons; each opens Now with `act` and `card`, and Now runs the very path the card on Now runs
// (phone-approve.js: approveCard signs the card's hash behind Face ID, refuseCard says no). A button on a lock screen is never a second way to say yes.
import { answerRefusal, approveCard, refuseCard } from "./phone-approve.js";

import { approveGroup, groupsFrom, singlesFrom } from "./group-approve.js";

export { actRoute } from "./notice-route.js";

const one = (/** @type {unknown} */ v) => (Array.isArray(v) ? v[0] : v);
const safe = (/** @type {unknown} */ v) => (typeof v === "string" && /^[\w.:-]{1,80}$/.test(v) ? v : "");

/** The answer a route asks for, or null for any other tap. @param {{ act?: unknown, card?: unknown, group?: unknown } | null | undefined} p @returns {{ act: "approve" | "deny", card?: string, group?: string } | null} */
export function actFrom(p) {
  const act = one(p?.act), card = safe(one(p?.card)), group = safe(one(p?.group));
  return (act === "approve" || act === "deny") && (card || group) && !(card && group) ? { act, ...(card ? { card } : { group }) } : null;
}

/** The one key that answers a want, to remember it was answered. @param {{ act: string, card?: string, group?: string }} w */
export const wantKey = (w) => `${w.act}:${w.card ?? w.group}`;

/**
 * Answer what a notice's button named, with the code the cards on Now run. Nothing still waiting (answered on another device, or ended) is said so and nothing is signed. A held call is a group, even alone: Approve
 * signs that one item over its own hash (approveGroup); it is refused here when more calls have joined the group or part of it is not shown, because the yes must cover only what was read. Deny drops every item and signs nothing.
 * @param {{ act: "approve" | "deny", card?: string, group?: string }} want @param {any} pending approvals.pending's answer
 * @param {{ signer: any, call: (tool: string, input: Record<string, unknown>, o?: { kernelProof?: string }) => Promise<any>, header: (proof: unknown) => string, person: string, how?: string }} d
 * @returns {Promise<{ kind: "approved" | "denied" | "gone" | "failed", title: string, say: string }>}
 */
export async function answerFromNotice(want, pending, d) {
  const gone = { kind: /** @type {"gone"} */ ("gone"), title: "", say: "That request ended before you answered." };
  try {
    if (want.group) {
      const g = groupsFrom(pending).find((x) => x.id === want.group);
      if (!g || !g.items.length) return gone;
      const title = g.line || g.items[0].line || g.items[0].title;
      if (want.act === "deny") {
        await d.call("approvals.answer-group", { group: g.id, decisions: g.items.map((i) => ({ id: i.id, approve: false })), proofs: {} });
        return { kind: "denied", title, say: `Denied: ${title}` };
      }
      if (g.items.length !== 1) return { kind: "failed", title, say: "More calls joined this one. Open it on Now and read each before you approve." };
      if (g.items[0].partial) return { kind: "failed", title, say: "Part of it is too long to show on a notice. Open it on Now and read it all." };
      const r = await approveGroup({ group: g, signer: d.signer, call: d.call, person: d.person });
      const a = Array.isArray(r?.results) ? r.results[0]?.answered : "";
      return a === "approved" ? { kind: "approved", title, say: `Approved: ${title}` } : { kind: "failed", title, say: "The approval did not go through." };
    }
    const c = singlesFrom(pending).find((x) => x.id === want.card);
    if (!c) return gone;
    if (want.act === "deny") { await refuseCard(c, d.call); return { kind: "denied", title: c.title, say: `Denied: ${c.title}` }; }
    await approveCard(c, d.signer, d.call, d.header, d.person);
    return { kind: "approved", title: c.title, say: `Approved: ${c.title}` };
  } catch (e) { return { kind: "failed", title: "", say: answerRefusal(/** @type {{ code?: string }} */ (e).code, d.how) }; }
}
