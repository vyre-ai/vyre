// @ts-check
// approvals: "approve on your phone" for any act that needs a presence proof the asking session cannot give (the web app's software key). The act is a kernel act a person signs (a grant or a task decision):
// its op and fields are what the kernel's one verifier checks (kernel/remote/proof.js proofRequest builds them). The asker opens a request with them, the paired phone lists it, shows what will
// happen and signs the payload hash with Face ID, and the asker reads the proof back ONCE and attaches it to its own act (`kernel_proof`), where the kernel verifies it (counter-bound, single use).
// This module decides nothing and checks no signature: a wrong or replayed proof is refused by the act itself. The same shape as the rollback route (core/modulelist), for any op.
import { newId } from "../../lib/id.js";
import { payloadHash } from "../../kernel/seal/wire.js";
import { proofRequest, PROOF_CALLS } from "../../kernel/remote/proof.js";
import { yes, signOf, setCardRedeemer, opFitsMoment, lineOfOp } from "../../lib/one-yes.js";

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
    /** @type {Map<string, { id: string, op: string, space: string, fields: any, payload_hash: string, from: string, at: number, state: "waiting" | "approved" | "refused", proof?: any, moment?: string, request?: any, line?: string, verified?: boolean, used?: boolean }>} */
    const open = new Map();
    const sweep = () => { for (const [id, a] of open) if ((a.state === "waiting" && now() - a.at > ASK_MS) || (a.moment && a.state !== "waiting" && now() - a.at > ASK_MS * 2)) open.delete(id); };
    const card = (/** @type {any} */ a) => ({ id: a.id, title: WORDS[/** @type {keyof typeof WORDS} */ (a.op)] || a.op, body: "Approve with Face ID on this phone, or say no and nothing changes.", op: a.op, space: a.space, fields: a.fields, payload_hash: a.payload_hash, asked_from: a.from, expires_in_s: Math.max(0, Math.round((ASK_MS - (now() - a.at)) / 1000)) });
    const mine = (/** @type {any} */ meta, /** @type {any} */ a) => a && meta && a.from === String(meta.caller || "");

    // ---- a yes for one of the three moments (DESIGN-one-yes: one card queue for every yes) ---------------------------------------------------------------
    // A device that cannot sign the yes itself (a browser) asks with `{ moment, request: { op, fields } }`: the card is validated against the moment, written by THIS server (the asker's words are never shown) and shown
    // on the owner's phone with `sign` (exactly what its key signs). The phone's answer is verified by yes() and spent right then, so no proof ever travels to the asker; the asker's act spends the approved card
    // ONCE (`yes(moment, request, { card: id })`). A device cannot answer its own card, and a "no" counts only from a signed-in person session.
    /** @param {string} moment @param {any} request @returns {{ op: string, fields: Record<string, string | number | boolean> } | null} */
    const cardRequest = (moment, request) => {
      if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.op !== "string" || !opFitsMoment(moment, request.op, n => Boolean(ctx.modules && typeof ctx.modules.isOutward === "function" && ctx.modules.isOutward(n)))) return null;
      const f = request.fields && typeof request.fields === "object" && !Array.isArray(request.fields) ? request.fields : {};
      const keys = Object.keys(f);
      if (keys.length > 12) return null;
      /** @type {Record<string, string | number | boolean>} */ const fields = {};
      for (const k of keys) { const v = f[k]; if (!/^[a-z][a-z0-9_]{0,31}$/.test(k) || !(typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 200))) return null; fields[k] = v; }
      return { op: request.op, fields };
    };
    // Which device is calling comes from the transport's verified peer (the kernel's own facts: `meta.peer`, set by the daemon from a vouched connection), never from the caller LABEL a string says (person-label-hygiene).
    const deviceOf = (/** @type {any} */ meta) => { const p = meta && meta.peer; return p && p.kind === "device" ? (String(p.stableId || p.node || "") || null) : null; };
    const canon = (/** @type {any} */ o) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
    /** A device the owner declined cannot ask again for ten minutes. @type {Map<string, number>} */
    const refusedUntil = new Map();
    setCardRedeemer((id, moment, request, device) => {
      const a = open.get(id);
      if (!a || !a.moment || a.state !== "approved" || !a.verified || now() - a.at > ASK_MS * 2) return "no_proof";
      if (a.used) return "replayed";
      if (a.moment !== moment || a.request.op !== request.op || canon(a.request.fields) !== canon(request.fields && typeof request.fields === "object" ? request.fields : {}) || (device && device !== a.device)) return "wrong_request";
      a.used = true;
      return "ok";
    });
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
      input: obj({ op: { type: "string" }, space: { type: "string" }, fields: { type: "object" }, moment: { type: "string", enum: ["pair", "vault", "outward"] }, request: { type: "object" } }, []),
      callers: SURFACES,
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        sweep();
        if (input.moment !== undefined) {
          // a yes for one of the three moments: the card is made here from a validated request
          const moment = String(input.moment);
          const request = cardRequest(moment, input.request);
          if (!request) throw refuse("that request does not fit this kind of card", "bad_input");
          const from = String(meta.caller || "");
          const hold = refusedUntil.get(from);
          if (hold && hold > now()) throw refuse("the owner said no to this device a moment ago; try again in a few minutes", "rate_limited");
          const same = [...open.values()].find(a => a.moment && a.from === from && a.state === "waiting");
          if (same) {
            if (same.moment === moment && canon(same.request.fields) === canon(request.fields) && same.request.op === request.op) return { id: same.id, expires_in_s: Math.max(1, Math.round((ASK_MS - (now() - same.at)) / 1000)), line: same.line };
            throw Object.assign(refuse("another card from this device is still waiting", "conflict"), { data: { open: { id: same.id, moment: same.moment } } });
          }
          if ([...open.values()].filter(a => a.state === "waiting").length >= MAX_OPEN) throw refuse("too many approvals are waiting: answer or wait for them to end", "rate_limited");
          const sg = signOf(moment, request), space = String((ctx.kernel && ctx.kernel.space) || "");
          const payload_hash = payloadHash(sg.op, space, sg.fields);
          const id = `ap_${newId()}`;
          let who = "A device";
          const device = deviceOf(meta);
          try { const d = device ? await ctx.call("wink.device.record", { id: device }) : null; if (d && d.data && d.data.name) who = String(d.data.name); } catch { /* the generic name */ }
          const line = lineOfOp(request.op, request.fields, who);
          open.set(id, { id, op: sg.op, space, fields: sg.fields, payload_hash, from, device, at: now(), state: "waiting", moment, request, line });
          return { id, expires_in_s: ASK_MS / 1000, line };
        }
        const op = String(input.op || "");
        if (!input.space || !input.fields) throw refuse("give the op, the space and the fields of the act", "bad_input");
        if (!/^(grant\.[a-z_]{1,40}|task\.decide)$/.test(op)) throw refuse("that is not an act a phone approval covers", "bad_input");
        if (!/^spc_[a-z2-7]{12}$/.test(String(input.space || ""))) throw refuse("name the space the act is in", "bad_input");
        if (!input.fields || typeof input.fields !== "object" || Array.isArray(input.fields) || JSON.stringify(input.fields).length > 4096) throw refuse("the fields of the act, plain data", "bad_input");
        if ([...open.values()].filter(a => a.state === "waiting").length >= MAX_OPEN) throw refuse("too many approvals are waiting: answer or wait for them to end", "rate_limited");
        const payload_hash = payloadHash(op, String(input.space), input.fields);
        const id = `ap_${newId()}`;
        const a = { id, op, space: String(input.space), fields: input.fields, payload_hash, from: String(meta.caller || ""), at: now(), state: /** @type {"waiting"} */ ("waiting") };
        open.set(id, a);
        return { id, payload_hash, expires_in_s: ASK_MS / 1000 };
      },
    });
    // The registry holds an outward tool's call from an agent, a model, a module or a guest here (core/modules, one yes): the same card as a device's, bound to the asker the registry names (never anything the
    // asker said) and to the call's input by digest. The registry alone calls this; the asker later retries its call with the card's id and the registry spends it (yes, `{ card }`).
    ctx.tool("approvals.hold", {
      internal: true,
      description: "The registry's own: hold an outward call from a caller that is not you as a card on your phone. Answers { id, line }.",
      input: obj({ tool: { type: "string" }, fields: { type: "object" }, from: { type: "string" } }, ["tool", "fields", "from"]),
      callers: ["module"],
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        if (String((meta && meta.caller) || "") !== "module:registry") throw refuse("only the registry holds a call", "denied");
        sweep();
        const request = cardRequest("outward", { op: input.tool, fields: input.fields });
        if (!request) throw refuse("that call does not fit an outward card", "bad_input");
        const from = String(input.from || "");
        const same = [...open.values()].find(a => a.moment && a.from === from && a.state === "waiting" && a.request.op === request.op && canon(a.request.fields) === canon(request.fields));
        if (same) return { id: same.id, line: same.line };
        if ([...open.values()].filter(a => a.state === "waiting").length >= MAX_OPEN) throw refuse("too many approvals are waiting: answer or wait for them to end", "rate_limited");
        const sg = signOf("outward", request), space = String((ctx.kernel && ctx.kernel.space) || "");
        const payload_hash = payloadHash(sg.op, space, sg.fields);
        const id = `ap_${newId()}`;
        const line = lineOfOp(request.op, request.fields, `An assistant (${from.replace(/^[a-z]+:/, "").slice(0, 40) || "unknown"})`);
        // `device` is the asker the registry names: the registry spends the card for that same label (yes() names the asking device), and a card with no device was refused at the redeem as a wrong request.
        open.set(id, { id, op: sg.op, space, fields: sg.fields, payload_hash, from, device: from, at: now(), state: "waiting", moment: "outward", request, line });
        return { id, line };
      },
    });
    ctx.tool("approvals.pending", {
      description: "What is waiting for the person, as the phone shows it: [{ id, title, body, op, space, fields, payload_hash, asked_from, expires_in_s }]. Sign payload_hash and nothing else.",
      input: obj(),
      callers: SURFACES,
      run: async () => { sweep(); return { approvals: [...open.values()].filter(a => a.state === "waiting").map(a => (a.moment ? { ...card(a), moment: a.moment, request: a.request, line: a.line, sign: { op: a.op, space: a.space, fields: a.fields } } : card(a))) }; },
    });
    ctx.tool("approvals.answer", {
      description: "The person's answer: { id, approve: true } with the presence proof signed over the card's payload_hash beside the call (x-vyre-kernel-proof), or { id, approve: false }. A no ends it only from the person's own signed-in session. Nothing is checked here: the act verifies the proof.",
      input: obj({ id: { type: "string" }, approve: { type: "boolean" } }, ["id", "approve"]),
      callers: SURFACES,
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        sweep();
        const a = open.get(String(input.id));
        if (!a || a.state !== "waiting") throw refuse("there is nothing waiting for you with that id", "not_found");
        if (a.moment && a.from === String(meta.caller || "")) throw refuse("a device cannot answer its own card", "denied");
        if (input.approve !== true) {
          if (a.moment) {
            // a "no" holds the asker for ten minutes, so it counts only from the owner's own surface on the server (the terminal, the Capsule) or from a device with a session of a real key; a software browser's no is ignored
            let ok = !deviceOf(meta);
            if (!ok) { const sid = meta && meta.person && meta.person.id; const st = sid ? await ctx.call("presence.person.strength", { id: String(sid) }).catch(() => null) : null; ok = Boolean(st && st.data && st.data.strength === "real"); }
            if (!ok) return { answered: "ignored", why: "a no counts from your phone's own session or this server's own screen" };
            a.state = "refused"; refusedUntil.set(a.from, now() + 10 * 60_000); return { answered: "refused" };
          }
          if (!meta || !meta.person) return { answered: "ignored", why: "a no needs your signed-in session" };
          a.state = "refused"; return { answered: "refused" };
        }
        const given = ctx.kernel && typeof ctx.kernel.proofFrom === "function" ? ctx.kernel.proofFrom(meta) : null;
        const proof = given && given.presence ? given.presence : null; // proofFrom answers `{ presence }`, the option a kernel call takes
        if (!proof || typeof proof !== "object" || JSON.stringify(proof).length > MAX_PROOF) throw refuse("this needs your presence: approve it on your device", "needs_presence");
        if (proof.payload_hash !== a.payload_hash) throw refuse("that approval was not for this", "needs_presence");
        if (a.moment) {
          // the phone's yes is checked and spent HERE (yes() through the kernel's verifier); the asker never receives the proof
          /** @type {any} */ let chain; try { chain = ctx.kernel && typeof ctx.kernel.chain === "function" ? await ctx.kernel.chain(meta) : undefined; } catch { chain = undefined; }
          const v = await yes(a.moment, { ...(chain ? { chain } : {}), op: a.request.op, fields: a.request.fields }, proof);
          if (!v.ok) throw refuse(v.reason === "software_key" ? "approve this with the key in your phone: a software key cannot say yes here" : "that yes did not stand", v.reason);
          a.state = "approved"; a.verified = true; a.at = now();
          return { answered: "approved" };
        }
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
        if (a.moment) return a.state === "approved" ? { state: "approved", approval: a.id } : { state: "refused" };
        open.delete(a.id);
        return a.state === "approved" ? { state: "approved", proof: a.proof } : { state: "refused" };
      },
    });

    return { async stop() { open.clear(); } };
  },
};
