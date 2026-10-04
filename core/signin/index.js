// @ts-check
// signin: `vyre signin`, the daemon half. The command line asks, the paired phone approves with Face ID, the terminal gets a person session of its own (see approvals, the same route for kernel acts).
import { randomBytes, createHash } from "node:crypto";
import os from "node:os";
import { payloadHash } from "../../kernel/seal/wire.js";

const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const SURFACES = ["cli", "local", "deck", "capsule", "mobile", "device"];
const ASK_MS = 5 * 60_000, MAX_OPEN = 5;
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: false });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const now = typeof ctx.now === "function" ? ctx.now : Date.now;

    // ---- `vyre signin`: the command line asks, the phone approves, the terminal gets a person session of its own ----
    // The pin is the terminal login key the daemon measured for the asking call (never a model's shell: it has none). The session is made for exactly that terminal (`cli:<key>`), so a token read from the
    // CLI's file is no use to anything else. The phone's proof is over { ask, pin_hash }, checked once by the kernel's verifier; this module mints the session only after it stands.
    /** @type {Map<string, { id: string, pin: string, pin_hash: string, at: number, state: "waiting" | "approved" | "refused", token?: string }>} */
    const signins = new Map();
    const sweepIn = () => { for (const [id, a] of signins) if (a.state === "waiting" && now() - a.at > ASK_MS) signins.delete(id); };
    const hashPin = (/** @type {string} */ pin) => createHash("sha256").update(pin).digest("base64url");
    const space = () => String((ctx.kernel && ctx.kernel.space) || "");
    const inCard = (/** @type {any} */ a) => { const fields = { ask: a.id, pin_hash: a.pin_hash }; return { id: a.id, title: `Sign in the command line on ${os.hostname()}?`, body: "Approve with Face ID on this phone, or say no and nothing changes.", op: "grant.signin", space: space(), fields, payload_hash: payloadHash("grant.signin", space(), fields), expires_in_s: Math.max(0, Math.round((ASK_MS - (now() - a.at)) / 1000)) }; };
    ctx.tool("signin.ask", {
      description: "Ask the person's paired phone to sign this terminal in. Answers { id, expires_in_s }; a call with no login terminal (a model's shell) is refused. Read the outcome with signin.status.",
      input: obj(),
      callers: ["cli", "local"],
      run: async (/** @type {any} */ _i, /** @type {any} */ meta) => {
        sweepIn();
        const pin = meta && typeof meta.terminalKey === "string" ? meta.terminalKey : "";
        if (!pin) throw refuse("sign in from your own terminal: this call has no login terminal", "no_terminal");
        for (const a of signins.values()) if (a.state === "waiting" && a.pin === pin) return { id: a.id, expires_in_s: inCard(a).expires_in_s };
        if ([...signins.values()].filter(a => a.state === "waiting").length >= MAX_OPEN) throw refuse("too many sign-ins are waiting", "rate_limited");
        const id = `si_${randomBytes(9).toString("base64url")}`;
        signins.set(id, { id, pin, pin_hash: hashPin(pin), at: now(), state: "waiting" });
        return { id, expires_in_s: ASK_MS / 1000 };
      },
    });
    ctx.tool("signin.pending", {
      description: "The command-line sign-ins waiting for the person, as the phone shows them: { approvals: [{ id, title, body, op, space, fields, payload_hash, expires_in_s }] }. Sign payload_hash and nothing else.",
      input: obj(),
      callers: SURFACES,
      run: async () => { sweepIn(); return { approvals: [...signins.values()].filter(a => a.state === "waiting").map(inCard) }; },
    });
    ctx.tool("signin.answer", {
      description: "The person's answer to a command-line sign-in: { id, approve: true } with the presence proof signed over the card's payload_hash beside the call, or { id, approve: false } (a no ends it only from the person's own signed-in session).",
      input: obj({ id: { type: "string" }, approve: { type: "boolean" } }, ["id", "approve"]),
      callers: SURFACES,
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        sweepIn();
        const a = signins.get(String(input.id));
        if (!a || a.state !== "waiting") throw refuse("there is no sign-in waiting with that id", "not_found");
        if (input.approve !== true) { if (!meta || !meta.person) return { answered: "ignored", why: "a no needs your signed-in session" }; a.state = "refused"; return { answered: "refused" }; }
        if (!ctx.kernel || typeof ctx.kernel.verifyProof !== "function" || !ctx.personSessions) throw refuse("this build cannot sign a terminal in", "unavailable");
        const given = ctx.kernel.proofFrom(meta), proof = given && given.presence ? given.presence : null; // proofFrom answers `{ presence }`, the option a kernel call takes
        if (!proof) throw refuse("this needs your presence: approve it on your device", "needs_presence");
        const chain = await ctx.kernel.chain(meta);
        const why = await ctx.kernel.verifyProof({ chain, op: "grant.signin", fields: { ask: a.id, pin_hash: a.pin_hash }, proof });
        if (why) throw refuse(why === "wrong_payload" ? "that approval was not for this" : "this needs your presence: approve it on your device", "needs_presence");
        const s = ctx.personSessions.start({ node: `cli:${a.pin}`, kind: "cookie", label: "command line" });
        a.state = "approved"; a.token = s.token;
        return { answered: "approved" };
      },
    });
    ctx.tool("signin.status", {
      description: "Where this terminal's sign-in stands: { state: waiting | approved | refused | none }; when approved the bearer token, once, to keep in the 0600 session file (30 days idle, 90 at most).",
      input: obj({ id: { type: "string" } }, ["id"]),
      callers: ["cli", "local"],
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        sweepIn();
        const a = signins.get(String(input.id));
        if (!a || !meta || meta.terminalKey !== a.pin) return { state: "none" };
        if (a.state === "waiting") return { state: "waiting" };
        signins.delete(a.id);
        return a.state === "approved" ? { state: "approved", token: a.token, expires_in_days: 30 } : { state: "refused" };
      },
    });
    ctx.tool("signin.out", {
      description: "End this terminal's session: the token stops working at once.",
      input: obj(),
      callers: ["cli", "local"],
      run: async (/** @type {any} */ _i, /** @type {any} */ meta) => { if (meta && meta.person && ctx.personSessions) { ctx.personSessions.revoke(meta.person.id); return { out: true }; } return { out: false }; },
    });
    return { async stop() { signins.clear(); } };
  },
};
