// @ts-check
// The space this terminal acts in by default: `vyre space use <name>` writes it, `vyre call` and `vyre status` read it. One small file in the home, never a secret.
import fs from "node:fs";
import path from "node:path";
import { home } from "../config/index.js";

const file = (/** @type {string} */ root) => path.join(root, "cli-space.json");

/** The remembered space, or null. @param {string} [root] */
export function readSpace(root = home()) {
  try { const v = JSON.parse(fs.readFileSync(file(root), "utf8")); return typeof v.space === "string" && v.space ? v.space : null; } catch { return null; }
}

/** Remember a space, or forget it with null. @param {string | null} space @param {string} [root] */
export function writeSpace(space, root = home()) {
  if (space === null) { try { fs.unlinkSync(file(root)); } catch { /* none to remove */ } return; }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file(root), JSON.stringify({ space }) + "\n", { mode: 0o600 });
}
