// @ts-check
// Table-driven: person-relay entry points from listAllPersonRelayEntryPoints keep member isolation on a live daemon.
// Parametrized over every fake session adapter (claude, grok, codex) — agent-agnostic standing rule.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeTranscripts } from "../../test/fixtures/corpus.js";
import { composerPersonRelayTargets, listAllPersonRelayEntryPoints, listPersonRelayEntryPoints } from "../../lib/person-relay-entrypoints.js";
import { CAROL, BOB, relayDaemon, twoMembers, groupChat, scratchWork, tokenMeta, FAKE_SESSION_PROVIDERS } from "./member-relay-harness.js";
import { threadStartProviderFields } from "../sessions/testing/fake-agent-harness.js";
import { indexCorpusTranscripts } from "../sessions/testing/recall-live.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

const titles = (/** @type {any} */ r) => {
  const d = r && r.data;
  const rows = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : [];
  return rows.map((/** @type {any} */ x) => String(x.title || ""));
};

/** @param {any} d @param {string} chat @param {string} line @param {any} meta */
async function slashOnChat(d, chat, line, meta) {
  return d.registry.call("threads.slash", { chat, line }, "cli", meta);
}

test("person-relay entry points: derived list matches live registry tools", { timeout: 60_000 }, async (t) => {
  const { d } = await relayDaemon(t);
  const eps = listPersonRelayEntryPoints(d.registry);
  assert.ok(eps.length >= 4, JSON.stringify(eps.map((e) => e.id)));
  for (const e of eps) assert.ok(d.registry.tools.has(e.tool), `${e.id} tool ${e.tool}`);
  const all = listAllPersonRelayEntryPoints(d.registry);
  assert.ok(all.some((e) => e.id === "agents.ask"), JSON.stringify(all.map((e) => e.id)));
  for (const nested of composerPersonRelayTargets()) {
    assert.ok(
      all.some((e) => e.nested.includes(nested) || e.tool === nested),
      `composer person relay target ${nested} missing from derived list`,
    );
  }
});

for (const provider of FAKE_SESSION_PROVIDERS) {
  test(`person-scoped slash targets [${provider}]: /later planner isolation per derived threads.slash entry`, { timeout: 150_000 }, async (t) => {
    const { d } = await relayDaemon(t, provider);
    const entryPoints = listPersonRelayEntryPoints(d.registry).filter((e) => e.tool === "threads.slash");
    assert.ok(entryPoints.length >= 1);
    assert.ok(composerPersonRelayTargets().includes("planner.add"));

    const K = d.kernel, OWNER = K.id.owner;
    const { ownerChain, carolMeta, bobMeta } = await twoMembers(d, K, OWNER);
    const work = scratchWork(t, `vyre-relay-eps-${provider}-`);
    const thO = await d.registry.call("threads.start", { cwd: work, prompt: "hi", surface: "cli", ...(provider === "claude" ? {} : { provider }) }, "cli");
    assert.ok(thO.data, JSON.stringify(thO.error));
    const chat = (await d.registry.call("threads.get", { thread: thO.data.id, limit: 1 }, "cli")).data.thread.chat;
    await K.gateway.grants.chats.change(ownerChain, chat, { add_people: [CAROL, BOB] });

    const tagC = `carol-grp-${Date.now()}`;
    const tagB = `bob-grp-${Date.now()}`;
    for (const ep of entryPoints) {
      const slashC = await slashOnChat(d, chat, `/later "at 10am" ${tagC}`, carolMeta);
      const slashB = await slashOnChat(d, chat, `/later "at 11am" ${tagB}`, bobMeta);
      assert.ok(!slashC.error, `${ep.id} carol: ${JSON.stringify(slashC.error)}`);
      assert.ok(!slashB.error, `${ep.id} bob: ${JSON.stringify(slashB.error)}`);
    }

    const carolTitles = titles(await d.registry.call("planner.list", {}, "cli", carolMeta));
    const bobTitles = titles(await d.registry.call("planner.list", {}, "cli", bobMeta));
    assert.ok(carolTitles.some((x) => x.includes(tagC)));
    assert.ok(bobTitles.some((x) => x.includes(tagB)));
    assert.ok(!carolTitles.some((x) => x.includes(tagB)));
    assert.ok(!bobTitles.some((x) => x.includes(tagC)));

    const ownerItem = await d.registry.call("planner.add", { kind: "reminder", title: `owner-only-${Date.now()}`, body: "x", at: "at 9am" }, "cli", await tokenMeta(K, ownerChain));
    assert.ok(ownerItem.data?.title, JSON.stringify(ownerItem.error));
    const afterCarol = titles(await d.registry.call("planner.list", {}, "cli", carolMeta));
    assert.ok(!afterCarol.some((x) => x.includes(String(ownerItem.data.title))), "member planner list must not show owner's item");
  });

  test(`person-scoped slash targets [${provider}]: /remember on owner's thread is denied to members`, { timeout: 150_000 }, async (t) => {
    assert.ok(composerPersonRelayTargets().includes("threads.remember"));
    const { d } = await relayDaemon(t, provider);
    const K = d.kernel, OWNER = K.id.owner;
    const work = scratchWork(t, `vyre-remember-${provider}-`);
    const { carolMeta, bobMeta, thread, ownerChain } = await groupChat(d, K, OWNER, work, provider);
    const ownerMeta = await tokenMeta(K, ownerChain);
    const phrase = `remember-owner-${Date.now()}`;

    const slashEps = listPersonRelayEntryPoints(d.registry).filter((e) => e.tool === "threads.slash");
    for (const ep of slashEps) {
      const rC = await d.registry.call("threads.slash", { thread, line: `/remember ${phrase}-c` }, "cli", carolMeta);
      const rB = await d.registry.call("threads.slash", { thread, line: `/remember ${phrase}-b` }, "cli", bobMeta);
      assert.equal(rC.data?.error?.code || rC.error?.code, "denied", `${ep.id} carol`);
      assert.equal(rB.data?.error?.code || rB.error?.code, "denied", `${ep.id} bob`);
    }

    const ok = await d.registry.call("threads.remember", { thread, text: phrase }, "cli", ownerMeta);
    assert.ok(!ok.error, JSON.stringify(ok));
    assert.match(fs.readFileSync(path.join(work, "CLAUDE.md"), "utf8"), new RegExp(phrase));
  });

  test(`person-scoped slash targets [${provider}]: /find relays recall.search as each member`, { timeout: 180_000 }, async (t) => {
    assert.ok(composerPersonRelayTargets().includes("recall.search"));
    const { d, root } = await relayDaemon(t, provider, { recall: true });
    const transcripts = path.join(root, "transcripts");
    writeTranscripts(transcripts);
    await indexCorpusTranscripts(d);

    const K = d.kernel, OWNER = K.id.owner;
    const work = scratchWork(t, `vyre-find-${provider}-`);
    const { carolMeta, bobMeta, chat, ownerChain } = await groupChat(d, K, OWNER, work, provider);

    const tagC = `carol-find-${provider}-${Date.now()}`;
    const tagB = `bob-find-${provider}-${Date.now()}`;
    const thC = await d.registry.call("threads.start", { cwd: work, prompt: tagC, surface: "cli", ...threadStartProviderFields(provider) }, "cli", carolMeta);
    const thB = await d.registry.call("threads.start", { cwd: work, prompt: tagB, surface: "cli", ...threadStartProviderFields(provider) }, "cli", bobMeta);
    assert.ok(thC.data?.id && thB.data?.id, JSON.stringify({ thC: thC.error, thB: thB.error }));
    await indexCorpusTranscripts(d);

    const slashEps = listPersonRelayEntryPoints(d.registry).filter((e) => e.tool === "threads.slash");
    for (const ep of slashEps) {
      const rC = await slashOnChat(d, chat, `/find ${tagC}`, carolMeta);
      const rB = await slashOnChat(d, chat, `/find ${tagB}`, bobMeta);
      assert.ok(!rC.error, `${ep.id} carol find: ${JSON.stringify(rC.error)}`);
      assert.ok(!rB.error, `${ep.id} bob find: ${JSON.stringify(rB.error)}`);
      const hitsC = Array.isArray(rC.data) ? rC.data : [];
      const hitsB = Array.isArray(rB.data) ? rB.data : [];
      assert.ok(hitsC.some((h) => String(h.snippet || h.text || "").includes(tagC)), `${ep.id} carol must find her own session`);
      assert.ok(hitsB.some((h) => String(h.snippet || h.text || "").includes(tagB)), `${ep.id} bob must find his own session`);
      assert.ok(!hitsC.some((h) => String(h.snippet || h.text || "").includes(tagB)), `${ep.id} carol must not see bob's recall`);
      assert.ok(!hitsB.some((h) => String(h.snippet || h.text || "").includes(tagC)), `${ep.id} bob must not see carol's recall`);
    }

    const ownerCorpus = await d.registry.call("recall.search", { q: "intake form", limit: 3 }, "cli", await tokenMeta(K, ownerChain));
    assert.ok((ownerCorpus.data || []).length > 0, "owner still searches the indexed corpus");
    const directC = await d.registry.call("recall.search", { q: "intake form", limit: 3 }, "cli", carolMeta);
    const directB = await d.registry.call("recall.search", { q: "intake form", limit: 3 }, "cli", bobMeta);
    assert.ok(!directC.error && !directB.error, JSON.stringify({ directC: directC.error, directB: directB.error }));
    assert.equal((directC.data || []).length, 0, "members must not search the owner's indexed corpus");
    assert.equal((directB.data || []).length, 0);

    const ownerMeta = await tokenMeta(K, ownerChain);
    const secret = `vault-find-leak-${Date.now()}`;
    const put = await d.registry.call("vault.put", { name: secret, kind: "secret", fields: { value: "x" } }, "cli", ownerMeta);
    assert.ok(!put.error, JSON.stringify(put.error));
    const leakC = await d.registry.call("recall.search", { q: secret, limit: 5 }, "cli", carolMeta);
    const leakB = await d.registry.call("recall.search", { q: secret, limit: 5 }, "cli", bobMeta);
    assert.equal((leakC.data || []).length, 0, "members must not recall-search into owner's vault item name");
    assert.equal((leakB.data || []).length, 0);
  });

  test(`ingress entry points [${provider}]: members cannot resolve owner's vault tag`, { timeout: 150_000 }, async (t) => {
    const ingressEps = listPersonRelayEntryPoints().filter((e) => e.nested.includes("mentions.resolve") || e.nested.includes("vault.mention.resolve"));
    assert.ok(ingressEps.some((e) => e.id === "composer.send"), JSON.stringify(ingressEps));

    const { d } = await relayDaemon(t, provider);
    const K = d.kernel, OWNER = K.id.owner;
    const work = scratchWork(t, `vyre-ingress-${provider}-`);
    const { ownerChain, carolMeta, bobMeta, thread } = await groupChat(d, K, OWNER, work, provider);
    const ownerMeta = await tokenMeta(K, ownerChain);
    const vaultName = `relay-ingress-${Date.now()}`;
    const put = await d.registry.call("vault.put", { name: vaultName, kind: "secret", fields: { value: "owner-only" } }, "cli", ownerMeta);
    assert.ok(!put.error, JSON.stringify(put.error));

    for (const who of [
      ["carol", carolMeta],
      ["bob", bobMeta],
    ]) {
      const r = await d.registry.call("mentions.resolve", { kind: "vault", id: vaultName, thread, said: `said-${who[0]}` }, "module:sessions", who[1]);
      const direct = await d.registry.call("vault.mention.resolve", { id: vaultName, thread, said: `said-${who[0]}-direct` }, "module:sessions", who[1]);
      const denied = (/** @type {any} */ x) => x.error || !(x.data?.grant?.use);
      assert.ok(denied(r), `${who[0]} mentions.resolve: ${JSON.stringify(r)}`);
      assert.ok(denied(direct), `${who[0]} vault.mention.resolve: ${JSON.stringify(direct)}`);
    }

    const ok = await d.registry.call("mentions.resolve", { kind: "vault", id: vaultName, thread, said: "said-owner" }, "module:sessions", ownerMeta);
    assert.ok(!ok.error, JSON.stringify(ok.error));
    assert.equal(ok.data?.name, vaultName);
    assert.equal(ok.data?.grant?.use, true, "owner resolve grants use on their item");

    for (const ep of ingressEps) {
      if (ep.tool !== "threads.send" && ep.tool !== "threads.edit") continue;
      const send = await d.registry.call(ep.tool, {
        thread,
        text: "tagging vault",
        surface: "cli",
        chips: [{ kind: "vault", id: vaultName }],
      }, "cli", carolMeta);
      assert.ok(!send.error || send.error.code !== "denied", `send may complete; tag must not grant: ${JSON.stringify(send.error)}`);
    }
  });
}
