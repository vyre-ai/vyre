// @ts-check
// The step runner for scripts/proof-install.mjs: one line per step, PASS or FAIL with the reason, and a log file per run.
// A step that throws an error with `skip: true` is SKIPped with its message (a thing this walk cannot do, said plainly), not failed.
// A step names what it needs; when a needed step failed it prints SKIP and says which one, so a red run points at the first break and not at its echoes.
import fs from "node:fs";
import path from "node:path";

/** @param {{ out: string, say?: (line: string) => void }} o */
export function createRun(o) {
  fs.mkdirSync(o.out, { recursive: true });
  const say = o.say || (l => process.stdout.write(l + "\n"));
  const logFile = path.join(o.out, "proof.log");
  /** @type {{ name: string, ok: boolean | null, why: string, ms: number }[]} */
  const results = [];
  /** @type {Map<string, boolean>} */
  const done = new Map();
  const log = (/** @type {string} */ line) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* the log is a courtesy */ } };
  /**
   * @param {string} name @param {() => Promise<any> | any} fn @param {{ needs?: string[] }} [opt]
   * @returns {Promise<boolean>}
   */
  async function step(name, fn, opt = {}) {
    const broken = (opt.needs || []).find(n => done.get(n) !== true);
    if (broken) {
      const line = `SKIP  ${name}: needs "${broken}"`;
      say(line); log(line); results.push({ name, ok: null, why: `needs ${broken}`, ms: 0 }); done.set(name, false);
      return false;
    }
    const t0 = Date.now();
    try {
      const r = await fn();
      const note = typeof r === "string" && r ? `: ${r}` : "";
      const line = `PASS  ${name}${note}`;
      say(line); log(line); results.push({ name, ok: true, why: typeof r === "string" ? r : "", ms: Date.now() - t0 }); done.set(name, true);
      return true;
    } catch (e) {
      if (/** @type {any} */ (e) && /** @type {any} */ (e).skip) {
        const line = `SKIP  ${name}: ${/** @type {Error} */ (e).message}`;
        say(line); log(line); results.push({ name, ok: null, why: /** @type {Error} */ (e).message, ms: Date.now() - t0 }); done.set(name, false);
        return false;
      }
      const why = String(/** @type {any} */ (e) && /** @type {any} */ (e).message || e).replace(/\s+/g, " ").slice(0, 400);
      const code = /** @type {any} */ (e) && /** @type {any} */ (e).code ? ` [${/** @type {any} */ (e).code}]` : "";
      const line = `FAIL  ${name}: ${why}${code}`;
      say(line); log(line); if (/** @type {any} */ (e) && /** @type {any} */ (e).stack) log(String(/** @type {any} */ (e).stack));
      results.push({ name, ok: false, why: why + code, ms: Date.now() - t0 }); done.set(name, false);
      return false;
    }
  }
  function finish() {
    const pass = results.filter(r => r.ok === true).length, fail = results.filter(r => r.ok === false).length, skip = results.filter(r => r.ok === null).length;
    const line = `${fail ? "FAIL" : "PASS"}  ${pass} passed, ${fail} failed, ${skip} skipped`;
    say(line); log(line);
    fs.writeFileSync(path.join(o.out, "results.json"), JSON.stringify({ pass, fail, skip, results }, null, 2));
    return fail ? 1 : 0;
  }
  return { step, finish, log, results };
}
