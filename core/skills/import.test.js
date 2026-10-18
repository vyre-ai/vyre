// @ts-check
// Upload a skill or plugin: one SKILL.md or .md, a zip of a skill folder, or a zip of a plugin. Strict on a stranger's file; says which AI uses each part and what was left out. Nothing runs and nothing is written here.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { crc32 } from "../../lib/zip.js";
import { parseUpload, worksWith, IMPORT_LIMITS } from "./import.js";

/** @param {{ name: string, data: string | Buffer, link?: boolean }[]} entries */
function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data), body = zlib.deflateRawSync(data), name = Buffer.from(e.name, "utf8"), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.link ? 0x031e : 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    if (e.link) ch.writeUInt32LE((0o120777 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name); offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const skill = (/** @type {string} */ n, body = "Do the careful thing first, then the next one.") => `---\nname: ${n}\ndescription: Use this when the team needs the ${n} routine done the same way each time.\n---\n${body}\n`;
const plugin = (extra = {}) => JSON.stringify({ name: "demo-plugin", description: "A small demo plugin for tests.", version: "1.0.0", ...extra });

test("a SKILL.md or any .md with the front matter is one skill; a bad one says what is wrong", () => {
  const r = parseUpload({ file: Buffer.from(skill("file-intake")), filename: "SKILL.md" });
  assert.deepEqual([r.kind, r.name, r.code, r.leftOut], ["skill", "file-intake", false, []]);
  assert.equal(r.worksWith.skills?.codex.works, true);
  assert.equal(r.worksWith.commands, null);
  assert.throws(() => parseUpload({ file: Buffer.from("no front matter here") , filename: "x.md" }), /front matter/);
  assert.throws(() => parseUpload({ file: Buffer.from("") }), /empty/);
  assert.throws(() => parseUpload({ file: Buffer.concat([Buffer.from(skill("a")), Buffer.from([0])]), filename: "a.md" }), /not text/);
  assert.throws(() => parseUpload({ file: Buffer.from(skill("leaky", "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD here")), filename: "a.md" }), /looks like/);
});

test("a zip of one skill folder (also inside one wrapping folder) is a skill; extra files are listed as left out", () => {
  const z = zip([{ name: "intake/SKILL.md", data: skill("intake") }, { name: "intake/notes.txt", data: "x" }]);
  const r = parseUpload({ file: z, filename: "intake.zip" });
  assert.deepEqual([r.kind, r.name], ["skill", "intake"]);
  assert.match(r.leftOut[0], /1 other file/);
  assert.throws(() => parseUpload({ file: zip([{ name: "a.txt", data: "x" }]), filename: "a.zip" }), /neither a skill/);
});

test("a plugin zip: skills, commands and MCP servers are taken; env and headers are dropped and said; agents and Claude hooks are left out and said", () => {
  const z = zip([
    { name: ".claude-plugin/plugin.json", data: plugin() },
    { name: "skills/triage/SKILL.md", data: skill("triage") },
    { name: "commands/intake.md", data: "Start an intake." },
    { name: "agents/helper.md", data: "an agent" },
    { name: ".mcp.json", data: JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["-y", "docs-server"], env: { TOKEN: "x" } }, web: { url: "https://example.com/mcp" } } }) },
    { name: "hooks/hooks.json", data: JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "sh x.sh" }] }] } }) },
    { name: "README.md", data: "hello" },
  ]);
  const r = parseUpload({ file: z, filename: "demo.zip" });
  const p = JSON.parse(r.body);
  assert.deepEqual([r.kind, r.name, r.code], ["plugin", "demo-plugin", true]);
  assert.deepEqual([p.skills.length, p.commands.length, p.mcp.map((/** @type {any} */ m) => [m.name, m.transport])], [1, 1, [["docs", "stdio"], ["web", "http"]]]);
  assert.ok(!JSON.stringify(p).includes("TOKEN"), "no credential comes through");
  assert.ok(r.leftOut.some(x => /credentials/.test(x)) && r.leftOut.some(x => /agents/.test(x)) && r.leftOut.some(x => /hooks/.test(x)));
  assert.equal(r.worksWith.commands?.codex.works, false, "Codex has no plugin commands: never claimed");
  assert.equal(r.worksWith.mcp?.claude.works, true);
  assert.match(String(r.worksWith.skills?.grok.note), /not yet run/);
});

test("a hostile zip is refused: a link, a path out, an absolute path, an unknown part, a hook event Vyre does not know, a wrong name, too big", () => {
  const base = [{ name: ".claude-plugin/plugin.json", data: plugin() }, { name: "skills/a/SKILL.md", data: skill("a") }];
  assert.throws(() => parseUpload({ file: zip([...base, { name: "skills/b/SKILL.md", data: "../x", link: true }]), filename: "z.zip" }), /is a link/);
  assert.throws(() => parseUpload({ file: zip([...base, { name: "skills/../../etc/x", data: "x" }]), filename: "z.zip" }), /climbs out/);
  assert.throws(() => parseUpload({ file: zip([...base, { name: "/etc/x", data: "x" }]), filename: "z.zip" }), /absolute/);
  assert.throws(() => parseUpload({ file: zip([...base, { name: "scripts/run.sh", data: "x" }]), filename: "z.zip" }), /not a part of a plugin/);
  assert.throws(() => parseUpload({ file: zip([...base, { name: "hooks/hooks.json", data: JSON.stringify({ hooks: { Whatever: [] } }) }]), filename: "z.zip" }), /Vyre knows/);
  assert.throws(() => parseUpload({ file: zip([{ name: ".claude-plugin/plugin.json", data: plugin({ name: "Bad Name!" }) }]), filename: "z.zip" }), /name/);
  assert.throws(() => parseUpload({ file: zip([{ name: ".claude-plugin/plugin.json", data: "{nope" }]), filename: "z.zip" }), /not JSON/);
  assert.throws(() => parseUpload({ file: Buffer.concat([zip(base), Buffer.alloc(IMPORT_LIMITS.zip)]), filename: "z.zip" }), /larger than/);
  assert.throws(() => parseUpload({ file: Buffer.from("PK\x03\x04 not really"), filename: "z.zip" }), /zip/);
});

test("worksWith lists only the parts present and never claims what is not true", () => {
  const w = worksWith({ skills: 1, commands: 0, hooks: 1, mcp: 0 });
  assert.deepEqual([w.skills !== null, w.commands, w.hooks !== null, w.mcp], [true, null, true, null]);
  assert.equal(w.hooks?.codex.works, false);
});
