// kernel/flows/code-child.js: runs INSIDE the OS sandbox (kernel/modules/sandbox.js) for one Code step. It reads the step's source and inputs from the folder it was handed
// (read only), runs the source as the body of `function (inputs)`, and prints one JSON line: { ok: true, outputs } or { ok: false, error }. It has no network, no files beyond
// its own folder, no child process and no worker; the parent kills it on the time limit and the heap flag caps its memory.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const say = (/** @type {any} */ o) => process.stdout.write(JSON.stringify(o) + "\n");
try {
  const source = fs.readFileSync(path.join(dir, "source.txt"), "utf8");
  const inputs = JSON.parse(fs.readFileSync(path.join(dir, "inputs.json"), "utf8"));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const out = await new AsyncFunction("inputs", `"use strict";\n${source}`)(inputs);
  if (out === null || typeof out !== "object" || Array.isArray(out)) say({ ok: false, error: "the code must return an object of its declared outputs" });
  else say({ ok: true, outputs: out });
} catch (e) { say({ ok: false, error: String(e && /** @type {any} */ (e).message || e).slice(0, 300) }); }
