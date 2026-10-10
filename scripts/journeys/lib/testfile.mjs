// @ts-check
// A journey part that is a real-daemon test file (the pattern of test/gif-story.test.js: a daemon, one card, the real sink): run it with node --test and report each of its cases as a journey
// step, so the journeys catch what the file catches and a FAIL names the owner. The file is the owner's; the journey only walks it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * @param {ReturnType<typeof import("./journey.mjs").stepper>} J @param {string} file repo-relative test file @param {string} owner
 * @param {{ env?: Record<string, string>, timeoutMs?: number }} [o]
 */
/**
 * The reason a case failed, from its TAP diagnostics: the `error:` value, which node writes either on the line or as a block (`error: |-` and the lines under it), the assertion's message and its
 * expected/actual when it has them, and the first stack frame. A reason that is only a pipe or empty used to read "the case failed"; now the case says what failed.
 * @param {string[]} lines @param {number} from
 */
export function whyOf(lines, from) {
  /** @type {string[]} */ const parts = [];
  let k = from;
  for (; k < Math.min(from + 80, lines.length); k++) {
    const l = lines[k];
    if (/^(not ok|ok) \d+ - /.test(l) || /^# /.test(l)) break;
    const e = /^(\s+)error: (.*)$/.exec(l);
    if (!e) continue;
    const head = e[2].replace(/^['"]/, "").replace(/['"]$/, "");
    if (/^[|>][-+]?$/.test(e[2].trim())) {
      const indent = e[1].length;
      for (let j = k + 1; j < lines.length; j++) { const t = lines[j]; if (t.trim() === "") { continue; } if (t.search(/\S/) <= indent) break; parts.push(t.trim()); if (parts.length >= 12) break; }
    } else parts.push(head);
    break;
  }
  const code = lines.slice(from, from + 80).find(l => /^\s+code: /.test(l));
  const text = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return (text + (code && !text.includes(code.trim()) ? ` (${code.trim()})` : "")).slice(0, 700);
}

export function walkTestFile(J, file, owner, o = {}) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(REPO, file)], {
    cwd: REPO, encoding: "utf8", timeout: o.timeoutMs ?? 10 * 60_000, maxBuffer: 64 << 20, env: { ...process.env, VYRE_NO_DIALOGS: "1", ...(o.env || {}) },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  /** @type {{ ok: boolean, name: string, why: string }[]} */ const cases = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(not ok|ok) \d+ - (.*?)(?: # (SKIP|skip|TODO).*)?$/.exec(lines[i]);
    if (!m) continue;
    let why = "";
    if (m[1] === "not ok") why = whyOf(lines, i + 1);
    cases.push({ ok: m[1] === "ok", name: m[2], why });
  }
  return { cases, status: r.status, tail: out.split("\n").filter(Boolean).slice(-6).join(" | ").slice(0, 400), file, owner,
    /** one journey step per case of the file */
    async report() {
      if (!cases.length) await J.step(`${file} ran`, () => { throw new Error(`the test file reported no cases (exit ${r.status}): ${this.tail}`); }, { owner });
      for (const c of cases) await J.step(c.name, () => { if (!c.ok) throw new Error(c.why || `the case failed and the test file gave no reason; the end of its output: ${this.tail}`); return file; }, { owner });
    },
  };
}
