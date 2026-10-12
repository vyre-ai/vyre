// Whose personal skills a launch is given: the verified asker of the turn (a member's one-turn hop gets the member's), nobody's for a thread a chat turn started that is launched with no verified person
// (the hop back, a plain resume), and the library's default (no person) for an ordinary thread no chat turn started.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { libraryPerson, NOBODY } from "./asker-account.js";
import { Switchboard } from "./index.js";

const sb = /** @type {any} */ ({ turnAsker: new Map() });

test("libraryPerson: the hop's asker, the running turn's asker, nobody for a chat-started thread with no verified person, the default otherwise", () => {
  assert.equal(libraryPerson(sb, { id: "t" }, { person: "per_bob", kernelTurn: { chat: "c", asker: "per_carol" } }), "per_carol", "carol's hop asks for carol's skills");
  assert.equal(libraryPerson(sb, { id: "t" }, { person: "per_bob", kernelTurn: { chat: "c", asker: "per_bob" } }), "per_bob", "bob's own turn asks for bob's");
  assert.equal(libraryPerson(sb, { id: "t" }, { person: "per_bob" }), NOBODY, "a chat-started thread launched with no verified person (the hop back) asks for nobody's");
  assert.equal(libraryPerson(sb, { id: "t" }, { person: "per_bob", skillsPerson: "per_bob" }), "per_bob", "the hop back relaunches on bob's own account with bob's skills");
  sb.turnAsker.set("t", "per_ada");
  assert.equal(libraryPerson(sb, { id: "t" }, { person: "per_bob" }), "per_ada", "a respawn takes the running turn's asker");
  sb.turnAsker.clear();
  assert.equal(libraryPerson(sb, { id: "own" }, {}), undefined, "an ordinary thread no chat turn started keeps the library's default");
});

test("libraryPlugin passes that person to skills.materialise", async () => {
  /** @type {any[]} */ const asked = [];
  const board = { turnAsker: new Map(), deps: { call: async (/** @type {string} */ tool, /** @type {any} */ input) => { asked.push([tool, input]); return { error: { code: "not_found" } }; } } };
  await Switchboard.prototype.libraryPlugin.call(board, { id: "t", provider: "claude" }, { person: "per_bob", kernelTurn: { chat: "c", asker: "per_carol" } });
  await Switchboard.prototype.libraryPlugin.call(board, { id: "t", provider: "claude" }, { person: "per_bob" });
  await Switchboard.prototype.libraryPlugin.call(board, { id: "own", provider: "claude" }, {});
  assert.deepEqual(asked.map(a => a[1].person), ["per_carol", NOBODY, undefined]);
});

test("libraryPlugin hands a sandboxed session a copy in its own temp folder, the original otherwise", async t => {
  const fs = await import("node:fs"), path = await import("node:path"), os = await import("node:os");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-lib-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const saved = process.env.VYRE_SESSIONS_DIR; process.env.VYRE_SESSIONS_DIR = path.join(base, "sessions");
  t.after(() => { if (saved === undefined) delete process.env.VYRE_SESSIONS_DIR; else process.env.VYRE_SESSIONS_DIR = saved; });
  const src = path.join(base, "home", "materialised", "claude", "abc123");
  fs.mkdirSync(path.join(src, ".claude-plugin"), { recursive: true }); fs.mkdirSync(path.join(src, "skills", "okafor"), { recursive: true });
  fs.writeFileSync(path.join(src, ".claude-plugin", "plugin.json"), "{}"); fs.writeFileSync(path.join(src, "skills", "okafor", "SKILL.md"), "BLUEBIRD-77");
  const make = (/** @type {any} */ sandbox) => /** @type {any} */ ({ turnAsker: new Map(), sessionTemp: Switchboard.prototype.sessionTemp, libraryForSandbox: Switchboard.prototype.libraryForSandbox, deps: { root: path.join(base, "home"), sandbox, call: async () => ({ data: { dir: src } }) } });
  const ask = (/** @type {any} */ board, /** @type {any} */ o = {}) => Switchboard.prototype.libraryPlugin.call(board, { id: "t", provider: "claude" }, o, "t1");
  const copy = await ask(make({}));
  assert.notEqual(copy, src, "a sandboxed session is not pointed at Vyre's home");
  assert.ok(copy.startsWith(path.join(base, "sessions")), `the copy is in the session's own temp folder: ${copy}`);
  assert.equal(fs.readFileSync(path.join(copy, "skills", "okafor", "SKILL.md"), "utf8"), "BLUEBIRD-77", "and holds the skill");
  assert.ok(fs.existsSync(path.join(copy, ".claude-plugin", "plugin.json")), "and the plugin file");
  assert.equal(await ask(make({ off: true })), src, "a session with no sandbox reads the original");
  assert.equal(await ask(make(undefined)), src, "and so does one on a computer with none");
  assert.equal(await ask(make({}), { accountRun: { uid: 2002 } }), src, "an account-uid session is not handled by this copy");
});
