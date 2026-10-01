// The matrix's results: every step appends one line to <out>/results.jsonl, and report.mjs folds
// every device's file into one results.json and the results page. The shape is the contract the
// integrator's release gate and app-design's gallery read (plan section 3.3):
//   { journey, device, step, ok: true | false | "by-hand" | "skip" | "fake", ms, shot, why, log }
import fs from "node:fs";
import path from "node:path";

/** Sample-world names (team RULES) that must never reach a product surface (charter 11). */
export const FIXTURE_NAMES = [/Harlow/, /Northwind/, /\b(alex|juno|kit)\b/];

/** The fixture names found in a page's text, if any. */
export function fixtureHits(text) {
  return FIXTURE_NAMES.map(re => (String(text).match(re) || [])[0]).filter(Boolean);
}

export function recorder(out, journey, device) {
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, "results.jsonl");
  let failed = 0;
  return {
    get failed() { return failed; },
    /** Save a screenshot under <journey>/<nn>-<step>/<device>.png; returns its relative path. */
    saveShot(step, n, png) {
      const rel = path.join(journey, `${String(n).padStart(2, "0")}-${step}`, `${device}.png`);
      fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
      fs.writeFileSync(path.join(out, rel), png);
      return rel;
    },
    step(step, ok, fields = {}) {
      if (ok === false) failed++;
      const line = { journey, device, step, ok, ...fields };
      fs.appendFileSync(file, JSON.stringify(line) + "\n");
      console.log(`${ok === true ? "pass" : ok === false ? "FAIL" : ok}  ${journey} ${device} ${step}${fields.why ? ": " + fields.why : ""}`);
    },
  };
}
