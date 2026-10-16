// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import "../../scripts/mac-test-guard.mjs";
import { resolveTags } from "./said.js";
import { personCallOpts } from "../../lib/person-relay.js";

test("ingress passes the asking person through resolveTags so providers check their access", async () => {
  const seen = [];
  const meta = { token: "tok", kernelFacts: { kind: "device", person: "per_member" } };
  const relay = personCallOpts("deck", meta);
  const tags = await resolveTags({
    names: [],
    chips: [{ kind: "drive", id: "f1" }, { kind: "vault", id: "owner-only" }],
    thread: "t1",
    said: "u1",
    call: (tool, input) => {
      seen.push({ tool, input, opts: relay });
      if (tool === "mentions.resolve") return Promise.resolve({ data: { name: String(input.id), note: "ok", outside: true } });
      return Promise.resolve(null);
    },
  });
  assert.equal(tags.length, 2);
  assert.deepEqual(seen.map((x) => [x.tool, x.opts]), [
    ["mentions.resolve", relay],
    ["mentions.resolve", relay],
  ]);
});
