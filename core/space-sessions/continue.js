// core/space-sessions/continue.js: "Continue in another space". A NEW session starts in the target Space from a summary. The summary is
// written by a model through the door, stripped of sealed values (the door's sanitize) and of facts that belong only to the source Space,
// then shown to a person as a continue_in_space task. Only a summary a checker approved, byte for byte, becomes the new session's first
// context. The old session is read and never changed.
import { sha256, canonical } from "../../kernel/core/canonical.js";

const MAX_SUMMARY = 6000;

/**
 * @param {{ summarize(q: { chain: any, session: any, transcript: string }): Promise<string>,
 *   sanitize(q: { chain: any, session: string, text: string }): Promise<string>,
 *   sourceOnly(q: { chain: any, session: any }): Promise<string[]> | string[],
 *   ask: { request(chain: any, spec: any): Promise<any>, get(chain: any, id: string): Promise<any>, approved(id: string, payload_hash: string): boolean },
 *   readSession(chain: any, id: string): Promise<any>, readTranscript(chain: any, id: string): Promise<string>,
 *   startSession(chain: any, targetSpace: string, first: { context: string, from: { space: string, session: string } }): Promise<any>,
 *   authorize(i: { chain: any, action: string, resource: string }): Promise<{ effect: string }>,
 *   pending?: Map<string, any> }} p
 */
export function createContinue(p) {
  const pending = p.pending || new Map();
  const strip = (/** @type {string} */ text, /** @type {string[]} */ facts) => { let t = text; for (const f of facts) if (f && f.length > 2) t = t.split(f).join("[left out: belongs to the other space]"); return t; };

  return Object.freeze({
    /** Build the summary and raise the task for a person. Nothing leaves the source Space yet. @param {{ chain: any, session: string, target_space: string, person: any, checker?: any }} q */
    async propose(q) {
      const s = await p.readSession(q.chain, q.session);
      if (!s || s.space !== q.chain.space) throw Object.assign(new Error("no such session"), { code: "not_found" });
      if (s.space === q.target_space) throw Object.assign(new Error("that is the same space"), { code: "bad_input" });
      const a = await p.authorize({ chain: q.chain, action: "sessions.continue", resource: `vyre://${s.space}/session/${s.id}` });
      if (a.effect !== "allow") throw Object.assign(new Error("not allowed"), { code: "not_found" });
      const raw = await p.summarize({ chain: q.chain, session: s, transcript: await p.readTranscript(q.chain, s.id) });
      const stripped = strip(raw, await p.sourceOnly({ chain: q.chain, session: s }));
      const clean = (await p.sanitize({ chain: q.chain, session: s.id, text: stripped })).slice(0, MAX_SUMMARY);
      const hash = sha256(canonical({ summary: clean, to: q.target_space, from: s.id }));
      const task = await p.ask.request(q.chain, {
        title: "Continue this work in another space", source: "continue_in_space", doer: q.person, checker: q.checker || q.person,
        record: `vyre://${s.space}/session/${s.id}`, output: { kind: "decision", target: q.target_space }, note: clean.slice(0, 400),
      });
      pending.set(task.id, { summary: clean, hash, target: q.target_space, from: { space: s.space, session: s.id } });
      return { task: task.id, summary: clean, hash };
    },
    /** Deliver an approved summary as the first context of a new session. The text the checker saw is the text delivered. @param {{ chain: any, task: string }} q */
    async deliver(q) {
      const d = pending.get(q.task);
      if (!d) throw Object.assign(new Error("no such continuation"), { code: "not_found" });
      const t = await p.ask.get(q.chain, q.task);
      if (!t || t.state !== "done" || t.outcome !== "approved" || !p.ask.approved(q.task, d.hash)) throw Object.assign(new Error("a person has not approved this summary"), { code: "not_approved" });
      pending.delete(q.task);
      return p.startSession(q.chain, d.target, { context: d.summary, from: d.from });
    },
    /** Change the text before approval: a new hash, so an earlier approval does not carry over. @param {{ task: string, summary: string }} q */
    async edit(q) {
      const d = pending.get(q.task); if (!d) throw Object.assign(new Error("no such continuation"), { code: "not_found" });
      const summary = (await p.sanitize({ chain: null, session: d.from.session, text: String(q.summary) })).slice(0, MAX_SUMMARY);
      d.summary = summary; d.hash = sha256(canonical({ summary, to: d.target, from: d.from.session }));
      return { hash: d.hash };
    },
  });
}
