#!/usr/bin/env node
// @ts-check
// A small tool for people and for @Engineer: compile a definition file to its stored form, print a
// stored kit back as text, or check a file. Reads files you name; never executes them.
//   node records/language/cli.js compile kit.ts > kit.json
//   node records/language/cli.js print kit.json > kit.ts
//   node records/language/cli.js check kit.ts
import fs from "node:fs";
import { compileSafely, validateStored } from "./compile.js";
import { print } from "./print.js";
import { LanguageError } from "./errors.js";

const [cmd, file] = process.argv.slice(2);
try {
  if (!file) throw new LanguageError("usage", "usage: cli.js compile|print|check <file>");
  const text = fs.readFileSync(file, "utf8");
  if (cmd === "compile") process.stdout.write(JSON.stringify(await compileSafely(text), null, 2) + "\n");
  else if (cmd === "print") process.stdout.write(print(JSON.parse(text)));
  else if (cmd === "check") { if (file.endsWith(".json")) validateStored(JSON.parse(text)); else await compileSafely(text); process.stdout.write("ok\n"); }
  else throw new LanguageError("usage", "usage: cli.js compile|print|check <file>");
} catch (e) {
  process.stderr.write(`${/** @type {Error} */ (e).message}\n`);
  process.exit(e instanceof LanguageError ? 2 : 1);
}
