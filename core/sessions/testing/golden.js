// @ts-check
// The recorded model of the switch eval (core/sessions/switch-eval.test.js). Both fake agents use it when FAKE_GOLDEN_FILE is set.
//
// A fake agent here has no model: it keeps everything it was sent in a file of its own per native session (what that session's context would hold), and answers a question
// of the golden file with the recorded answer only when the question's evidence is in that context. Every other message is "noted". So a question is answered correctly
// exactly when what was said earlier reached this session, which is what a switch has to guarantee.
import fs from "node:fs";
import path from "node:path";

/** @param {string} file @returns {{ questions: { ask: string, answer: string, needle: string }[] }} */
const load = file => JSON.parse(fs.readFileSync(file, "utf8"));

/**
 * What the agent says to `text` in `session`, after taking it into that session's context.
 * @param {string} session the agent's native session id @param {string} text everything the turn carried: any Vyre block, then the person's words
 */
export function reply(session, text) {
  const file = String(process.env.FAKE_GOLDEN_FILE);
  const dir = String(process.env.FAKE_GOLDEN_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const mem = path.join(dir, `${session.replace(/[^A-Za-z0-9-]/g, "_")}.txt`);
  fs.appendFileSync(mem, text + "\n");
  const q = load(file).questions.find(x => text.trim().endsWith(x.ask));
  const out = q ? (fs.readFileSync(mem, "utf8").includes(q.needle) ? q.answer : "I do not know.") : "noted";
  fs.appendFileSync(mem, `assistant: ${out}\n`);
  return out;
}
