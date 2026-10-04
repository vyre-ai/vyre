// @ts-check
import { randomBytes } from "node:crypto";
// modules: the owner's reset of the accepted first-party module list (kernel/home.js resetModulesList). A rollback to an older release is below the counter the home already accepted, so the
// older build's list is refused until the owner says so, once, with their presence. This module only carries that act: the kernel checks that the chain is exactly the owner (never a
// delegated, viewer or room chain), checks the presence proof over the counter it forgets, and writes the one `kernel.modules-list-reset` event. Nothing here decides.
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** @type {Record<string, string>} */
const WHY = {
  owner_only: "only the owner resets the module list",
  no_signed_list: "this build has no signed module list to reset",
  no_presence_verifier: "this home cannot check your presence yet",
  needs_presence: "this needs your presence: approve it on your device",
  no_proof: "this needs your presence: approve it on your device",
};

const ASK_MS = 5 * 60_000;
/** One new ask per this long per boot: a label that anyone with a shell has must not be a way to nag the owner's phone. */
const NEW_ASK_MS = 10 * 60_000;
const PERSON_SURFACES = ["cli", "local", "deck", "capsule", "mobile", "device"];
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: false });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const now = typeof ctx.now === "function" ? ctx.now : Date.now;
    /** The one open ask (a rollback waits for the owner's phone): what the phone shows and signs, never a secret. @type {{ id: string, payload: any, at: number, state: "waiting" | "approved" | "refused" } | null} */
    let ask = null, lastAskAt = -Infinity;
    const live = () => { if (ask && ask.state === "waiting" && now() - ask.at > ASK_MS) ask = null; return ask; };
    const payload = (/** @type {string} */ askId) => (typeof ctx.modulesListResetPayload === "function" ? ctx.modulesListResetPayload(askId) : null);
    const card = (/** @type {any} */ a) => ({ id: a.id, state: a.state, title: "Put the older version back?", body: "A rollback to an older release needs you. Approve with Face ID on this phone, or say no and nothing changes.", op: a.payload.op, space: a.payload.space, fields: a.payload.fields, payload_hash: a.payload.payload_hash, expires_in_s: Math.max(0, Math.round((ASK_MS - (now() - a.at)) / 1000)) });
    const needKernel = () => { if (typeof ctx.modulesListReset !== "function" || !ctx.kernel) throw refuse("this build runs without its kernel, so there is no module list to reset", "unavailable"); };
    const reset = async (/** @type {any} */ meta, /** @type {string} */ askId) => {
      const chain = await ctx.kernel.chain(meta);
      const given = ctx.kernel.proofFrom(meta), proof = given && given.presence ? given.presence : null; // proofFrom answers `{ presence }` (or `{}`), the option a kernel call takes
      const r = await ctx.modulesListReset(chain, proof || null, askId);
      if (!r || r.ok !== true) {
        const why = String((r && r.why) || "refused");
        throw refuse(WHY[why] || `the module list was not reset: ${why === "wrong_payload" || why === "wrong_proof" ? "that approval was not for this" : why}`, why === "owner_only" ? "denied" : why === "no_signed_list" || why === "no_presence_verifier" ? "unavailable" : "needs_presence");
      }
      return { reset: true };
    };
    ctx.tool("modules.list.reset", {
      description: "Forget the accepted first-party module list so an older release's list can be used (a rollback). The owner only, with their presence. Writes one event.",
      input: obj(),
      callers: PERSON_SURFACES,
      run: async (/** @type {any} */ _input, /** @type {any} */ meta) => { needKernel(); return reset(meta); },
    });
    // The rollback's route to the owner's phone: the box asks, the phone shows what it will do and signs it with Face ID (the proof is over the counter dropped to, single use, checked by the sealing process), the box reads the answer.
    ctx.tool("modules.list.reset.ask", {
      description: "Ask the owner's paired phone to approve dropping the accepted module list (a rollback to an older release). Answers { id, expires_in_s }; read the outcome with modules.list.reset.status. Nothing changes until the owner approves; one ask at a time, open for 5 minutes.",
      input: obj(),
      callers: ["cli", "local"],
      run: async () => {
        needKernel();
        if (!payload()) throw refuse(WHY.no_signed_list, "unavailable");
        if (live() && ask && ask.state === "waiting") return { id: ask.id, expires_in_s: card(ask).expires_in_s };
        if (now() - lastAskAt < NEW_ASK_MS) throw refuse("a rollback was asked for a moment ago: wait a few minutes before asking again", "rate_limited");
        const askId = `rr_${randomBytes(9).toString("base64url")}`;
        lastAskAt = now();
        ask = { id: askId, payload: payload(askId), at: now(), state: "waiting" };
        return { id: ask.id, expires_in_s: ASK_MS / 1000 };
      },
    });
    ctx.tool("modules.list.reset.pending", {
      description: "The rollback approval waiting for the owner, as the phone shows it: { id, title, body, op, space, fields, payload_hash } to sign, or { none: true }.",
      input: obj(),
      callers: PERSON_SURFACES,
      run: async () => { const a = live(); return a && a.state === "waiting" ? card(a) : { none: true }; },
    });
    ctx.tool("modules.list.reset.answer", {
      description: "The owner's answer to the rollback ask: { id, approve: true } with the presence proof signed over the card's payload_hash (Face ID on the phone), or { id, approve: false }. A refusal, a wrong proof or a timed-out ask changes nothing.",
      input: obj({ id: { type: "string" }, approve: { type: "boolean" } }, ["id", "approve"]),
      callers: PERSON_SURFACES,
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        needKernel();
        const a = live();
        if (!a || a.state !== "waiting" || a.id !== String(input.id)) throw refuse("there is no rollback waiting for you", "not_found");
        // A no ends the ask only from the person's own session: a label alone cannot cancel the owner's rollback.
        if (input.approve !== true) { if (!meta || !meta.person) return { answered: "ignored", why: "a no needs your signed-in session" }; a.state = "refused"; return { answered: "refused" }; }
        const p = payload(a.id);
        if (!p || p.payload_hash !== a.payload.payload_hash) { ask = null; throw refuse("the list changed while you looked: ask again", "stale"); }
        await reset(meta, a.id);
        a.state = "approved";
        return { answered: "approved" };
      },
    });
    ctx.tool("modules.list.reset.status", {
      description: "Where the rollback ask stands: waiting, approved, refused, or none (it timed out or never was). The updater reads this, then restores.",
      input: obj({ id: { type: "string" } }, ["id"]),
      callers: ["cli", "local"],
      run: async (/** @type {any} */ input) => {
        const a = live();
        if (!a || a.id !== String(input.id)) return { state: "none" };
        // An answer is read once: the updater has it, so the ask is cleared.
        if (a.state !== "waiting") ask = null;
        return { state: a.state };
      },
    });
    return { async stop() { ask = null; } };
  },
};
