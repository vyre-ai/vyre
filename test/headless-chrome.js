// @ts-check
// The browser the real-browser tests use: the pinned chrome-headless-shell (scripts/install-test-chrome.mjs), or the one VYRE_CHROME names. Never a skip: a box or a CI job without it fails the test
// with the one command that fixes it, so a browser test cannot go quiet and hide a red (FOUNDATION T1).
import fs from "node:fs";
import { BIN } from "../scripts/install-test-chrome.mjs";

/** @returns {string} the browser's path */
export function headlessChrome() {
  const named = process.env.VYRE_CHROME;
  if (named && fs.existsSync(named)) return named;
  if (fs.existsSync(BIN)) return BIN;
  throw new Error(`no chrome-headless-shell for the browser tests; run: node scripts/install-test-chrome.mjs (installs the pinned build to ${BIN})`);
}
