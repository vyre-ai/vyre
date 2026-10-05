// @ts-check
// "Let <space> keep your planner running": the person's one yes for a team server, then the phone answers that server's unlock requests by itself until the person revokes it (core/memory/identity: grant,
// unlock.begin, unlock.finish, revoke). A Personal person in a Cloud space has their planner run on the team server with the laptop off; the server needs the identity key for that, and only this phone can give it.
//   grant   status gives the server's key (pinned here, and checked against the fingerprint the home will name), the vault moment's proof is signed with this device's key (Face ID, or the passkey in a browser), and the
//           grant tool records the yes in the identity home.
//   answer  on memory.unlock-asked (only while a grant stands) the phone asks the server for the request, checks it, answers with its agree key, and finishes.
//   revoke  the grant is removed on the server and the pin is forgotten here: nothing is answered again.
import { fingerprint } from "../../../../lib/keywrap.js";
import { payloadHash } from "../real/payload-hash.js";
import { answerUnlock } from "./unlock.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** The words on the card. @param {string} space the space's name as the person knows it */
export const grantLine = (space) => `Let ${space} keep your planner running`;
export const GRANT_BODY = "It keeps your reminders and notes ringing when your computer is off. It can read them only while this yes stands, and you can take it back here any time.";

/**
 * What the person's key signs for this yes: the vault moment over the identity memory's unlock, for this identity and this server. It is lib/one-yes.js signOf("vault", request) written out here, because that file
 * pulls the server's caller code in with it (grant.test.js holds the two equal). @param {{ id: string, server: string }} status
 */
export const yesRequest = (status) => ({ op: "task.vault_use", fields: { what: "memory.identity.unlock", fields: { identity: String(status.id), server: String(status.server) } } });

/**
 * The person's one yes for this server.
 * @param {{ call: (tool: string, input?: Record<string, unknown>) => Promise<any>, signer: { signPresence(req: any): Promise<any> } | null, person: string, space: string, name: string, pins: { set(fp: string, jwk: { x: string, y: string }): Promise<void> | void } }} o
 * @returns {Promise<{ fp: string }>}
 */
export async function grantServer(o) {
  if (!o.signer) throw fail("no_signer", "This phone cannot give the yes yet. Update Vyre.");
  const st = await o.call("memory.identity.status", {});
  if (!st || typeof st.id !== "string" || typeof st.server !== "string" || !st.server_key) throw fail("not_ready", "This server is not keeping your private notes yet.");
  // The key to pin must be the one whose fingerprint the grant will name: a server cannot have the person say yes to one key and be answered under another.
  if (fingerprint(st.server_key) !== st.server) throw fail("bad_key", "This server's key does not match its name. Nothing was granted.");
  const sign = yesRequest(st);
  // The Space the sealing process checks the proof against is the one the server names in its status (the person's chain's own Space); the caller's space is the fallback for an older server.
  const space = typeof st.space === "string" && st.space ? st.space : o.space;
  const proof = await o.signer.signPresence({ op: sign.op, space, fields: sign.fields, payload_hash: payloadHash(sign.op, space, sign.fields), prompt: grantLine(o.name), person: o.person });
  const done = await o.call("memory.identity.grant", { proof });
  if (!Array.isArray(done?.granted) || !done.granted.some((/** @type {any} */ g) => g && g.fp === st.server)) throw fail("not_granted", "The server did not take the yes.");
  await o.pins.set(st.server, { x: st.server_key.x, y: st.server_key.y });
  return { fp: st.server };
}

/**
 * A server wants the key (memory.unlock-asked): ask it for the request, check it, answer, finish. Does nothing for a server this person did not say yes to.
 * @param {{ call: (tool: string, input?: Record<string, unknown>) => Promise<any>, agree: { holder: string, ecdh: any }, granted: ReadonlyMap<string, { x: string, y: string }> }} o
 */
export async function answerAsk(o) {
  const { ask } = await o.call("memory.identity.unlock.begin", {});
  const answer = await answerUnlock(ask, o.agree, o.granted);
  await o.call("memory.identity.unlock.finish", { request: ask.request, answer });
  return { server: ask.server };
}

/** Take the yes back: the server locks and answers nothing again, and the pin goes. @param {{ call: (tool: string, input?: Record<string, unknown>) => Promise<any>, fp: string, pins: { delete(fp: string): Promise<void> | void } }} o */
export async function revokeServer(o) {
  await o.call("memory.identity.revoke", {});
  await o.pins.delete(o.fp);
}
