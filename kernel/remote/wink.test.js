import test from "node:test";
import assert from "node:assert/strict";
import { winkTransport, withKernelCall, KERNEL_CALL_TOOL } from "./wink.js";
import { createRemoteKernel } from "./client.js";
import { createRemoteServer } from "./server.js";
import { createKernel } from "../index.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
let T = 1_800_000_000_000;
const clock = () => ++T;

/** The peer wire's contract as the home sees it: the caller is what the connection proved, the input is JSON, the result is data or a thrown error. */
const wire = serve => ({ call: async (tool, input) => JSON.parse(JSON.stringify(await serve(`device:${wire.device}`, tool, JSON.parse(JSON.stringify(input))))) });

test("wink: a kernel call rides the peer wire as the proven device, mapped to a person by the identity chain; other tools are untouched", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
  const server = createRemoteServer({ space: SPACE, kernel: k, clock });
  const seen = [];
  const next = async (caller, tool) => { seen.push([caller, tool]); return { other: true }; };
  const people = { dev_owner: OWNER, dev_nobody: null };
  const serve = withKernelCall(next, { serverFor: s => (s === SPACE ? server : null), personOf: async d => people[d] });
  const remote = device => { wire.device = device; return createRemoteKernel({ space: SPACE, transport: winkTransport({ sessionFor: async () => wire(serve) }), clock }); };
  const r = remote("dev_owner");
  assert.deepEqual((await r.gateway.grants.members.list({})).map(m => m.person), [OWNER]);
  // a device no chain vouches for a person with, and a device the chain does not know
  await assert.rejects(() => remote("dev_nobody").gateway.grants.members.list({}), { code: "not_a_member" });
  await assert.rejects(() => remote("dev_unknown").gateway.grants.members.list({}), { code: "not_a_member" });
  // an unknown Space, and a caller that is not a device (a local caller never reaches this tool)
  const wrong = createRemoteKernel({ space: "spc_zzzzzzzzzzzz", transport: winkTransport({ sessionFor: async () => wire(serve) }), clock });
  await assert.rejects(() => wrong.gateway.grants.members.list({}), { code: "not_found" });
  wire.device = "x";
  const direct = await serve("agent:kit", KERNEL_CALL_TOOL, { v: 1, space: SPACE, id: "rq_a", ts: clock(), call: "grants.members.list", args: [] });
  assert.equal(direct.error.code, "not_a_member");
  // any other tool goes to the registry as before
  assert.deepEqual(await serve("device:dev_owner", "mail.list", {}), { other: true });
  assert.deepEqual(seen, [["device:dev_owner", "mail.list"]]);
});
