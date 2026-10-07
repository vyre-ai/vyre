#!/usr/bin/env node
// scripts/stamp-build-kind.mjs <lib/build-kind.js>: make the release stamp, and fail unless the file then holds exactly the release line (DP-1).
// A sed that matches nothing used to ship "development" in a signed release without a word.
import fs from "node:fs";
import { DEV_LINE, RELEASE_LINE } from "../lib/build-kind-text.js";

const file = process.argv[2];
if (!file) { console.error("usage: stamp-build-kind.mjs <lib/build-kind.js>"); process.exit(2); }
const text = fs.readFileSync(file, "utf8");
if (!text.includes(DEV_LINE)) { console.error(`stamp-build-kind: ${file} does not hold the line ${DEV_LINE}; the release would not be stamped, so the build stops`); process.exit(1); }
fs.writeFileSync(file, text.replace(DEV_LINE, RELEASE_LINE));
const after = fs.readFileSync(file, "utf8");
if (!after.includes(RELEASE_LINE) || after.includes(DEV_LINE)) { console.error("stamp-build-kind: the file does not say release after the stamp; the build stops"); process.exit(1); }
