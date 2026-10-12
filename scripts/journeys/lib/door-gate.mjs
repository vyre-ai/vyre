// @ts-check
// J12's steps (0.3.3 rc.3, work/rc3/door-gate): the door gate on a real paired team server. A member's own session, reaching the registry with her session token (the stand-in agent runs `vyre call <tool>` in
// her turn), is refused in words on the owner's tools and served on her own; the owner is unaffected; her pairing and her sign-in still work. Stand-in, labelled: the agent is the repo's test script put on
// the box's PATH (as in J9); everything else is the product. The other member path (a member's own paired device, which carries no person) is proven by a real-daemon test, test/door-gate-member-device.test.js,
// because this rig has no step that pairs a second device as a member.
import assert from "node:assert/strict";
import { installStandins, signInThroughDoor } from "./shared-chat.mjs";
import { joinOne, framesOf } from "./member-people.mjs";

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/** @param {{ J: any, w: any, team: any, needs: string[] }} o */
export async function doorGateSteps({ J, w, team, needs }) {
  /** @type {any} */ let grace, edith;
  /** @type {Record<string, any>} */ const accounts = {};
  let chat = "";

  const A = "pairing and sign-in work with the gate on: two members join with their own apps and each signs in an AI account of their own through their own door";
  await J.step(A, async () => {
    grace = await joinOne({ w, team, who: "Grace" });
    edith = await joinOne({ w, team, who: "Edith" });
    installStandins();
    for (const p of [grace, edith]) {
      await signInThroughDoor(p, `${p.name}'s Codex`);
      const mine = await p.joined.call("accounts.list", [{ provider: "codex" }]);
      assert.equal(mine.length, 1, `${p.name} has one account: ${JSON.stringify(mine)}`);
      accounts[p.name] = mine[0];
    }
    return "Grace and Edith joined (pairing) and each signed in a Codex account (sign-in)";
  }, { needs, owner: "trust" });

  const C = "Grace starts a chat with the AI in it";
  await J.step(C, async () => {
    const made = await grace.joined.call("chat.create", [{ title: "Door gate", people: [edith.id], agents: ["assistant"] }]);
    chat = String(made.chat);
    await grace.joined.call("chat.reply-mode", [{ chat, mode: "every" }]);
    return chat;
  }, { needs: [A], owner: "chat" });

  /** What her session printed for one shell command: the stand-in agent's "walk-term" answer after her message. @param {string} cmd */
  const inHerSession = async (cmd) => {
    const before = (await framesOf(grace.joined, chat)).length;
    await grace.joined.call("chat.send", [{ chat, text: `@assistant walk-term:${cmd}`, to: ["assistant:assistant"], account: `codex:${accounts.Grace.id}` }]);
    for (let i = 0; i < 45; i++) {
      await sleep(4000);
      const f = await framesOf(grace.joined, chat);
      const hit = f.slice(before).find(x => x.type === "chat.text-delta" && /walk-term exit=/.test(String(x.data && x.data.text)));
      if (hit) return { cur: hit.cur, text: String(hit.data.text) };
    }
    throw new Error(`no answer from her session to: ${cmd}`);
  };

  const D = "(a) a member session's `vyre call` carries her session token: the owner's tools are refused in words, her own are served";
  await J.step(D, async () => {
    const out = [];
    const owners = [["connectors.connection.list", "{}", /owner's|owner or an admin/i], ["publish.create", '{"name":"x"}', /owner's|owner or an admin/i], ["spaces.members.set-role", '{"person":"per_x","role":"admin"}', /owner's|owner or an admin/i]];
    for (const [tool, args, words] of owners) {
      const r = await inHerSession(`vyre call ${tool} '${args}' 2>&1`);
      assert.match(r.text, /** @type {RegExp} */ (words), `${tool} is refused in words for a member: ${r.text.slice(0, 300)}`);
      assert.doesNotMatch(r.text, /"error":"no such tool"|no_such_tool/i, `${tool}: the gate refused it, not a missing tool: ${r.text.slice(0, 200)}`);
      out.push(`${tool} (frame ${r.cur}): ${r.text.replace(/\s+/g, " ").slice(0, 160)}`);
    }
    // her own tools, on the gate's list for a member, are served (the kernel judges them on her own chain)
    const mine = await inHerSession("vyre call records.types '{}' 2>&1");
    assert.doesNotMatch(mine.text, /This is the owner's|Ask the owner or an admin to do it for you/i, `records.types is hers: ${mine.text.slice(0, 300)}`);
    out.push(`records.types (frame ${mine.cur}): ${mine.text.replace(/\s+/g, " ").slice(0, 160)}`);
    return out.join(" | ");
  }, { needs: [C], owner: "trust" });

  const E = "the owner is unaffected: the same owner tools answer from the owner's own app";
  await J.step(E, async () => {
    const conns = await w.call("connectors.connection.list", {});
    assert.ok(conns, "the owner reads the connections");
    const info = await w.call("system.info", {});
    assert.ok(info, "and system.info");
    const members = await w.call("spaces.members.list", { space: team.space });
    assert.ok(members, "and the Space's members");
    return `connectors.connection.list ${JSON.stringify(conns).slice(0, 80)}; system.info ok; spaces.members.list ok`;
  }, { needs: [D], owner: "trust" });

  const F = "her sign-in still works after the refusals: Edith lists her own account and Grace cannot see it";
  await J.step(F, async () => {
    const mine = await edith.joined.call("accounts.list", [{ provider: "codex" }]);
    assert.equal(mine.length, 1);
    const graces = await grace.joined.call("accounts.list", [{ provider: "codex" }]);
    assert.ok(!graces.some((/** @type {any} */ a) => a.id === mine[0].id), "Grace does not see Edith's account");
    return "each member sees only their own account";
  }, { needs: [D], owner: "trust" });

  try { for (const p of [grace, edith]) p && p.app.close(); } catch { /* closed */ }
}
