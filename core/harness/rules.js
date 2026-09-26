// @ts-check
// The security floor, as far as a PreToolUse hook can enforce it (docs/SPEC.md section 11).
//
// Only two answers exist here: "deny" and "ask". Anything else is null, no opinion, and Claude
// Code's own permission settings decide as they would without Vyre. The floor never loosens
// Claude Code; it can only hold a call back.
//
// What is enforced now:
//   rule 8   no vault value on any screen: nothing reads, lists or copies the vault folder.
//   rules 1, 2  nothing goes out as the user unseen: a tool that sends, posts or replies asks
//            first, and the question names where it is going.
// The Gate (M9) takes over outbound control properly; until then this is the backstop.

import os from "node:os";
import path from "node:path";

/** Words in an MCP tool's own name that mean it sends something as the user. */
const SENDS = /(^|[_-])(send|post|reply|forward|publish|share|invite|tweet|dm|comment)([_-]|$)/i;
/** Where a sending tool keeps its destination, in the order worth showing. */
const DEST_KEYS = ["to", "channel", "channel_id", "recipient", "recipients", "email", "thread_id", "chat_id", "user", "url"];

/**
 * @param {{ tool: string, input: Record<string, any>, cwd?: string, home?: string }} call
 * @returns {{ decision: "deny"|"ask"|null, reason?: string, rule?: number }}
 */
export function rules({ tool, input, cwd, home }) {
  const vyreHome = path.resolve(home || process.env.VYRE_HOME || path.join(os.homedir(), ".vyre"));
  const vault = path.join(vyreHome, "vault");

  // Rule 8. Paths in the input, or anywhere in a shell command, that reach into the vault.
  const text = mentions(input);
  const tilde = vault.startsWith(os.homedir()) ? "~" + vault.slice(os.homedir().length) : null;
  const hits = [vault, tilde].filter(Boolean).some(v => text.includes(/** @type {string} */ (v)))
    || candidatePaths(input).some(p => within(path.resolve(cwd || os.homedir(), untilde(p)), vault));
  if (hits) return { decision: "deny", rule: 8, reason: "Vyre keeps vault values off every screen. Use the item through the tool that declared it; the value itself is never read." };

  // Rules 1 and 2. Only MCP tools: those are the ones that reach people (mail, chat, posts).
  if (tool.startsWith("mcp__")) {
    const own = tool.split("__").pop() || "";
    if (SENDS.test(own) && !/(^|_)(draft|list|get|search|read)(_|$)/i.test(own)) {
      const dest = DEST_KEYS.map(k => input[k]).find(v => v != null && v !== "");
      const where = dest == null ? "an unnamed destination" : Array.isArray(dest) ? dest.join(", ") : String(dest);
      return { decision: "ask", rule: 1, reason: `This sends as you, to ${where.slice(0, 200)}. Vyre asks before anything goes out.` };
    }
  }
  return { decision: null };
}

/** Every string in the input, joined, for substring checks. */
function mentions(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach(x => mentions(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach(x => mentions(x, out));
  return out.join("\n");
}

/** Values that look like paths: file_path, path, notebook_path, and every word of a shell command, resolved from cwd. */
function candidatePaths(input) {
  const out = [];
  for (const k of ["file_path", "path", "notebook_path"]) if (typeof input[k] === "string") out.push(input[k]);
  if (typeof input.command === "string") for (const tok of input.command.split(/[\s'"=;|&()<>]+/)) if (tok && !tok.startsWith("-")) out.push(tok);
  return out;
}

const untilde = p => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
const within = (p, dir) => p === dir || p.startsWith(dir + path.sep);
