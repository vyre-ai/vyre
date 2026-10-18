// @ts-check
// skills.import through a real daemon.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { crc32 } from "../../lib/zip.js";
import fs from "node:fs";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";

test("skills.import through a real daemon: a draft, not an approved skill; worksWith comes back; a bad file is refused with the reason", async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(`${root}/config.json`, JSON.stringify({ vault: { keystore: "file" }, recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: () => {}, presence: present, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const z = zip([{ name: ".claude-plugin/plugin.json", data: plugin() }, { name: "skills/triage/SKILL.md", data: skill("triage") }, { name: "commands/intake.md", data: "Start an intake." }]);
  const r = await d.registry.call("skills.import", { level: "personal", file: z.toString("base64"), filename: "demo.zip" }, "cli");
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual([r.data.kind, r.data.name, r.data.code], ["plugin", "demo-plugin", false]);
  assert.equal(r.data.worksWith.commands.codex.works, false);
  assert.equal(r.data.state, "draft", "uploaded, not approved");
  assert.match(String(r.data.note), /Uploaded \(demo\.zip\).*Hooks aren't run by Vyre/, "the card can show what was uploaded and not taken");
  const listed = await d.registry.call("skills.list", {}, "cli");
  assert.ok(!(listed.data.skills || []).some((/** @type {any} */ s) => s.name === "demo-plugin"), "nothing uses it before approval");
  const bad = await d.registry.call("skills.import", { level: "personal", file: zip([{ name: "../x", data: "x" }]).toString("base64") }, "cli");
  assert.match(String(bad.error && bad.error.message), /climbs out/);
  const notB64 = await d.registry.call("skills.import", { level: "personal", file: "***" }, "cli");
  assert.ok(notB64.error);
});

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

