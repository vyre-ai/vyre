// @ts-check
// Joining people to a team Space and reading a chat's frames through the member door, shared by the member journeys (J11, J12).
import assert from "node:assert/strict";
import path from "node:path";
import { createApp } from "../../lib/proof/app.mjs";

const chainOf = (/** @type {string} */ space, /** @type {string} */ person) => ({ space, hops: [{ actor: { kind: "person", id: person, space } }] });

/** One person joins the team Space with their own app, as the owner invites them. @param {{ w: any, team: any, who: string, role?: string }} o */
export async function joinOne({ w, team, who, role = "member" }) {
  const { mac, ins } = w;
  const app = createApp({ label: `Member day ${who}`, dir: path.join(w.dir, who.toLowerCase()), directory: ins.names, relay: ins.relay });
  const r = await app.reserve(`${who.toLowerCase()}${Math.random().toString(36).slice(2, 6)}`);
  await app.becomeYourself({ name: r.name, code: r.code });
  const owner = chainOf(team.space, mac.identity.id);
  const invite = await mac.makeTeamInvite({ space: team.space, name: team.label, to: r.name, role, signPresence: async (/** @type {any} */ card) => mac.presenceSigner.proof(owner, card.op, card.fields, { extra: { home: card.home, challenge: card.challenge } }) });
  invite.close();
  // an invite to the admin role waits for the owner to confirm the words the invitee reads out (the kernel records them; it has nothing to compare them with)
  if (role === "admin") await mac.confirmInvite({ space: team.space, id: invite.id, words: "walk words for the admin", signPresence: async (/** @type {any} */ card) => mac.presenceSigner.proof(owner, card.op, card.fields, { extra: { home: card.home, challenge: card.challenge } }) });
  const sg = app.presenceSigner, chain = chainOf(team.space, app.identity.id);
  const joined = await app.joinTeam({ link: invite.link, signPresence: async (/** @type {any} */ req) => sg.proof(chain, req.op, req.fields), presenceKey: async () => sg.enrolment(app.identity.id) });
  assert.equal(joined.joined.joined, true, `${who} joined`);
  return { name: who, app, invite, joined, id: String(app.identity.id) };
}

/** Every frame of a chat a person may read, from the start, as the member door gives it (pages of 200). @param {{ call: (c: string, a: any[]) => Promise<any> }} joined @param {string} chat */
export async function framesOf(joined, chat) {
  /** @type {any[]} */ const out = [];
  let from = 0;
  for (let i = 0; i < 50; i++) {
    const r = await joined.call("chat.read", [{ chat, from, limit: 200 }]);
    out.push(...(r.frames || []));
    if (!r.frames || r.frames.length < 200 || r.next <= from) break;
    from = r.next;
  }
  return out;
}

