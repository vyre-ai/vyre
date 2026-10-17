// @ts-check
// Personal skills across an owner adoption. A personal skill is kept under its person's id; the kernel maps the replaced owner id to the identity (canonicalPerson). The approved list maps ONLY through that: the owner's
// pre-adoption skill is the owner's after the adopt, and another member's personal skill stays hidden from the owner, from the other member, and from a caller who names the member's id as their own.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createLibrary } from "./library.js";

const OLD = "per_old000000000000000000000", NEW = "per_new000000000000000000000", MEMBER = "per_member00000000000000000", OTHER = "per_other0000000000000000000";
const row = (/** @type {string} */ name, /** @type {string} */ level, /** @type {string} */ scope) => ({ id: `${level}-${name}`, data: { name, level, scope, version: 1, state: "approved", kind: "skill", body: `---\nname: ${name}\n---\n${name}\n` } });
const lib = (/** @type {boolean} */ adopted) => createLibrary({
  kernel: () => /** @type {any} */ ({ serviceChain: () => ({}), records: { query: async () => ({ rows: [row("mine-before", "personal", OLD), row("members", "personal", MEMBER), row("shared", "space", "")] }) },
    canonicalPerson: (/** @type {string} */ id) => (adopted && id === OLD ? NEW : id) }),
});
const seen = async (/** @type {boolean} */ adopted, /** @type {string} */ person) => (await lib(adopted).approved({ person, agent: null, projects: [], allAgents: false })).map((/** @type {any} */ i) => i.name).sort();

test("the owner's pre-adoption personal skill follows the adopt through canonicalPerson alone; another member's stays hidden", async () => {
  assert.deepEqual(await seen(false, OLD), ["mine-before", "shared"], "before the adopt the owner sees their own");
  assert.deepEqual(await seen(true, NEW), ["mine-before", "shared"], "after it, as the identity, the same");
  assert.deepEqual(await seen(true, OLD), ["mine-before", "shared"], "a session still opened under the old id is the owner's");
  assert.ok(!(await seen(true, NEW)).includes("members"), "the owner does not see a member's personal skill");
  assert.deepEqual(await seen(true, MEMBER), ["members", "shared"], "the member sees their own, and not the owner's");
  assert.deepEqual(await seen(true, OTHER), ["shared"], "a third person sees neither");
});
