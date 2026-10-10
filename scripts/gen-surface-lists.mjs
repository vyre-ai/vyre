#!/usr/bin/env node
// Writes the lists a surface reads from its owner (scripts/lib/surface-lists.mjs).
import fs from "node:fs";
import path from "node:path";
import { ROOT, files } from "./lib/surface-lists.mjs";

for (const [f, text] of Object.entries(files())) { fs.writeFileSync(path.join(ROOT, f), text); console.log(`wrote ${f}`); }
