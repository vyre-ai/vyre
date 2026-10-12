// @ts-check
// A journey part that is a real-daemon test file (the pattern of test/gif-story.test.js: a daemon, one card, the real sink): run it with node --test and report each of its cases as a journey
// step, so the journeys catch what the file catches and a FAIL names the owner. The file is the owner's; the journey only walks it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * @param {ReturnType<typeof import("./journey.mjs").stepper>} J @param {string} file repo-relative test file @param {string} owner
 * @param {{ env?: Record<string, string>, timeoutMs?: number, label?: string }} [o]
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

/**
 * The environment a test file is spawned with: this process's, WITHOUT what a journeys world sets on it (scripts/lib/proof/server-daemon.mjs puts VYRE_HOME, VYRE_STORE and the setup code on the runner's own
 * process and takes them off only when that world stops). A test file builds its own daemon in its own home; with the world's VYRE_STORE=auto it would run on a real Twenty that is still defining its types
 * (3 s a call), and with the world's VYRE_HOME next to the world's. A file that wants a store asks for it in `o.env`.
 */
export function journeyEnv() {
  const env = { ...process.env };
  for (const k of ["VYRE_HOME", "VYRE_STORE", "VYRE_SETUP_CODE", "VYRE_SETUP_CODE_AT"]) delete env[k];
  return env;
}

export function walkTestFile(J, file, owner, o = {}) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(REPO, file)], {
    cwd: REPO, encoding: "utf8", timeout: o.timeoutMs ?? 10 * 60_000, maxBuffer: 64 << 20, env: { ...journeyEnv(), VYRE_NO_DIALOGS: "1", ...(o.env || {}) },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  /** @type {{ ok: boolean, name: string, why: string }[]} */ const cases = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(not ok|ok) \d+ - (.*?)(?: # (SKIP|skip|TODO).*)?$/.exec(lines[i]);
    if (!m) continue;
    let why = "";
    if (m[1] === "not ok") why = whyOf(lines, i + 1);
    cases.push({ ok: m[1] === "ok", name: m[2] + (o.label ? ` (${o.label})` : ""), why });
  }
  // A case that is the file itself ("not ok 3 - /path/x.test.js ... test failed") means the process ended badly after its cases (an uncaught error, an exit): what it printed last is the only reason there is.
  const long = out.split("\n").filter(l => l.trim() && !/^(ok|not ok) \d+ - |^\s+(duration_ms|type|location|failureType|exitCode|signal|code|name):|^\s+---$|^\s+\.\.\.$/.test(l)).slice(-14).join(" | ").slice(0, 1500);
  return { cases, status: r.status, tail: out.split("\n").filter(Boolean).slice(-6).join(" | ").slice(0, 400), file, owner,
    /** one journey step per case of the file */
    async report() {
      if (!cases.length) await J.step(`${file} ran`, () => { throw new Error(`the test file reported no cases (exit ${r.status}): ${this.tail}`); }, { owner });
      for (const c of cases) await J.step(c.name, () => { if (!c.ok) throw new Error(/\.m?js$/.test(c.name) ? `${c.why} (the process ended badly after its cases; exit ${r.status}; its last output: ${long})` : c.why || `the case failed and the test file gave no reason; the end of its output: ${this.tail}`); return file; }, { owner });
    },
  };
}
