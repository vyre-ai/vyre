// @ts-check
// Documents for a Space MEMBER (door-lists.js MEMBER_MAY: documents.template.list, .template.get, .generate). On a REAL daemon with the kernel on: the handlers run on HER chain, so what she
// reads and writes is what the kernel allows her; a template she cannot see is not found, a record she cannot read is refused by name, and nothing here sends: documents.send and the signing
// tools stay owner-only.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { MEMBER_MAY, OWNER_ONLY } from "../modules/door-lists.js";
import { refusal } from "../modules/door-gate.js";
import { docx } from "./testing/docx.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const MEMBER = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

async function rig(/** @type {any} */ t) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const chain = (/** @type {string} */ p) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(chain(OWNER), { person: MEMBER, role: "member" }, { presence: proof() });
  const tok = async (/** @type {string} */ p) => (await d.kernel.surfaces.open(chain(p), { agent: "assistant" })).token;
  const tokens = { owner: await tok(OWNER), member: await tok(MEMBER) };
  const as = (/** @type {"owner"|"member"} */ who, /** @type {string} */ tool, input = {}) => d.registry.call(tool, input, "mcp:agent:assistant", { thread: "t1", agent: "assistant", agentKind: "assistant", token: tokens[who] });
  return { d, as, OWNER };
}
const gated = (/** @type {any} */ r, /** @type {string} */ tool) => Boolean(r && r.error && r.error.code === "denied" && r.error.message === refusal(tool));

const urnOf = (/** @type {any} */ r) => r.data && (r.data.urn || (r.data.record && r.data.record.urn));
const LETTER = () => docx(["Dear {client.name},"]).toString("base64");

/** Give her the Drive paths a firm would: read the templates, write the documents. */
async function grantDrive(/** @type {any} */ d, /** @type {string} */ owner) {
  const SPACE = d.kernel.id.space;
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + owner.slice(4, 8), person: owner, path: "direct", session: "s" });
  for (const [actions, prefix] of [[["drive.read"], "Templates/*"], [["drive.read", "drive.write"], "Documents/*"]]) {
    const gi = { subject: { kind: "actor", actor: { kind: "person", id: MEMBER, space: SPACE } }, actions, resource: { prefix: `vyre://${SPACE}/file/${prefix}` }, conditions: {}, source: "test" };
    await d.kernel.gateway.grants.create(chain, gi, { presence: proof() });
  }
}

test("the three tools are on a member's list and nothing that sends is: send, the signing tools and adding a template stay the owner's", () => {
  for (const tool of ["documents.template.list", "documents.template.get", "documents.generate"]) { assert.ok(MEMBER_MAY.has(tool), tool); assert.ok(!OWNER_ONLY.has(tool), tool); }
  for (const tool of ["documents.send", "documents.send-signed", "documents.signing.waiting", "documents.signing.remind", "documents.signed-link", "documents.template.add"]) { assert.ok(OWNER_ONLY.has(tool), tool); assert.ok(!MEMBER_MAY.has(tool), tool); }
});

test("a member is never met by the door for the three tools, and what she gets is what the kernel lets her: without a Drive grant the templates are not there", { timeout: 300_000 }, async t => {
  const { as } = await rig(t);
  await as("owner", "documents.template.add", { name: "Letter", base64: LETTER() });
  for (const [tool, input] of /** @type {[string, any][]} */ ([["documents.template.list", {}], ["documents.template.get", { name: "Letter" }], ["documents.generate", { template: "Letter", values: { client: { name: "A" } } }]])) {
    const m = await as("member", tool, input);
    assert.ok(!gated(m, tool), `${tool}: not the door's refusal`);
    assert.ok(m.error && m.error.code === "not_found", `${tool}: the kernel keeps the Drive from her, ${JSON.stringify(m).slice(0, 160)}`);
  }
});

test("with the Drive paths a firm gives her, a member lists and reads templates and generates a document from a record she may read", { timeout: 300_000 }, async t => {
  const { d, as, OWNER } = await rig(t);
  await as("owner", "documents.template.add", { name: "Letter", base64: LETTER() });
  await grantDrive(d, OWNER);
  assert.deepEqual((await as("member", "documents.template.list", {})).data.templates.map((/** @type {any} */ x) => x.name), ["Letter"]);
  assert.deepEqual((await as("member", "documents.template.get", { name: "Letter" })).data.placeholders, ["client.name"]);
  const dana = urnOf(await as("owner", "records.create", { type: "contact", data: { name: "Dana Harlow" } }));
  const g = await as("member", "documents.generate", { template: "Letter", records: { client: dana } });
  assert.ok(g.data && /^Documents\/general\/letter-[0-9a-f]{8}\.docx$/.test(g.data.path), JSON.stringify(g).slice(0, 200));
  assert.deepEqual(g.data.used, ["client.name"]);
});

test("a generate that names a record she cannot read is refused by name, and files nothing", { timeout: 300_000 }, async t => {
  const { d, as, OWNER } = await rig(t);
  await as("owner", "documents.template.add", { name: "Letter", base64: LETTER() });
  await grantDrive(d, OWNER);
  const mine = urnOf(await as("owner", "records.create", { type: "project", data: { name: "Harlow estate" } }));
  assert.equal(((await as("member", "records.get", { urn: mine })).data || {}).record, null, "she has no seat on that project");
  const r = await as("member", "documents.generate", { template: "Letter", records: { client: mine } });
  assert.equal(r.error && r.error.code, "not_found");
  assert.match(r.error.message, /client: the record is not there, or is not yours to see/);
});

test("the tools that send or list everyone's requests are refused to a member by the door, in the owner's words", { timeout: 300_000 }, async t => {
  const { as } = await rig(t);
  for (const [tool, input] of /** @type {[string, any][]} */ ([["documents.send", { template_id: 1, email: "a@b.co" }], ["documents.signing.waiting", {}], ["documents.signing.remind", { submission: 1 }], ["documents.template.add", { name: "x", base64: LETTER() }]])) {
    assert.ok(gated(await as("member", tool, input), tool), `${tool}: a member meets the door`);
  }
});
