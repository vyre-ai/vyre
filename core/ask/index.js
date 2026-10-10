// @ts-check
// ask: one card for every question (R031-92). An agent (or a module such as Vyre Computer) that needs several things settled before it acts asks them all at once: `ask.many { questions }`. The person's
// own surface shows ONE card in the chat, each question with its choices and room to type or say their own; they answer once; the agent gets the answers. The final act (the send) is not this card's business:
// the agent then files it at the Gate as any send, and that is the person's one yes. Answers are not proofs and cover nothing; they only say what the person meant.
// Pending asks live in memory (a restart ends the wait: the agent asks again); the card is the chat's own frame (thread.questions).
import crypto from "node:crypto";
import { isPerson, PERSON_SURFACES } from "../../lib/caller.js";
import { cleanQuestions, checkAnswers, answerLines } from "./model.js";

const str = { type: "string" };
const obj = (/** @type {any} */ properties, required = []) => ({ type: "object", properties, required });
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const PERSON = [...PERSON_SURFACES, "tailnet", "device"];
const TTL_MS = 30 * 60_000, MAX_WAIT_MS = 55_000, MAX_OPEN = 20;

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const now = Date.now;
    /** @type {Map<string, { id: string, title: string, thread: string | null, questions: import("./model.js").Question[], state: "waiting"|"answered"|"cancelled"|"expired", answers: Record<string, any> | null, at: number, waiters: Set<() => void> }>} */
    const asks = new Map();
    const emit = (/** @type {string} */ type, /** @type {any} */ payload, /** @type {any} */ where) => { try { ctx.events.emit(type, payload, where); } catch { /* nobody hears */ } };
    const card = (/** @type {any} */ a) => { if (a.thread) emit("thread.questions", { id: a.id, title: a.title, state: a.state, questions: a.questions, ...(a.answers ? { answers: a.answers } : {}) }, { thread: a.thread }); };
    const view = (/** @type {any} */ a) => ({ id: a.id, title: a.title, state: a.state, questions: a.questions, ...(a.answers ? { answers: a.answers, lines: answerLines(a.questions, a.answers) } : {}) });
    const sweep = () => { for (const a of asks.values()) if (a.state === "waiting" && now() - a.at > TTL_MS) { a.state = "expired"; card(a); a.waiters.forEach(w => w()); } for (const [k, a] of asks) if (a.state !== "waiting" && now() - a.at > 2 * TTL_MS) asks.delete(k); };
    /** Wait for an ask to leave "waiting", at most `ms`. @param {any} a @param {number} ms */
    const settle = (a, ms) => new Promise(resolve => {
      if (a.state !== "waiting" || ms <= 0) return resolve(undefined);
      const done = () => { clearTimeout(t); a.waiters.delete(done); resolve(undefined); };
      const t = setTimeout(done, Math.min(ms, MAX_WAIT_MS));
      a.waiters.add(done);
    });

    ctx.tool("ask.many", {
      description: "Ask the person several things at once as ONE card: title and questions (prompt, choices, allowText). Returns answers, or an id to poll with ask.get.",
      input: obj({ title: str, questions: { type: "array" }, wait_ms: { type: "integer" }, thread: str }, ["questions"]),
      callers: [...PERSON, "module", "mcp", "harness", "agent"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        sweep();
        if ([...asks.values()].filter(a => a.state === "waiting").length >= MAX_OPEN) throw refuse("too many questions are waiting: answer or wait for them to end", "rate_limited");
        const questions = cleanQuestions(i.questions);
        const id = crypto.randomBytes(6).toString("hex");
        // The card lives in the chat the call is from: a person or module may name one, a model's own thread is the one the daemon vouched for.
        const human = isPerson(meta);
        const thread = (human || String(meta && meta.caller || "").startsWith("module:")) && i.thread ? String(i.thread) : (meta && meta.thread) || null;
        const a = { id, title: String(i.title || "A few questions").replace(/\s+/g, " ").trim().slice(0, 120), thread, questions, state: /** @type {"waiting"} */ ("waiting"), answers: null, at: now(), waiters: new Set() };
        asks.set(id, a);
        card(a);
        await settle(a, Number(i.wait_ms) || 0);
        return view(a);
      },
    });

    ctx.tool("ask.get", {
      description: "The state of a question card you asked: { id, state, answers, lines }. With wait_ms (at most 55 s) it waits for the answers.",
      input: obj({ id: str, wait_ms: { type: "integer" } }, ["id"]),
      callers: [...PERSON, "module", "mcp", "harness", "agent"],
      run: async (/** @type {any} */ i) => {
        sweep();
        const a = asks.get(String(i.id));
        if (!a) throw refuse("no such question card (it may have expired: ask.many makes a new one)", "not_found");
        await settle(a, Number(i.wait_ms) || 0);
        return view(a);
      },
    });

    ctx.tool("ask.answer", {
      description: "The person's answers to a question card: { id, answers: { <question id>: { choice } or { text } } }. Every question that is not optional needs one.",
      input: obj({ id: str, answers: { type: "object" } }, ["id", "answers"]), callers: PERSON,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!isPerson(meta)) throw refuse("only a person at their own surface answers", "denied");
        sweep();
        const a = asks.get(String(i.id));
        if (!a) throw refuse("no such question card (it may have expired: ask.many makes a new one)", "not_found");
        if (a.state !== "waiting") throw refuse(a.state === "answered" ? "this was already answered" : `this card is ${a.state}`, "conflict");
        const r = checkAnswers(a.questions, i.answers);
        if (!r.ok) throw refuse(r.error, "bad_input");
        a.answers = r.answers; a.state = "answered";
        card(a);
        emit("ask.answered-many", { id: a.id, thread: a.thread });
        a.waiters.forEach(w => w());
        return view(a);
      },
    });

    ctx.tool("ask.cancel", {
      description: "The person puts a question card away without answering: the agent is told it was cancelled.", input: obj({ id: str }, ["id"]), callers: PERSON,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!isPerson(meta)) throw refuse("only a person at their own surface does this", "denied");
        const a = asks.get(String(i.id));
        if (!a) throw refuse("no such question card (it may have expired: ask.many makes a new one)", "not_found");
        if (a.state === "waiting") { a.state = "cancelled"; card(a); a.waiters.forEach(w => w()); }
        return view(a);
      },
    });

    return { async stop() { for (const a of asks.values()) a.waiters.forEach(w => w()); asks.clear(); } };
  },
};
