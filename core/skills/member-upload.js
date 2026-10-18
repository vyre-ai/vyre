// @ts-check
// skills/member-upload: a team member's upload, read strictly. A member is not the owner and a skill is untrusted text, so this is not the owner path's reader (import.js): it accepts ONE skill and nothing else.
//   - the file is one SKILL.md / .md, or a zip of one skill folder (SKILL.md at its top or one folder down);
//   - every plugin shape is refused (the plugin manifest folder, .mcp.json, hooks, agents, commands), and so is any file in the folder that is not text of an allowed kind (.md, .txt, .csv): no scripts, no binaries;
//   - the front matter has a name and a description and no other key (allowed-tools, hooks, mcp, model and the rest widen what a skill may do);
//   - the limits are tighter than the owner's: a zip of 1 MB, 256 KB unpacked, 20 files, names of 120 characters, a ratio of at most 20 to 1, a SKILL.md of 64 KB;
//   - an entry name with a backslash is refused (the reader already refuses "..", absolute names, links, encrypted and repeated entries);
//   - a credential found in the text refuses the upload, by kind and never by value.
// Any violation fails the whole upload with a plain message and nothing is written. Only SKILL.md is kept; the other text files in a folder are left out and said so.

import path from "node:path";
import { unzip } from "../../lib/zip.js";
import { frontMatter } from "../../lib/docs-corpus.js";
import { skillProblems, LIMITS } from "../../lib/skill-library.js";
import { credentialIn } from "../../lib/credential-shapes.js";
import { PLUGIN_LAYOUT } from "../../lib/plugin-layout.js";
import { worksWith } from "./import.js";

export const MEMBER_LIMITS = Object.freeze({ zip: 1024 * 1024, inflated: 256 * 1024, entries: 20, nameLength: 120, ratio: 20, file: LIMITS.body });
/** The kinds of file a skill folder may hold besides SKILL.md. */
const TEXT_EXT = new Set([".md", ".txt", ".csv"]);
/** The top-level names that make a zip a plugin, not a skill. */
const PLUGIN_TOP = new Set([PLUGIN_LAYOUT.manifest.split("/")[0], ".mcp.json", "hooks", "agents", "commands", "skills"]);
const KEYS = new Set(["name", "description"]);
const bad = (/** @type {string} */ message) => Object.assign(new Error(message), { code: "bad_input" });

/** @param {Buffer} b @param {string} what */
function textOf(b, what) {
  if (b.length > MEMBER_LIMITS.file) throw bad(`${what} is larger than ${MEMBER_LIMITS.file / 1024} KB`);
  if (b.includes(0)) throw bad(`${what} is not text`);
  return b.toString("utf8");
}

/**
 * The front matter, read strictly over the raw text. The lenient reader the library uses (frontMatter) skips any line it does not recognise, but another reader of the same file (Claude Code's YAML) accepts forms
 * it skips: a quoted key, a space before the colon, a flow mapping, a key that starts with a symbol, a tab, a byte-order mark, a repeated key. So the member path refuses everything but this shape:
 *   ---
 *   name: <text>
 *   description: <text>           (indented lines may continue it)
 *   ---
 * with CRLF taken as LF. The first line that does not fit is named, shortened.
 * @param {string} raw
 */
export function strictFrontMatter(raw) {
  const lines = String(raw).replace(/\r\n/g, "\n").split("\n");
  const show = (/** @type {string} */ l) => JSON.stringify(l.length > 40 ? l.slice(0, 40) + "..." : l);
  const refuse = (/** @type {string} */ l, /** @type {string} */ why) => bad(`the front matter of a member's skill is a name and a description and nothing else: ${show(l)} ${why}`);
  if (lines[0] !== "---") throw bad("a member's skill starts with a line that is exactly --- (no blank line, space or mark before it), then name and description, then --- on a line of its own");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw bad("the front matter has no closing --- line");
  let seen = { name: 0, description: 0 }, inDescription = false;
  for (const l of lines.slice(1, end)) {
    if (!l.trim()) continue;
    const m = /^(name|description): ?(\S.*)$/.exec(l);
    if (m) { seen[/** @type {"name"|"description"} */ (m[1])]++; inDescription = m[1] === "description"; if (seen[/** @type {"name"|"description"} */ (m[1])] > 1) throw refuse(l, "is a second one"); continue; }
    if (inDescription && /^ +\S/.test(l)) { if (/^ +[^\s:]+\s*:(\s|$)/.test(l)) throw refuse(l, "looks like a key inside the description"); continue; }
    throw refuse(l, "is not name or description");
  }
  if (!seen.name) throw bad("the front matter has a name");
}

/** @param {string} t @param {string} fallback */
function skillFrom(t, fallback) {
  strictFrontMatter(t);
  const { data } = frontMatter(t);
  const extra = Object.keys(data).filter(k => !KEYS.has(k));
  if (extra.length) throw bad(`a member's skill has a name and a description in its front matter and nothing else; remove ${extra.slice(0, 5).map(k => k.slice(0, 40)).join(", ")}`);
  const name = String(data.name || fallback);
  const problems = skillProblems(name, t);
  if (problems.length) throw bad(`${name.slice(0, 64)}: ${problems.join("; ")}`);
  const kind = credentialIn(t, "ingest");
  if (kind) throw bad(`it contains something that looks like a ${kind}: never write a key into a skill`);
  return { name, body: t };
}

/**
 * @param {{ file: Buffer, filename?: string }} i
 * @returns {{ kind: "skill", name: string, body: string, worksWith: ReturnType<typeof worksWith>, leftOut: string[], code: false }}
 */
export function parseMemberUpload({ file, filename = "" }) {
  if (!Buffer.isBuffer(file) || !file.length) throw bad("the file is empty");
  const works = worksWith({ skills: 1, commands: 0, hooks: 0, mcp: 0 });
  const isZip = file.length > 4 && file.readUInt32LE(0) === 0x04034b50 || /\.zip$/i.test(filename);
  if (!isZip) {
    const { name, body } = skillFrom(textOf(file, "the file"), path.basename(filename).replace(/\.md$/i, "").toLowerCase());
    return { kind: "skill", name, body, worksWith: works, leftOut: [], code: false };
  }
  if (file.length > MEMBER_LIMITS.zip) throw bad(`the zip is larger than ${MEMBER_LIMITS.zip / 1024 / 1024} MB`);
  /** @type {Map<string, Buffer>} */ let files;
  try { files = unzip(file, { maxEntries: MEMBER_LIMITS.entries, maxBytes: MEMBER_LIMITS.inflated, noLinks: true }); }
  catch (e) { throw bad(/** @type {Error} */ (e).message); }
  let inflated = 0;
  for (const [k, v] of files) {
    if (k.length > MEMBER_LIMITS.nameLength) throw bad(`a file name is longer than ${MEMBER_LIMITS.nameLength} characters`);
    if (k.includes("\\")) throw bad("a file name has a backslash");
    inflated += v.length;
  }
  if (inflated > file.length * MEMBER_LIMITS.ratio) throw bad(`the zip unpacks to more than ${MEMBER_LIMITS.ratio} times its size`);
  // one wrapping folder (what "zip this folder" makes) is looked through
  const tops = new Set([...files.keys()].map(k => k.split("/")[0]));
  let strip = "";
  if (tops.size === 1 && ![...files.keys()].some(k => !k.includes("/")) && !PLUGIN_TOP.has([...tops][0])) strip = [...tops][0] + "/";
  /** @type {Map<string, Buffer>} */ const f = new Map([...files].map(([k, v]) => [k.slice(strip.length), v]));
  for (const k of f.keys()) if (PLUGIN_TOP.has(k.split("/")[0]) && k !== "SKILL.md") throw bad("A plugin can carry code that runs in sessions, so a member cannot add one. Ask the owner or an admin to add it.");
  const sk = f.get("SKILL.md");
  if (!sk) throw bad("this zip is not a skill: SKILL.md is not at its top");
  for (const k of f.keys()) if (k !== "SKILL.md" && !TEXT_EXT.has(path.extname(k).toLowerCase())) throw bad(`${k.slice(0, 60)} is not a text file (.md, .txt or .csv): a skill holds text only`);
  const { name, body } = skillFrom(textOf(sk, "SKILL.md"), "");
  for (const [k, v] of f) if (k !== "SKILL.md") { const kind = credentialIn(textOf(v, k), "ingest"); if (kind) throw bad(`${k.slice(0, 60)} contains something that looks like a ${kind}`); }
  const extra = [...f.keys()].filter(k => k !== "SKILL.md");
  return { kind: "skill", name, body, worksWith: works, leftOut: extra.length ? [`${extra.length} other file(s) in the skill folder (a skill is its SKILL.md; point to a document for the rest)`] : [], code: false };
}
