// @ts-check
// J11's steps (0.3.3 rc.3, work/rc3/member-store): what a MEMBER sees and does on a real paired team server, proven from the stream and the door's own answers, with frame numbers. A member's turn raises a
// permission question and she answers it from the member route; the other member who knows its id is refused; an outsider is refused; she stops her own turn and not the other member's; the owner and an admin stop a
// member's turn; the held message says whose question it waits on; Teammates, Sites and the project story show a member only her projects. Stand-in, labelled: the provider's login and agent are the repo's test scripts
// (core/sessions/testing/fake-login.js, fake-acp.js) put on the box's PATH, as in J9; a walk spends no money. Everything else is the product (the installer's box, each person's own app and keys, the Space's kernel,
// the member door, the Switchboard, the spawner).
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createApp } from "../../lib/proof/app.mjs";
import { installStandins, signInThroughDoor } from "./shared-chat.mjs";
import { createFolder } from "../../../apps/app/src/chat/frames.js";
import { waitLine, createGroup } from "../../../apps/app/src/chat/group.js";
import { NOT_FOR_MEMBERS_YET, isTeamWork, memberWire } from "../../../apps/app/src/real/with-space.js";

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const chainOf = (/** @type {string} */ space, /** @type {string} */ person) => ({ space, hops: [{ actor: { kind: "person", id: person, space } }] });

/** One person joins the team Space with their own app, as the owner invites them. @param {{ w: any, team: any, who: string, role?: string }} o */
export async function joinOne({ w, team, who, role = "member" }) {
  const { mac, ins } = w;
  const app = createApp({ label: `Member day ${who}`, dir: path.join(w.dir, who.toLowerCase()), directory: ins.names, relay: ins.relay });
  const r = await app.reserve(`${who.toLowerCase()}${Math.random().toString(36).slice(2, 6)}`);
  await app.becomeYourself({ name: r.name, code: r.code });
  const owner = chainOf(team.space, mac.identity.id);
  const invite = await mac.makeTeamInvite({ space: team.space, name: team.label, to: r.name, role, signPresence: async (/** @type {any} */ card) => mac.presenceSigner.proof(owner, card.op, card.fields, { extra: { home: card.home, challenge: card.challenge } }) });
  invite.close();
  const sg = app.presenceSigner, chain = chainOf(team.space, app.identity.id);
  const joined = await app.joinTeam({ link: invite.link, signPresence: async (/** @type {any} */ req) => sg.proof(chain, req.op, req.fields), presenceKey: async () => sg.enrolment(app.identity.id) });
  assert.equal(joined.joined.joined, true, `${who} joined`);
  return { name: who, app, invite, joined, id: String(app.identity.id) };
}

/** Every frame of a chat a person may read, from the start, as the member door gives it (pages of 200). @param {{ call: (c: string, a: any[]) => Promise<any> }} joined @param {string} chat */
export async function framesOf(joined, chat) {
  /** @type {any[]} */ const out = [];
  let from = 0;
  for (let i = 0; i < 50; i++) {
    const r = await joined.call("chat.read", [{ chat, from, limit: 200 }]);
    out.push(...(r.frames || []));
    if (!r.frames || r.frames.length < 200 || r.next <= from) break;
    from = r.next;
  }
  return out;
}

/** @param {any[]} frames */ const asks = (frames) => frames.filter(f => f.type === "chat.ask");
/** @param {any[]} frames @param {string} id */ const answeredOf = (frames, id) => frames.find(f => f.type === "chat.ask-answered" && f.data && f.data.ask_id === id);
const cur = (/** @type {any} */ f) => (f ? f.cur : "none");

/**
 * @param {{ J: any, w: any, team: any, needs: string[] }} o
 */
export async function memberDaySteps({ J, w, team, needs }) {
  const owner = { id: String(w.mac.identity.id) };
  /** @type {any} */ let grace, edith, frank;
  /** @type {Record<string, any>} */ const accounts = {};
  /** @type {string} */ let chat = "", chat2 = "";

  const A = "the owner, an admin and two members are on the team Space, and each member has an AI account of their own";
  await J.step(A, async () => {
    grace = await joinOne({ w, team, who: "Grace" });
    edith = await joinOne({ w, team, who: "Edith" });
    frank = await joinOne({ w, team, who: "Frank", role: "admin" });
    const rows = (p) => p.joined.call("grants.members.list", []).then((/** @type {any} */ l) => (Array.isArray(l) ? l : l.members || []));
    const fr = (await rows(frank)).find((/** @type {any} */ m) => (m.person || m.id) === frank.id);
    assert.ok(fr && fr.role === "admin", `Frank is an admin: ${JSON.stringify(fr)}`);
    installStandins();
    for (const p of [grace, edith]) {
      await signInThroughDoor(p, `${p.name}'s Codex`);
      const mine = await p.joined.call("accounts.list", [{ provider: "codex" }]);
      assert.equal(mine.length, 1);
      accounts[p.name] = mine[0];
    }
    return "owner, Frank (admin), Grace and Edith (members)";
  }, { needs, owner: "projects-flows" });

  const C = "Grace starts a chat with Edith, the owner and the AI (Frank, the admin, is not in it); the AI answers every message";
  await J.step(C, async () => {
    const made = await grace.joined.call("chat.create", [{ title: "Member day", people: [edith.id, owner.id], agents: ["assistant"] }]);
    chat = String(made.chat);
    await grace.joined.call("chat.reply-mode", [{ chat, mode: "every" }]);
    return chat;
  }, { needs: [A], owner: "chat" });

  const send = (/** @type {any} */ p, /** @type {string} */ text, /** @type {any} */ extra = {}, /** @type {string} */ c = chat) =>
    p.joined.call("chat.send", [{ chat: c, text, to: ["assistant:assistant"], account: `codex:${accounts[p.name].id}`, ...extra }]);
  const openAsk = async (/** @type {any} */ viewer, /** @type {string} */ c = chat, /** @type {string[]} */ not = []) => {
    for (let i = 0; i < 45; i++) {
      const f = await framesOf(viewer.joined, c);
      const a = asks(f).filter(x => !answeredOf(f, x.data.ask_id) && !not.includes(x.data.ask_id)).pop();
      if (a) return a;
      await sleep(4000);
    }
    throw new Error("no open question appeared in the chat");
  };

  // (1) allow
  const S1 = "(1) Grace's turn raises a permission question; she answers allow from the member route; her turn runs, and her message queued behind it runs too";
  /** @type {any} */ let ask1 = null;
  await J.step(S1, async () => {
    await send(grace, "bash ls");
    ask1 = await openAsk(grace);
    assert.equal(ask1.acts_for, `person:${grace.id}`, "the question names Grace as the person whose turn it is");
    await send(grace, "after the question, say hello", { mode: "queue" });
    // the other member and the owner see the question as someone else's (the frame carries the asker)
    const eFrames = await framesOf(edith.joined, chat);
    const eAsk = asks(eFrames).find(x => x.data.ask_id === ask1.data.ask_id);
    assert.ok(eAsk && eAsk.acts_for === `person:${grace.id}`, "Edith sees the same question, as Grace's");
    const r = await grace.joined.call("chat.answer", [{ chat, ask: ask1.data.ask_id, decision: "allow" }]);
    assert.ok(r && r.answered !== false, `the answer: ${JSON.stringify(r)}`);
    const again = await grace.joined.call("chat.answer", [{ chat, ask: ask1.data.ask_id, decision: "allow" }]);
    assert.ok(again, "the same answer again is the first one, not a failure");
    let done = null, hello = null;
    for (let i = 0; i < 45 && !(done && hello); i++) {
      const f = await framesOf(grace.joined, chat);
      done = answeredOf(f, ask1.data.ask_id);
      hello = f.find(x => /^assistant:/.test(String(x.author)) && /after the question|hello/i.test(JSON.stringify(x.data || {})) && x.cur > (done ? done.cur : 1e9) - 1e9);
      if (!(done && hello)) await sleep(4000);
    }
    assert.ok(done, "the question frame was answered");
    const f = await framesOf(grace.joined, chat);
    const ran = f.some(x => /^assistant:/.test(String(x.author)) && /Ran it/i.test(JSON.stringify(x.data || {})));
    assert.ok(ran, "her turn ran: the AI says it ran the command");
    const after = f.filter(x => x.type === "chat.user-message" && /after the question/.test(String(x.data && x.data.text)));
    assert.ok(after.length >= 1, "her queued message is in the log");
    const answeredAfter = f.some(x => /^assistant:/.test(String(x.author)) && x.cur > cur(after[after.length - 1]) && /home: /.test(JSON.stringify(x.data || {})));
    assert.ok(answeredAfter, "and the AI answered it after the question was closed");
    return `question frame ${cur(ask1)} (acts_for Grace), answered at frame ${cur(done)}, her queued message frame ${cur(after[0])}`;
  }, { needs: [C], owner: "chat" });

  // (2) deny
  const S2 = "(2) she answers deny to a second question; the room sees it";
  await J.step(S2, async () => {
    await send(grace, "bash pwd");
    const ask2 = await openAsk(grace, chat, [ask1.data.ask_id]);
    const r = await grace.joined.call("chat.answer", [{ chat, ask: ask2.data.ask_id, decision: "deny" }]);
    assert.ok(r && r.answered !== false, JSON.stringify(r));
    let ans = null;
    for (let i = 0; i < 30 && !ans; i++) { const f = await framesOf(edith.joined, chat); ans = answeredOf(f, ask2.data.ask_id); if (!ans) await sleep(3000); }
    assert.ok(ans, "Edith sees the question answered");
    assert.equal(ans.data.decision, "deny", `the room sees deny: ${JSON.stringify(ans.data)}`);
    return `question frame ${cur(ask2)}, deny seen by Edith at frame ${cur(ans)}`;
  }, { needs: [S1], owner: "chat" });

  // (3) the other member and an outsider
  const S3 = "(3) Edith, who knows the question's id, is refused and it stays open; Frank, who is not in the chat, is refused";
  /** @type {any} */ let ask3 = null;
  await J.step(S3, async () => {
    await send(grace, "bash id");
    ask3 = await openAsk(grace, chat, [ask1.data.ask_id]);
    const bad = await edith.joined.call("chat.answer", [{ chat, ask: ask3.data.ask_id, decision: "allow" }]).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(bad && /whose turn|ask them/i.test(String(bad.message)), `Edith is refused in words: ${bad && bad.message}`);
    const out = await frank.joined.call("chat.answer", [{ chat, ask: ask3.data.ask_id, decision: "allow" }]).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(out && /no such|not.?found|chat/i.test(String(out.code) + String(out.message)), `Frank, outside the chat, is refused: ${out && out.code} ${out && out.message}`);
    const f = await framesOf(grace.joined, chat);
    assert.equal(answeredOf(f, ask3.data.ask_id), undefined, "the question stays open after both refusals");
    return `Edith: "${bad.message}"; Frank: ${out.code} "${out.message}"; question frame ${cur(ask3)} still open`;
  }, { needs: [S2], owner: "trust" });

  // (4) stops
  const S4 = "(4) Edith cannot stop Grace's turn; Grace stops her own; the owner stops a member's turn; the admin stops a member's turn";
  await J.step(S4, async () => {
    const e = await edith.joined.call("chat.stop", [{ chat }]);
    assert.equal(e.stopped.length, 0, `Edith stops nothing of Grace's: ${JSON.stringify(e)}`);
    assert.ok(e.left >= 1, "Grace's turn is still running");
    const g = await grace.joined.call("chat.stop", [{ chat }]);
    assert.ok(g.stopped.length >= 1, `Grace stops her own turn: ${JSON.stringify(g)}`);
    // the owner stops a member's turn
    await send(grace, "bash whoami");
    await openAsk(grace, chat, [ask1.data.ask_id, ask3.data.ask_id]);
    const o = await w.call("stream.stop", { chat, space: team.space });
    assert.ok(o.stopped.length >= 1, `the owner stops Grace's turn: ${JSON.stringify(o)}`);
    // the admin, in a chat he is in, stops a member's turn
    const made2 = await grace.joined.call("chat.create", [{ title: "Member day with the admin", people: [frank.id, edith.id], agents: ["assistant"] }]);
    chat2 = String(made2.chat);
    await grace.joined.call("chat.reply-mode", [{ chat: chat2, mode: "every" }]);
    await send(grace, "bash date", {}, chat2);
    await openAsk(grace, chat2);
    const a = await frank.joined.call("chat.stop", [{ chat: chat2 }]);
    assert.ok(a.stopped.length >= 1, `the admin stops Grace's turn: ${JSON.stringify(a)}`);
    return `Edith ${JSON.stringify(e)}; Grace ${JSON.stringify(g)}; owner ${JSON.stringify(o)}; admin ${JSON.stringify(a)}`;
  }, { needs: [S3], owner: "chat" });

  // (5) the held message says whose question it waits on
  const S5 = "(5) a message queued behind another person's question reads \"waiting for <name> to answer a question\" for its sender";
  await J.step(S5, async () => {
    await send(grace, "bash echo held");
    const ask5 = await openAsk(edith, chat, [ask1.data.ask_id, ask3.data.ask_id]);
    await send(edith, "my message waits behind Grace's question", { mode: "queue" });
    await sleep(3000);
    // Edith's app: the frames the member door gives her, folded by the app's own folder and group, then the line the queue strip would read
    const frames = await framesOf(edith.joined, chat);
    const viewer = `person:${edith.id}`;
    const group = createGroup(viewer);
    const folder = createFolder();
    for (const f of frames) { try { group.apply(f); } catch { /* the group draws only some frames */ } try { folder.apply(f); } catch { /* a frame kind the folder does not draw */ } }
    const open = folder.openAsks();
    const line = waitLine({ open, asker: (/** @type {string} */ a) => group.asker(a), viewer, names: { [`person:${grace.id}`]: "Grace" } });
    assert.equal(line, "waiting for Grace to answer a question", `the line Edith reads: ${line}; open ${JSON.stringify(open)}`);
    // let it go: Grace denies
    await grace.joined.call("chat.answer", [{ chat, ask: ask5.data.ask_id, decision: "deny" }]);
    return `Edith's queued message waits behind the question at frame ${cur(ask5)} (acts_for Grace); her queue strip reads "${line}"`;
  }, { needs: [S4], owner: "chat" });

  // (6) Teammates, (8) the project story: Grace and Edith each start a project; the owner puts a teammate on each
  /** @type {any} */ let pg = null, pe = null;
  const S6 = "(6) Grace and Edith each start a project and the owner puts a teammate on each; Grace sees the teammates of her project only, Edith's project is not found for her, the owner sees both";
  await J.step(S6, async () => {
    pg = await grace.joined.call("work.project-create", [{ name: "Grace's matter" }]);
    pe = await edith.joined.call("work.project-create", [{ name: "Edith's matter" }]);
    for (const [p, role] of [[pg, "reviewer"], [pe, "drafter"]]) await w.call("team.add", { project: p.project, role, brief: `PRIVATE BRIEF for ${role}`, space: team.space });
    const mine = await grace.joined.call("team.list", [{}]);
    assert.deepEqual((mine.teammates || []).map((/** @type {any} */ t) => t.role), ["reviewer"], `Grace's teammates: ${JSON.stringify(mine)}`);
    assert.deepEqual(Object.keys(mine.teammates[0]).sort(), ["agent", "project", "role", "state"]);
    assert.ok(!JSON.stringify(mine).includes("PRIVATE BRIEF"), "no brief");
    const other = await grace.joined.call("team.list", [{ project: pe.slug }]).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(other && /not.?found|no project/i.test(String(other.code) + String(other.message)), `Edith's project is not found for Grace: ${other && other.code} ${other && other.message}`);
    const all = await w.call("team.list", { all: true, space: team.space });
    const roles = (Array.isArray(all) ? all : all.teammates || []).map((/** @type {any} */ t) => t.role).sort();
    assert.ok(roles.includes("reviewer") && roles.includes("drafter"), `the owner sees both: ${JSON.stringify(roles)}`);
    return `Grace: ${JSON.stringify(mine.teammates)}; Edith's project for Grace: ${other.code}; owner roles ${roles.join(", ")}`;
  }, { needs: [S5], owner: "projects-flows" });

  const S8 = "(8) the project's story through the door: Grace reads her project's, not Edith's";
  await J.step(S8, async () => {
    const hers = await grace.joined.call("work.timeline", [{ project: pg.slug }]);
    assert.ok(Array.isArray(hers.entries), `Grace reads her story: ${JSON.stringify(hers).slice(0, 200)}`);
    const theirs = await grace.joined.call("work.timeline", [{ project: pe.slug }]).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(theirs && /not.?found|no such project/i.test(String(theirs.code) + String(theirs.message)), `Edith's story is not Grace's: ${theirs && theirs.code} ${theirs && theirs.message}`);
    return `hers: ${hers.entries.length} entries; Edith's: ${theirs.code} "${theirs.message}"`;
  }, { needs: [S6], owner: "projects-flows" });

  // (7) Sites
  const S7 = "(7) Sites: Grace sees only her project's site; a draft shows no address; every other publish call is refused in words";
  await J.step(S7, async () => {
    const dir = "/tmp/member-day-site";
    const prep = spawnSync("docker", ["exec", "-u", "vyre", "vyre-vyre-1", "sh", "-c", `mkdir -p ${dir} && echo "<h1>site</h1>" > ${dir}/index.html`], { encoding: "utf8" });
    assert.equal(prep.status, 0, `a folder for the site on the box: ${prep.stderr}`);
    const mk = (/** @type {string} */ name, /** @type {any} */ project) => w.call("publish.create", { name, source: { kind: "folder", ref: dir }, build: { image: "static" }, project: project.project, space: team.space });
    await mk("grace-site", pg); await mk("edith-site", pe);
    const list = await grace.joined.call("publish.list", [{}]);
    const names = (list.sites || []).map((/** @type {any} */ s) => s.name);
    assert.deepEqual(names, ["grace-site"], `Grace sees her project's site only: ${JSON.stringify(list)}`);
    assert.equal(list.sites[0].url, null, "a draft shows no address");
    assert.deepEqual(Object.keys(list.sites[0]).sort(), ["name", "project", "stage", "url"]);
    const status = await grace.joined.call("publish.status", [{ deployment: "grace-site" }]).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(status, "the team's door has no other publish call for a member");
    // the app's own route says it in words
    assert.ok(isTeamWork("publish.status") && memberWire("publish.status") === null, "the app refuses publish.status for a joined member");
    assert.match(NOT_FOR_MEMBERS_YET, /Ask the owner/);
    return `Grace's sites: ${JSON.stringify(list.sites)}; publish.status through the door: ${status.code}; the app says: "${NOT_FOR_MEMBERS_YET}"`;
  }, { needs: [S6], owner: "projects-flows" });

  try { for (const p of [grace, edith, frank]) p && p.app.close(); } catch { /* closed */ }
}
