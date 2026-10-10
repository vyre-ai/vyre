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
    if (m[1] === "not ok") for (let k = i + 1; k < Math.min(i + 30, lines.length); k++) { const e = /^\s+error: (.*)$/.exec(lines[k]); if (e) { why = e[1].replace(/^['"|-]+/, "").slice(0, 300); break; } }
    cases.push({ ok: m[1] === "ok", name: m[2], why });
  }
  return { cases, status: r.status, tail: out.split("\n").filter(Boolean).slice(-6).join(" | ").slice(0, 400), file, owner,
    /** one journey step per case of the file */
    async report() {
      if (!cases.length) await J.step(`${file} ran`, () => { throw new Error(`the test file reported no cases (exit ${r.status}): ${this.tail}`); }, { owner });
      for (const c of cases) await J.step(c.name, () => { if (!c.ok) throw new Error(c.why || "the case failed"); return file; }, { owner });
    },
  };
}
