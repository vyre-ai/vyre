// @ts-check
// recall.search under a member's kernel session searches only her own sessions (never the owner's corpus or another member's).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeTranscripts, SESSIONS, HOME } from "../../test/fixtures/corpus.js";
import { listPersonRelayEntryPoints } from "../../lib/person-relay-entrypoints.js";
import { CAROL, BOB, relayDaemon, twoMembers, scratchWork, tokenMeta } from "../../harness/member-relay-harness.js";
import { threadStartProviderFields, ensureMemberLoginAccounts } from "../sessions/testing/fake-agent-harness.js";
import { indexCorpusTranscripts, recallFts5Available } from "../sessions/testing/recall-live.js";

test("recall.search: members see only their own sessions on every person-relay entry point", { timeout: 180_000 }, async t => {
  if (!recallFts5Available()) { t.skip("Node 22.16+ with FTS5 required"); return; }
  const { d, root } = await relayDaemon(t, "claude", { recall: true });
  const transcripts = path.join(root, "transcripts");
  const moved = SESSIONS.map(s => ({ ...s, cwd: s.cwd.replace(HOME, root) }));
  writeTranscripts(transcripts, moved);
  await indexCorpusTranscripts(d);

  const K = d.kernel, OWNER = K.id.owner;
  const { ownerChain, carolMeta, bobMeta } = await twoMembers(d, K, OWNER);
  await ensureMemberLoginAccounts(d, [["Carol", carolMeta], ["Bob", bobMeta]], "claude");
  const ownerMeta = await tokenMeta(K, ownerChain);
  const work = scratchWork(t, "vyre-recall-member-");

  const tagC = `carol-only-${Date.now()}`;
  const tagB = `bob-only-${Date.now()}`;
  const thC = await d.registry.call("threads.start", { cwd: work, prompt: tagC, surface: "cli", ...threadStartProviderFields("claude") }, "cli", carolMeta);
  const thB = await d.registry.call("threads.start", { cwd: work, prompt: tagB, surface: "cli", ...threadStartProviderFields("claude") }, "cli", bobMeta);
  assert.ok(thC.data?.id && thB.data?.id, JSON.stringify({ thC: thC.error, thB: thB.error }));
  await indexCorpusTranscripts(d);

  assert.ok((await d.registry.call("recall.search", { q: "intake form", limit: 5 }, "cli", ownerMeta)).data.length > 0);

  for (const [name, meta, own, other] of [["carol", carolMeta, tagC, tagB], ["bob", bobMeta, tagB, tagC]]) {
    assert.equal((await d.registry.call("recall.search", { q: "intake form", limit: 5 }, "cli", meta)).data.length, 0, `${name} must not search owner's corpus`);
    assert.ok((await d.registry.call("recall.search", { q: own, limit: 5 }, "cli", meta)).data.length > 0, `${name} finds her own prompt`);
    assert.equal((await d.registry.call("recall.search", { q: other, limit: 5 }, "cli", meta)).data.length, 0, `${name} must not find the other member's prompt`);
  }

  const thG = await d.registry.call("threads.start", { cwd: work, prompt: "group", surface: "cli", ...threadStartProviderFields("claude") }, "cli");
  const chat = (await d.registry.call("threads.get", { thread: thG.data.id, limit: 1 }, "cli")).data.thread.chat;
  await K.gateway.grants.chats.change(ownerChain, chat, { add_people: [CAROL, BOB] });

  const slashEps = listPersonRelayEntryPoints(d.registry).filter((e) => e.tool === "threads.slash");
  assert.ok(slashEps.length >= 1);
  for (const ep of slashEps) {
    const rC = await d.registry.call("threads.slash", { chat, line: `/find ${tagC}` }, "cli", carolMeta);
    const rB = await d.registry.call("threads.slash", { chat, line: `/find ${tagB}` }, "cli", bobMeta);
    assert.ok(!rC.error && !rB.error, `${ep.id}: ${JSON.stringify({ rC: rC.error, rB: rB.error })}`);
    const hitsC = Array.isArray(rC.data) ? rC.data : [];
    const hitsB = Array.isArray(rB.data) ? rB.data : [];
    assert.ok(hitsC.length > 0 && hitsB.length > 0);
    assert.ok(!hitsC.some((h) => String(h.snippet || "").includes(tagB)));
    assert.ok(!hitsB.some((h) => String(h.snippet || "").includes(tagC)));
  }
});
