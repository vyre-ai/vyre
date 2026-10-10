// @ts-check
// approvals: "approve on your phone" for any act that needs a presence proof the asking session cannot give (the web app's software key). The act is a kernel act a person signs (a grant or a task decision):
// its op and fields are what the kernel's one verifier checks (kernel/remote/proof.js proofRequest builds them). The asker opens a request with them, the paired phone lists it, shows what will
// happen and signs the payload hash with Face ID, and the asker reads the proof back ONCE and attaches it to its own act (`kernel_proof`), where the kernel verifies it (counter-bound, single use).
// This module decides nothing and checks no signature: a wrong or replayed proof is refused by the act itself. The same shape as the rollback route (core/modulelist), for any op.
import { newId } from "../../lib/id.js";
import { payloadHash } from "../../kernel/seal/wire.js";
import { proofRequest, PROOF_CALLS } from "../../kernel/remote/proof.js";
import { yes, signOf, setCardRedeemer, opFitsMoment, lineOfOp, REUSE_OPS } from "../../lib/one-yes.js";
import { yesDeviceOf } from "../../lib/caller.js";
import { holdFields, viewOf, pageOf, editedInput } from "../../lib/hold-fields.js";
import { createItems } from "./items.js";
import { clean } from "../../lib/waiting-text.js";

const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const SURFACES = ["cli", "local", "deck", "capsule", "mobile", "device"];
const ASK_MS = 5 * 60_000, MAX_OPEN = 5, MAX_PROOF = 4096;
/** Cards the same asker holds within this long of each other are one group (one list, one yes); a group has at most MAX_GROUP cards. */
const GROUP_MS = 90_000, MAX_GROUP = 20;
/** How long after the registry redeemed a card the Gate may still use it for the send it covers. */
const CARD_LIFE_MS = 2 * 60_000;
/** Plain words for what each op does; an op not here is shown by its name. */
const WORDS = { "grant.invite": "Invite someone to this space", "grant.role": "Change who is in this space and what they may do", "grant.create": "Give access", "grant.revoke": "Take access away", "grant.narrow": "Narrow an access", "grant.offer": "Offer something to the space", "task.decide": "Approve or reject a task" };
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: false });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(base) {
    // Any change to a card this queue holds says so on approvals.changed (items.touch), whichever tool made it.
    /** @type {ReturnType<typeof createItems> | null} */ let items = null;
    const ctx = Object.assign(Object.create(base), { tool: (/** @type {string} */ name, /** @type {any} */ def) => base.tool(name, name === "approvals.items" || !def || typeof def.run !== "function" ? def
      : { ...def, run: async (/** @type {any} */ i, /** @type {any} */ m) => { try { return await def.run(i, m); } finally { if (items) items.touch(); } } }) });
    const now = typeof ctx.now === "function" ? ctx.now : Date.now;
    /** @type {Map<string, { id: string, op: string, space: string, fields: any, payload_hash: string, from: string, at: number, state: "waiting" | "approved" | "refused", proof?: any, reuse?: boolean, moment?: string, request?: any, line?: string, verified?: boolean, used?: boolean, redeemedAt?: number, covered?: boolean, group?: string, input?: any, edited?: boolean, seenAll?: boolean }>} */
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
    /** Cards the registry redeemed for a call: the Gate may use each ONCE, within CARD_LIFE_MS, for the call it was redeemed for (approvals.cover). */
    const unredeem = setCardRedeemer((id, moment, request, device) => {
      const a = open.get(id);
      if (!a || !a.moment || a.state !== "approved" || !a.verified || now() - a.at > ASK_MS * 2) return "no_proof";
      if (a.used) return "replayed";
      if (a.moment !== moment || a.request.op !== request.op || canon(a.request.fields) !== canon(request.fields && typeof request.fields === "object" ? request.fields : {}) || (device && device !== a.device)) return "wrong_request";
      a.used = true; a.redeemedAt = now();
      return a.reuse === true ? "ok_reuse" : "ok";
    });
    // ---- a group of held calls: one list, one yes, each item its own exact words and its own proof ---------------------------------------------------
    /** Groups the person has begun to answer: a card held after that starts a group of its own, so an answered group never grows. @type {Set<string>} */
    const closed = new Set();
    /** The group a new card from this asker belongs to: the one it is already holding cards in, if the newest of them is recent and there is room; else a new one. @param {string} from */
    const groupFor = from => {
      /** @type {Map<string, { n: number, at: number }>} */ const mine = new Map();
      for (const a of open.values()) if (a.moment === "outward" && a.from === from && a.group && a.state === "waiting" && !closed.has(a.group)) { const g = mine.get(a.group) || { n: 0, at: 0 }; g.n++; g.at = Math.max(g.at, a.at); mine.set(a.group, g); }
      for (const [id, g] of mine) if (g.n < MAX_GROUP && now() - g.at <= GROUP_MS) return id;
      return `gp_${newId()}`;
    };
    /** What a group says about itself, from its waiting cards: how many, and what each is. @param {string} group */
    const groupLine = group => {
      const items = [...open.values()].filter(a => a.group === group && a.state === "waiting");
      const asker = items.length ? items[0].from.replace(/^[a-z]+:/, "").slice(0, 40) : "";
      const ops = [...new Set(items.map(a => a.request.op))];
      return `${asker ? `An assistant (${asker})` : "An assistant"} wants to run ${items.length} calls${ops.length === 1 ? ` of ${ops[0]}` : ""}: ${items.map(a => String(a.request.fields.to || a.request.fields.name || a.request.fields.subject || a.request.op).slice(0, 40)).join(", ")}`;
    };

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
      input: obj({ op: { type: "string" }, space: { type: "string" }, fields: { type: "object" }, moment: { type: "string", enum: ["pair", "vault", "outward"] }, request: { type: "object" }, reuse: { type: "boolean" } }, []),
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
          // a reveal, a copy or a code may ask to be reused for five minutes by the same device: the card says so, so the person's yes is to that
          const reuse = input.reuse === true && REUSE_OPS.includes(request.op);
          const line = lineOfOp(request.op, request.fields, who) + (reuse ? " (and again for 5 minutes)" : "");
          // a person's own surface on this machine (the terminal, the Capsule, the Deck) asks as `local:<surface>`, and confirms on this computer (approvals.local-yes); a paired device asks as itself
          open.set(id, { id, op: sg.op, space, fields: sg.fields, payload_hash, from, device: device || yesDeviceOf(from), at: now(), state: "waiting", moment, request, line, ...(reuse ? { reuse: true } : {}) });
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
      input: obj({ tool: { type: "string" }, fields: { type: "object" }, from: { type: "string" }, input: { type: "object" } }, ["tool", "fields", "from"]),
      callers: ["module"],
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        if (String((meta && meta.caller) || "") !== "module:registry") throw refuse("only the registry holds a call", "denied");
        sweep();
        const request = cardRequest("outward", { op: input.tool, fields: input.fields });
        if (!request) throw refuse("that call does not fit an outward card", "bad_input");
        const from = String(input.from || "");
        const same = [...open.values()].find(a => a.moment && a.from === from && a.state === "waiting" && a.request.op === request.op && canon(a.request.fields) === canon(request.fields));
        if (same) return { id: same.id, line: same.line, ...(same.group ? { group: same.group } : {}) };
        if ([...open.values()].filter(a => a.state === "waiting").length >= MAX_OPEN) throw refuse("too many approvals are waiting: answer or wait for them to end", "rate_limited");
        const sg = signOf("outward", request), space = String((ctx.kernel && ctx.kernel.space) || "");
        const payload_hash = payloadHash(sg.op, space, sg.fields);
        const id = `ap_${newId()}`;
        const line = lineOfOp(request.op, request.fields, `An assistant (${(from.split(":").pop() || "").slice(0, 40) || "unknown"})`);
        // The call's own input (the registry's, the asker's words never reach it any other way) lets the person read every word and change some of them. It is held only if it is what the card's digest covers.
        const held = input.input && typeof input.input === "object" && !Array.isArray(input.input) && holdFields(input.input).input_sha256 === request.fields.input_sha256 ? input.input : null;
        const group = groupFor(from);
        open.set(id, { id, op: sg.op, space, fields: sg.fields, payload_hash, from, device: from, at: now(), state: "waiting", moment: "outward", request, line, short: lineOfOp(request.op, {}, `An assistant (${(from.split(":").pop() || "").slice(0, 40) || "unknown"})`), group, ...(held ? { input: held } : {}) });
        return { id, line, group };
      },
    });
    ctx.tool("approvals.local-yes", {
      description: "Give the yes for a card you asked for yourself, here: Touch ID on a Mac, or the code Vyre writes to your own terminal. { id } starts it and answers { answered: \"approved\" }, or { need: \"code\", challenge } when a code was written to `tty` (give it back as { id, challenge, code }). Only the surface that asked can confirm its own card, and only on this computer; a server with no screen of its own asks your phone instead.",
      input: obj({ id: { type: "string" }, tty: { type: "string" }, challenge: { type: "string" }, code: { type: "string" } }, ["id"]),
      callers: ["cli", "local", "capsule", "deck"],
      presence: { summary: async () => "Confirm a yes on this computer" },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        sweep();
        const a = open.get(String(input.id));
        if (!a || a.state !== "waiting" || !a.moment) throw refuse("there is nothing waiting for you with that id", "not_found");
        if (a.from !== String((meta && meta.caller) || "") || !String(a.device || "").startsWith("local:")) throw refuse("only the surface that asked can confirm its own card here", "denied");
        const r = await ctx.call("presence.confirm", { summary: a.line || a.request.op, tool: a.request.op, input: a.request.fields, ...(input.tty ? { tty: String(input.tty) } : {}), ...(input.challenge ? { challenge: String(input.challenge), code: String(input.code || "") } : {}) });
        if (r.error) throw refuse(String(r.error.message || r.error.code), r.error.code === "no_dialog" ? "no_dialog" : "presence_required");
        if (r.data && r.data.need) return { need: r.data.need, challenge: r.data.challenge };
        a.state = "approved"; a.verified = true; a.at = now();
        return { answered: "approved" };
      },
    });
    ctx.tool("approvals.pending", {
      description: "What is waiting for the person, as the phone shows it: [{ id, title, body, op, space, fields, payload_hash, asked_from, expires_in_s }]. Sign payload_hash and nothing else.",
      input: obj(),
      callers: SURFACES,
      run: async () => {
        sweep();
        const waiting = [...open.values()].filter(a => a.state === "waiting");
        const groups = [...new Set(waiting.filter(a => a.group).map(a => /** @type {string} */ (a.group)))].map(g => ({ id: g, size: waiting.filter(a => a.group === g).length, line: groupLine(g) }));
        return { approvals: waiting.map(a => (a.moment ? { ...card(a), moment: a.moment, request: a.request, line: a.line, sign: { op: a.op, space: a.space, fields: a.fields }, ...(a.group ? { group: a.group } : {}), ...(a.input ? (() => { const v = viewOf(a.input); return { words: v.words, edited: Boolean(a.edited), ...(v.partial ? { partial: true, note: "Part of this is not shown. Open it on its own to see all of it." } : {}) }; })() : {}) } : card(a))), ...(groups.length ? { groups } : {}) };
      },
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
        // A call whose card says part of it is not shown is approved only after the person has read all of it (approvals.item-view, to the end).
        if (a.moment === "outward" && a.input && viewOf(a.input).partial && !a.seenAll) throw refuse("part of this call is not shown on the card: read all of it first (approvals.item-view), then approve", "needs_view");
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
    // ---- one yes for a group ---------------------------------------------------------------------------------------------------------------------------
    // The person reads every item's own words, drops or edits any, and says yes once on the phone: the phone signs each item it approves over THAT item's own payload hash, in one unlock. Nothing here is
    // stretched across items: an item is approved only by a proof over its own exact request that the one verifier accepts (yes(), spent as it is used), an item with no decision stays waiting, and a card
    // held after the group was answered is in a group of its own, so a yes can never reach it.
    /** May this caller say no, edit or drop? The same rule as a single card's no: the owner's own surface on the server, or a device with a session of a real key (a software browser's word is ignored). @param {any} meta */
    const mayDecline = async meta => {
      if (!deviceOf(meta)) return true;
      const sid = meta && meta.person && meta.person.id;
      const st = sid ? await ctx.call("presence.person.strength", { id: String(sid) }).catch(() => null) : null;
      return Boolean(st && st.data && st.data.strength === "real");
    };
    ctx.tool("approvals.answer-group", {
      description: "The person's answer to a group of held calls in one step: { group, decisions: [{ id, approve }], proofs: { <id>: <proof> } }. An approve needs the proof signed over that card's own payload_hash; approve false drops the item (it is not held against the asker). An item with no decision is still waiting. Answers one result per decision.",
      input: obj({ group: { type: "string" }, decisions: { type: "array", items: obj({ id: { type: "string" }, approve: { type: "boolean" } }, ["id", "approve"]) }, proofs: { type: "object" } }, ["group", "decisions"]),
      callers: SURFACES,
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        sweep();
        const group = String(input.group || "");
        const decisions = Array.isArray(input.decisions) ? input.decisions : [];
        if (!decisions.length || decisions.length > MAX_GROUP) throw refuse(`answer between 1 and ${MAX_GROUP} items`, "bad_input");
        const seen = new Set();
        for (const d of decisions) {
          const a = open.get(String(d && d.id));
          if (!a || a.group !== group || a.moment !== "outward") throw refuse("an item is not in this group", "bad_input");
          if (seen.has(a.id)) throw refuse("an item is answered twice", "bad_input");
          seen.add(a.id);
          if (a.from === String((meta && meta.caller) || "")) throw refuse("a device cannot answer its own card", "denied");
        }
        const proofs = input.proofs && typeof input.proofs === "object" && !Array.isArray(input.proofs) ? input.proofs : {};
        if (JSON.stringify(proofs).length > MAX_PROOF * MAX_GROUP) throw refuse("the proofs are too large", "bad_input");
        closed.add(group);
        /** @type {{ id: string, answered: string, why?: string }[]} */ const results = [];
        /** @type {any} */ let chain; try { chain = ctx.kernel && typeof ctx.kernel.chain === "function" ? await ctx.kernel.chain(meta) : undefined; } catch { chain = undefined; }
        for (const d of decisions) {
          const a = /** @type {any} */ (open.get(String(d.id)));
          if (a.state !== "waiting") { results.push({ id: a.id, answered: "ignored", why: "this item is no longer waiting" }); continue; }
          if (d.approve !== true) {
            if (!(await mayDecline(meta))) { results.push({ id: a.id, answered: "ignored", why: "a drop counts from your phone's own session or this server's own screen" }); continue; }
            a.state = "refused"; results.push({ id: a.id, answered: "dropped" }); continue;
          }
          // Part of this call is not shown to the person (see viewOf), so one yes over a list cannot cover it: it is approved on its own, with its whole content in view.
          if (!a.input || viewOf(a.input).partial) { results.push({ id: a.id, answered: "waiting", why: "part of this call is not shown here, so it cannot be approved with the others: open it on its own" }); continue; }
          const proof = proofs[a.id];
          if (!proof || typeof proof !== "object" || Array.isArray(proof) || JSON.stringify(proof).length > MAX_PROOF) { results.push({ id: a.id, answered: "waiting", why: "this item needs its own proof" }); continue; }
          if (proof.payload_hash !== a.payload_hash) { results.push({ id: a.id, answered: "waiting", why: "that proof was not for this item" }); continue; }
          const v = await yes(a.moment, { ...(chain ? { chain } : {}), op: a.request.op, fields: a.request.fields }, proof);
          if (!v.ok) { results.push({ id: a.id, answered: "waiting", why: v.reason === "software_key" ? "approve this with the key in your phone: a software key cannot say yes here" : `that yes did not stand (${v.reason})` }); continue; }
          a.state = "approved"; a.verified = true; a.at = now();
          results.push({ id: a.id, answered: "approved" });
        }
        return { group, results };
      },
    });
    ctx.tool("approvals.item-view", {
      description: "The whole of one held call, nothing cut, in pages: { id, offset? } answers { words: [{ field, text, part? }], total, offset, next }. About 50 values or 8000 characters a page; next is the offset to ask for, null at the end. A call whose card says part of it is not shown must be read to the end before it can be approved.",
      input: obj({ id: { type: "string" }, offset: { type: "integer" } }, ["id"]),
      callers: SURFACES,
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        sweep();
        const a = open.get(String(input.id));
        if (!a || a.state !== "waiting" || a.moment !== "outward" || !a.input) throw refuse("there is nothing waiting for you with that id", "not_found");
        if (a.from === String((meta && meta.caller) || "")) throw refuse("a device cannot read its own card", "denied");
        const v = pageOf(a.input, Number(input.offset) || 0);
        if (v.next === null) a.seenAll = true;
        return v;
      },
    });
    ctx.tool("approvals.edit-item", {
      description: "The person changes some of the words of one held call before saying yes: { id, edits: { <text field>: <new text> } }. The card is made again over the changed call (a new payload_hash to sign), and when the asker retries it, the call that runs is the edited one. Only text fields the call already has; only from the person's own surface, never the asker's.",
      input: obj({ id: { type: "string" }, edits: { type: "object" } }, ["id", "edits"]),
      callers: SURFACES,
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        sweep();
        const a = open.get(String(input.id));
        if (!a || a.state !== "waiting" || a.moment !== "outward" || !a.input) throw refuse("there is nothing waiting for you with that id that can be edited", "not_found");
        if (a.from === String((meta && meta.caller) || "")) throw refuse("a device cannot edit its own card", "denied");
        if (!(await mayDecline(meta))) throw refuse("editing counts from your phone's own session or this server's own screen", "denied");
        let next;
        try { next = editedInput(a.input, input.edits); } catch (e) { throw refuse(String(/** @type {Error} */ (e).message), "bad_input"); }
        const request = cardRequest("outward", { op: a.request.op, fields: holdFields(next) });
        if (!request) throw refuse("that call does not fit an outward card once edited", "bad_input");
        const sg = signOf("outward", request);
        a.input = next; a.request = request; a.op = sg.op; a.fields = sg.fields; a.payload_hash = payloadHash(sg.op, a.space, sg.fields); a.edited = true; a.seenAll = false; a.at = now();
        a.line = lineOfOp(request.op, request.fields, a.line.split(" wants to ")[0]);
        { const v = viewOf(next); return { id: a.id, payload_hash: a.payload_hash, words: v.words, ...(v.partial ? { partial: true } : {}), line: a.line }; }
      },
    });
    ctx.tool("approvals.cover", {
      internal: true,
      description: "The Gate's own: was this card redeemed, just now, for exactly this tool, input and asker, and not yet used by the Gate? { ok: true } and it is used up, else { ok: false }.",
      input: obj({ card: { type: "string" }, tool: { type: "string" }, input_sha256: { type: "string" }, asker: { type: "string" } }, ["card", "tool", "input_sha256", "asker"]),
      callers: ["module"],
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        if (String((meta && meta.caller) || "") !== "module:gate") throw refuse("only the Gate asks this", "denied");
        const a = open.get(String(input.card));
        const ok = Boolean(a && a.moment === "outward" && a.used === true && a.covered !== true && typeof a.redeemedAt === "number" && now() - a.redeemedAt <= CARD_LIFE_MS
          && a.request.op === String(input.tool) && a.request.fields.input_sha256 === String(input.input_sha256) && a.from === String(input.asker));
        if (ok && a) a.covered = true;
        return { ok };
      },
    });
    ctx.tool("approvals.receipt", {
      internal: true,
      description: "The registry's own: a Flow's approved act or a person's confirmed preview is kept like a redeemed card so the Gate can use it once for the send the act files. { card, tool, input_sha256, asker }.",
      input: obj({ card: { type: "string" }, tool: { type: "string" }, input_sha256: { type: "string" }, asker: { type: "string" } }, ["card", "tool", "input_sha256", "asker"]),
      callers: ["module"],
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        if (String((meta && meta.caller) || "") !== "module:registry") throw refuse("only the registry records an approved act", "denied");
        const id = String(input.card);
        if (!/^(flowtask:[A-Za-z0-9_-]{6,80}|viewask:[A-Za-z0-9_-]{8,128})$/.test(id)) throw refuse("that is not a Flow task's or a confirmed preview's receipt", "bad_input");
        sweep();
        if (open.has(id)) throw refuse("that approval was already recorded", "replayed");
        open.set(id, { id, op: String(input.tool), space: "", fields: {}, payload_hash: "", from: String(input.asker), at: now(), state: "approved", moment: "outward", request: { op: String(input.tool), fields: { input_sha256: String(input.input_sha256) } }, verified: true, used: true, redeemedAt: now() });
        return { ok: true };
      },
    });
    ctx.tool("approvals.card-input", {
      internal: true,
      description: "The registry's own: the call an approved card now covers, when the person edited it. Answers { input } for an edited card the asker holds, else nothing.",
      input: obj({ id: { type: "string" }, tool: { type: "string" }, from: { type: "string" } }, ["id", "tool", "from"]),
      callers: ["module"],
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        if (String((meta && meta.caller) || "") !== "module:registry") throw refuse("only the registry reads a card's call", "denied");
        const a = open.get(String(input.id));
        if (!a || !a.edited || !a.input || a.moment !== "outward" || a.from !== String(input.from) || a.request.op !== String(input.tool) || a.state !== "approved" || !a.verified || a.used) return {};
        return { input: a.input };
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

    // ---- the other things that wait on the person: held drafts, session asks, the vault's pending requests (items.js) -------------------------------------
    /** A yes waiting on the phone, as a row of the waiting list. */
    const cardRow = (/** @type {any} */ a) => ({ id: a.id, kind: "approval", title: clean(a.short || a.line || WORDS[/** @type {keyof typeof WORDS} */ (a.op)] || a.op), at: a.at, source: "approvals",
      answer: { tool: "approvals.answer", input: { id: a.id }, fill: ["yes"] } });
    items = createItems({ call: (tool, input) => ctx.call(tool, input), on: (pattern, fn) => (ctx.events && typeof ctx.events.on === "function" ? ctx.events.on(pattern, fn) : () => {}), now, log: ctx.log, emit: (type, payload) => { if (ctx.events && typeof ctx.events.emit === "function") ctx.events.emit(type, payload); },
      extra: () => { sweep(); return [...open.values()].filter(a => a.state === "waiting").map(cardRow); } });
    ctx.tool("approvals.items", {
      description: "Everything else that waits on the person, as cards in this queue: the Gate's held drafts (draft), a session's asks (ask) and the vault's pending grants, passes and requests (access). Answers { items: [{ id, kind, title, detail?, project?, thread?, at, source, answer: { tool, input, fill } }], recent: [the same, settled, with outcome], partial? }. Each card names the owner's tool that settles it; the owner decides, and the card closes with what it decided. Titles never carry a value.",
      input: obj({}),
      effect: "read",
      callers: [...SURFACES, "module"],
      run: async () => /** @type {NonNullable<typeof items>} */ (items).list(),
    });
    items.start();

    return { async stop() { unredeem(); open.clear(); if (items) await items.stop(); } };
  },
};
