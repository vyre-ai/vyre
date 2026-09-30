// The synthetic world for rc-smoke's memory step: writes the personal world's Claude Code
// transcripts (test/fixtures/personal-world.js, a made-up person) under <out>/projects and prints
// { me, known, none }: the config's `me`, a question it knows (with the words the answer must
// hold) and one it must not answer, both from test/eval/answer-gold.json.
import fs from "node:fs";
import path from "node:path";
import { writeTranscripts } from "../../test/fixtures/corpus.js";
import { PERSONAL_SESSIONS, ME } from "../../test/fixtures/personal-world.js";

const out = process.argv[2];
if (!out) { console.error("usage: world.mjs <folder>"); process.exit(2); }
writeTranscripts(path.join(out, "projects"), PERSONAL_SESSIONS);
const gold = JSON.parse(fs.readFileSync(new URL("../../test/eval/answer-gold.json", import.meta.url), "utf8"));
const known = gold.questions.find(q => Array.isArray(q.expect) && q.kind === "spouse");
const none = gold.questions.find(q => q.expect === null);
process.stdout.write(JSON.stringify({ me: ME, known, none }));
