// @ts-check
// approvals: "approve on your phone" for any act that needs a presence proof the asking session cannot give (the web app's software key). The act is a kernel act a person signs (a grant or a task decision):
// its op and fields are what the kernel's one verifier checks (kernel/remote/proof.js proofRequest builds them). The asker opens a request with them, the paired phone lists it, shows what will
// happen and signs the payload hash with Face ID, and the asker reads the proof back ONCE and attaches it to its own act (`kernel_proof`), where the kernel verifies it (counter-bound, single use).
// This module decides nothing and checks no signature: a wrong or replayed proof is refused by the act itself. The same shape as the rollback route (core/modulelist), for any op.
import { randomBytes } from "node:crypto";
import { payloadHash } from "../../kernel/seal/wire.js";
import { proofRequest, PROOF_CALLS } from "../../kernel/remote/proof.js";

const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const SURFACES = ["cli", "local", "deck", "capsule", "mobile", "device"];
const ASK_MS = 5 * 60_000, MAX_OPEN = 5, MAX_PROOF = 4096;
/** Plain words for what each op does; an op not here is shown by its name. */
const WORDS = { "grant.invite": "Invite someone to this space", "grant.role": "Change who is in this space and what they may do", "grant.create": "Give access", "grant.revoke": "Take access away", "grant.narrow": "Narrow an access", "grant.offer": "Offer something to the space", "task.decide": "Approve or reject a task" };
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: false });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const now = typeof ctx.now === "function" ? ctx.now : Date.now;
    /** @type {Map<string, { id: string, op: string, space: string, fields: any, payload_hash: string, from: string, at: number, state: "waiting" | "approved" | "refused", proof?: any }>} */
    const open = new Map();
    const sweep = () => { for (const [id, a] of open) if (a.state === "waiting" && now() - a.at > ASK_MS) open.delete(id); };
    const card = (/** @type {any} */ a) => ({ id: a.id, title: WORDS[/** @type {keyof typeof WORDS} */ (a.op)] || a.op, body: "Approve with Face ID on this phone, or say no and nothing changes.", op: a.op, space: a.space, fields: a.fields, payload_hash: a.payload_hash, asked_from: a.from, expires_in_s: Math.max(0, Math.round((ASK_MS - (now() - a.at)) / 1000)) });
    const mine = (/** @type {any} */ meta, /** @type {any} */ a) => a && meta && a.from === String(meta.caller || "");

    ctx.tool("approvals.request", {
      description: "The exact proof request for a kernel act, so no client re-implements the kernel's hashing: give the space, the act's name (one of the grants and rules calls, see `calls` in the answer to a call with no name) and its arguments as that call takes them. Answers { op, space, fields, payload_hash }: ask with these (approvals.ask) and have the phone sign payload_hash. Changes nothing.",
      input: obj({ space: { type: "string" }, call: { type: "string" }, args: { type: "array" } }, ["space", "call"]),
      callers: SURFACES,
      run: async (/** @type {any} */ input) => {
        if (!/^spc_[a-z2-7]{12}$/.test(String(input.space || ""))) throw refuse("name the space the act is in", "bad_input");
        if (!PROOF_CALLS.includes(String(input.call))) throw refuse(`no such act: ${PROOF_CALLS.join(", ")}`, "bad_input");
        const args = Array.isArray(input.args) ? input.args : [];
        if (JSON.stringify(args).length > 8192) throw refuse("the arguments are too large", "bad_input");
        try { const r = proofRequest(String(input.space), String(input.call), ...args); return { op: r.op, space: r.space, fields: r.fields, payload_hash: r.payload_hash }; }
        catch (e) { throw refuse(String(/** @type {any} */ (e).message || e).slice(0, 200), "bad_input"); }
      },
    });
    ctx.tool("approvals.ask", {
      description: "Ask the person's paired phone to approve an act this session cannot prove itself. Give the op and fields the kernel will verify (grant.* or task.decide, as the proof request for the act builds them). Answers { id, payload_hash, expires_in_s }; read the outcome with approvals.status. Open for 5 minutes; at most 5 open.",
      input: obj({ op: { type: "string" }, space: { type: "string" }, fields: { type: "object" } }, ["op", "space", "fields"]),
      callers: SURFACES,
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        sweep();
        const op = String(input.op || "");
        if (!/^(grant\.[a-z_]{1,40}|task\.decide)$/.test(op)) throw refuse("that is not an act a phone approval covers", "bad_input");
        if (!/^spc_[a-z2-7]{12}$/.test(String(input.space || ""))) throw refuse("name the space the act is in", "bad_input");
        if (!input.fields || typeof input.fields !== "object" || Array.isArray(input.fields) || JSON.stringify(input.fields).length > 4096) throw refuse("the fields of the act, plain data", "bad_input");
        if ([...open.values()].filter(a => a.state === "waiting").length >= MAX_OPEN) throw refuse("too many approvals are waiting: answer or wait for them to end", "rate_limited");
        const payload_hash = payloadHash(op, String(input.space), input.fields);
        const id = `ap_${randomBytes(9).toString("base64url")}`;
        const a = { id, op, space: String(input.space), fields: input.fields, payload_hash, from: String(meta.caller || ""), at: now(), state: /** @type {"waiting"} */ ("waiting") };
        open.set(id, a);
        return { id, payload_hash, expires_in_s: ASK_MS / 1000 };
      },
    });
    ctx.tool("approvals.pending", {
      description: "What is waiting for the person, as the phone shows it: [{ id, title, body, op, space, fields, payload_hash, asked_from, expires_in_s }]. Sign payload_hash and nothing else.",
      input: obj(),
      callers: SURFACES,
      run: async () => { sweep(); return { approvals: [...open.values()].filter(a => a.state === "waiting").map(card) }; },
    });
    ctx.tool("approvals.answer", {
      description: "The person's answer: { id, approve: true } with the presence proof signed over the card's payload_hash beside the call (x-vyre-kernel-proof), or { id, approve: false }. A no ends it only from the person's own signed-in session. Nothing is checked here: the act verifies the proof.",
      input: obj({ id: { type: "string" }, approve: { type: "boolean" } }, ["id", "approve"]),
      callers: SURFACES,
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        sweep();
        const a = open.get(String(input.id));
        if (!a || a.state !== "waiting") throw refuse("there is nothing waiting for you with that id", "not_found");
        if (input.approve !== true) { if (!meta || !meta.person) return { answered: "ignored", why: "a no needs your signed-in session" }; a.state = "refused"; return { answered: "refused" }; }
        const given = ctx.kernel && typeof ctx.kernel.proofFrom === "function" ? ctx.kernel.proofFrom(meta) : null;
        const proof = given && given.presence ? given.presence : null; // proofFrom answers `{ presence }`, the option a kernel call takes
        if (!proof || typeof proof !== "object" || JSON.stringify(proof).length > MAX_PROOF) throw refuse("this needs your presence: approve it on your device", "needs_presence");
        if (proof.payload_hash !== a.payload_hash) throw refuse("that approval was not for this", "needs_presence");
        a.state = "approved"; a.proof = proof;
        return { answered: "approved" };
      },
    });
    ctx.tool("approvals.status", {
      description: "Where an approval this session asked for stands: { state: waiting | approved | refused | none }, and when approved the proof, once, to attach to the act as kernel_proof. Only the session that asked reads it.",
      input: obj({ id: { type: "string" } }, ["id"]),
      callers: SURFACES,
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        sweep();
        const a = open.get(String(input.id));
        if (!a || !mine(meta, a)) return { state: "none" };
        if (a.state === "waiting") return { state: "waiting" };
        open.delete(a.id);
        return a.state === "approved" ? { state: "approved", proof: a.proof } : { state: "refused" };
      },
    });

    return { async stop() { open.clear(); } };
  },
};
