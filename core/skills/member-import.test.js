// @ts-check
// A team member uploads a skill file through the member door and the registry tool, on a real vyred and real chains: it is a draft in her personal level that she alone approves, she sees it and another member
// does not, and everything the owner path refuses (a plugin, a link, a ".." name, an oversize file) is refused for her too, plus a level or a scope that is not hers and a rate limit.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { crc32 } from "../../lib/zip.js";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { createMemberTools, MEMBER_TOOLS } from "../work/member-tools.js";
import { IMPORTS_PER_HOUR, uploadRoute } from "./member-ops.js";
import { MEMBER_MAY, OWNER_ONLY } from "../modules/door-lists.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", CAROL = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const skill = (/** @type {string} */ n, body = "Do the careful thing first, then the next one.") => `---\nname: ${n}\ndescription: Use this when the team needs the ${n} routine done the same way each time.\n---\n${body}\n`;
const b64 = (/** @type {string | Buffer} */ x) => Buffer.from(x).toString("base64");

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

test("who reaches which path: an owner or an admin the owner path, a member her own op, everyone else and every failed lookup nothing", () => {
  assert.deepEqual(["owner", "admin", "member"].map(uploadRoute), ["owner", "owner", "member"]);
  for (const role of [null, undefined, "", "temp", "guest", "Member", 7, {}]) assert.equal(uploadRoute(role), null, String(role));
});

test("the member upload row: its keys are exactly level, scope, file and filename, and skills.import is a member tool, not an owner-only one", () => {
  assert.deepEqual([...MEMBER_TOOLS["skills.import"].keys], ["level", "scope", "file", "filename"]);
  assert.equal(MEMBER_TOOLS["skills.import"].tool, "skills.serve-write");
  assert.ok(MEMBER_MAY.has("skills.import") && !OWNER_ONLY.has("skills.import"));
});

test("a member's upload is a personal draft she approves alone; it is hers and no other member's; what the owner path refuses is refused for her", { timeout: 150_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const oc = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await d.kernel.gateway.grants.setRole(oc, { person, role: "member" }, { presence: proof() });
  const door = createMemberTools({ space: d.kernel.id.space, kernel: d.kernel, registry: d.registry }).skills;
  const chain = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + person.slice(4, 8), person, path: "relay" });
  const ana = chain(ANA), ben = chain(BEN);
  /** @param {Promise<any>} p */
  const refused = async p => { try { await p; } catch (e) { return String(/** @type {Error} */ (e).message); } return assert.fail("was not refused"); };

  const up = await door.import(ana, { file: b64(skill("ana-upload")), filename: "ana-upload.md" });
  assert.equal(up.state, "draft");
  assert.deepEqual([up.kind, up.name, up.code], ["skill", "ana-upload", false]);
  const own = (/** @type {any} */ r) => (r.skills || []).some((/** @type {any} */ s) => s.name === "ana-upload");
  assert.equal(own(await door.list(ana, {})), false, "a draft is not in use yet");
  const ok = await door.approve(ana, { name: "ana-upload", level: "personal", scope: ANA, version: up.version });
  assert.ok(ok, "she approves her own");
  assert.equal(own(await door.list(ana, {})), true, "and it is hers to use");
  assert.equal(own(await door.list(ben, {})), false, "another member does not see it");
  assert.equal(JSON.stringify(await door.versions(ben, { name: "ana-upload" })).includes("ana-upload"), false, "nor its versions");

  // level and scope are not hers to choose: refused, not replaced
  assert.match(await refused(door.import(ana, { level: "space", file: b64(skill("wide")) })), /personal/);
  assert.match(await refused(door.import(ana, { level: "personal", scope: BEN, file: b64(skill("for-ben")) })), /herself|scope/);
  // an extra key the row does not list never reaches the op
  const extra = await door.import(ana, { file: b64(skill("keys-only")), agent: "someone", project: "x" });
  assert.equal(extra.state, "draft");

  // a plugin (MCP servers, hooks, commands), a link, a ".." name, a backslash name, an oversize file, a bad base64: refused for her as for the owner
  const plugin = zip([{ name: ".claude-plugin/plugin.json", data: JSON.stringify({ name: "demo-plugin", description: "A small demo plugin for tests.", version: "1.0.0" }) }, { name: "skills/triage/SKILL.md", data: skill("triage") }, { name: "commands/intake.md", data: "Start an intake." }]);
  assert.match(await refused(door.import(ben, { file: b64(plugin), filename: "demo.zip" })), /plugin/i);
  assert.match(await refused(door.import(ben, { file: b64(zip([{ name: "SKILL.md", data: skill("with-mcp") }, { name: ".mcp.json", data: "{}" }])), filename: "m.zip" })), /plugin/i);
  assert.ok(await refused(door.import(ben, { file: b64(zip([{ name: "SKILL.md", data: skill("linked") }, { name: "extra.md", data: "x", link: true }])), filename: "l.zip" })));
  assert.match(await refused(door.import(ben, { file: b64(zip([{ name: "../x", data: "x" }])), filename: "up.zip" })), /climbs out/);
  assert.match(await refused(door.import(ben, { file: b64(zip([{ name: "SKILL.md", data: skill("back") }, { name: "docs\\x.md", data: "x" }])), filename: "b.zip" })), /backslash/);
  assert.ok(await refused(door.import(ben, { file: b64(Buffer.alloc(3 * 1024 * 1024, 65)), filename: "big.zip" })));
  assert.ok(await refused(door.import(ben, { file: "***" })));
  // a script or a binary in the skill folder, and a text file that is allowed (left out, said so)
  assert.match(await refused(door.import(ben, { file: b64(zip([{ name: "SKILL.md", data: skill("with-script") }, { name: "tools/run.sh", data: "echo hi" }])), filename: "s.zip" })), /text file/);
  const withDoc = await door.import(ana, { file: b64(zip([{ name: "SKILL.md", data: skill("with-doc") }, { name: "notes.md", data: "More." }])), filename: "d.zip" });
  assert.equal(withDoc.state, "draft");
  assert.equal(withDoc.leftOut.length, 1);
  // a zip bomb: tiny, unpacks past 20 times its size
  assert.match(await refused(door.import(ben, { file: b64(zip([{ name: "SKILL.md", data: skill("bomb") }, { name: "pad.txt", data: Buffer.alloc(200 * 1024, 48) }])), filename: "z.zip" })), /times its size/);
  // front matter: a name and a description and nothing else
  for (const key of ["allowed-tools", "hooks", "mcp", "model"]) {
    const text = `---\nname: keyed\ndescription: Use this when the team needs the keyed routine done the same way each time.\n${key}: x\n---\nDo the careful thing.\n`;
    assert.match(await refused(door.import(ana, { file: b64(text), filename: "keyed.md" })), new RegExp(key), key);
  }
  // a credential in the text: refused by kind, never echoed
  const key = "sk-" + "ant-" + "a".repeat(24);
  const leaked = await refused(door.import(ana, { file: b64(skill("leaky", `Use ${key} to call it.`)), filename: "leaky.md" }));
  assert.ok(!leaked.includes(key), "the value is not echoed");
  assert.match(leaked, /looks like/);
  assert.equal((await door.versions(ana, { name: "leaky" })).versions.length, 0, "nothing was drafted");

  // the registry tool, on her own chain: the same rules, whatever the input says
  const so = await d.kernel.surfaces.open(chain(BEN), {});
  const viaTool = await d.registry.call("skills.import", { level: "space", file: b64(skill("tool-wide")) }, "cli", { token: so.token });
  assert.ok(viaTool.error, "a member's tool call at the space level is refused: " + JSON.stringify(viaTool));
  const viaPlugin = await d.registry.call("skills.import", { level: "personal", file: b64(plugin), filename: "demo.zip" }, "cli", { token: so.token });
  assert.ok(viaPlugin.error, "and a plugin too");

  // the rate limit, per member: it trips at the eleventh upload in an hour, and one member's burst does not block another
  let n = 0, tripped = "";
  for (; n < IMPORTS_PER_HOUR + 2 && !tripped; n++) {
    try { await door.import(ana, { file: b64(skill("burst-" + n)) }); } catch (e) { tripped = String(/** @type {Error} */ (e).message); }
  }
  assert.match(tripped, /an hour/);
  const other = await door.import(ben, { file: b64(skill("ben-upload")) });
  assert.equal(other.state, "draft", "another member is not held by her limit");

  // someone who is no member at all gets nothing from the tool, and nothing is drafted
  const cs = await d.kernel.surfaces.open(chain(CAROL), {});
  const stranger = await d.registry.call("skills.import", { level: "personal", file: b64(skill("stranger")) }, "cli", { token: cs.token });
  assert.ok(stranger.error, "a person who is not on the team is refused: " + JSON.stringify(stranger));
  assert.equal((await door.versions(ana, { name: "stranger" })).versions.length, 0);
});
