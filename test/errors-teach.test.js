// @ts-check
// R031-00r errors that teach: every refusal says what to do next. A refusal written in the code as a literal message (refuse("...", "denied") and the like) must name a real tool, say who decides,
// or give an instruction; a dotted name in a message must be a tool that exists. bad_input is left out: its message names the field and what it must be.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hasNextStep, nextCall, refusalsIn } from "../lib/errors-teach.js";
import { sourceFiles, ROOT } from "./source-files.js";
import { broadCatalog } from "./tools-universe.js";

const TOOLS = new Set(broadCatalog().flatMap((c) => [c.tool]));
const SKIP_CODES = new Set(["bad_input", "invalid", "invalid_argument"]);
/** Code that a caller never reaches as a refusal: the kernel (a trusted base, reasons by code), the vendored and generated trees. */
const IN_SCOPE = /^(core|lib|harness|local|modules|records|stores)\//;

/** @returns {{ at: string, code: string, message: string }[]} */
function misses() {
  /** @type {{ at: string, code: string, message: string }[]} */ const out = [];
  for (const f of sourceFiles()) {
    if (!IN_SCOPE.test(f)) continue;
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const r of refusalsIn(text)) {
      if (SKIP_CODES.has(r.code) || r.message.replace(/x/g, "").trim().length < 4) continue;
      const line = text.slice(0, r.index).split("\n").length;
      if (!hasNextStep(r.message, TOOLS).ok) out.push({ at: `${f}:${line}`, code: r.code, message: r.message });
    }
  }
  return out;
}

test("PROBE: how many refusals have no next step", () => {
  const m = misses();
  console.log(`refusals without a next step: ${m.length}`);
  const byCode = {}; for (const x of m) byCode[x.code] = (byCode[x.code] || 0) + 1;
  console.log(JSON.stringify(byCode));
  fs.writeFileSync(process.env.MISSES_OUT || "/tmp/errors-misses.json", JSON.stringify(m, null, 1));
});
