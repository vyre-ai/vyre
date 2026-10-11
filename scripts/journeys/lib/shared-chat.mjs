// @ts-check
// J9's shared-chat steps (0.3.3 G03 and G04): on a real box made by the installer, a team of three, each with their own AI sign-in on the server, in ONE chat. Each member's message runs on that member's own
// account; every person sees the one history; the AI is handed what the others said; the chat's reply mode decides when the AI answers. Stand-in, labelled: the providers' login command and agent are the
// repo's test scripts (core/sessions/testing/fake-login.js, fake-acp.js) put on the box's PATH, since a walk spends no money and signs in to no real vendor. Everything else is the product: the installer's box,
// each member's own app and keys, the Space's kernel, the member door's accounts and chat services, the Switchboard, the spawner that runs each account as its own user.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BOX = "vyre-vyre-1";
const sh = (/** @type {string[]} */ args) => spawnSync("docker", args, { encoding: "utf8" });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/**
 * Put the stand-in Codex login and agent where the box's real ones are: the image's `codex` and `codex-acp` are links to the vendors' scripts, and the spawner starts only the programs those links resolve to,
 * so the stand-ins replace the scripts the links point at and the links stay as they are. As root, readable by every account's user. The box is torn down at the end of the walk.
 */
export function installStandins() {
  const found = [];
  for (const [file, name] of [["fake-login.js", "codex"], ["fake-acp.js", "codex-acp"]]) {
    const cp = sh(["cp", path.join(REPO, "core", "sessions", "testing", file), `${BOX}:/tmp/${file}`]);
    assert.equal(cp.status, 0, `docker cp ${file}: ${cp.stderr}`);
    const real = String(sh(["exec", BOX, "readlink", "-f", `/usr/local/bin/${name}`]).stdout).trim();
    assert.match(real, /^\/usr\/local\/lib\/node_modules\//, `${name} is the image's own script: ${real}`);
    const inst = sh(["exec", "-u", "root", BOX, "sh", "-c", `install -m 755 /tmp/${file} ${real}`]);
    assert.equal(inst.status, 0, `install ${name}: ${inst.stderr}`);
    found.push(real);
    // the agent's settings and its logs: Codex starts in "agent" and Vyre moves it to "workspace-write" (drivers/codex.js), and a walk that times out says what the agent received
    if (name === "codex-acp") {
      const env = "FAKE_ACP_START_MODE=agent\nFAKE_ACP_EXTRA_MODE=workspace-write\nFAKE_ACP_LOG=/work/fake-acp.log\nFAKE_ACP_RPC_LOG=/work/fake-acp-rpc.log\n";
      const w = sh(["exec", "-u", "root", BOX, "sh", "-c", `printf '%s' '${env}' > ${path.posix.dirname(real)}/fake-acp.env`]);
      assert.equal(w.status, 0, `the agent's settings: ${w.stderr}`);
      // /work belongs to the box's own user: the two log files are made as that user, open to every account
      const l = sh(["exec", "-u", "vyre", BOX, "sh", "-c", "install -m 666 /dev/null /work/fake-acp.log && install -m 666 /dev/null /work/fake-acp-rpc.log"]);
      assert.equal(l.status, 0, `the agent's logs: ${l.stderr}`);
    }
  }
  return found;
}

/**
 * A member signs a Codex login in through their own door and waits for it to finish.
 * @param {any} person @param {string} label
 */
export async function signInThroughDoor(person, label) {
  const first = await person.joined.call("accounts.signin", [{ provider: "codex", label }]);
  assert.equal(first.step, "code", `${label}: the provider's page and code are shown: ${JSON.stringify(first)}`);
  for (let i = 0; i < 40; i++) {
    const s = await person.joined.call("accounts.signin", [{ flow: first.flow }]);
    if (s.step === "done") return first;
    if (s.step === "failed") throw new Error(`${label}: the sign-in failed: ${JSON.stringify(s)}`);
    await sleep(3000);   // each call through the team's door is one stream: a member has 30 a minute
  }
  throw new Error(`${label}: the sign-in did not finish`);
}

/** The assistant's words in a chat as one person sees them. @param {any} person @param {string} chat */
async function seen(person, chat) {
  const r = await person.joined.call("chat.catchup", [{ chat }]);
  return /** @type {any[]} */ (r.messages || []);
}
const answers = (/** @type {any[]} */ ms) => ms.filter(m => /^assistant:/.test(String(m.author)));

/** What the server's own terminal says about the sessions, for a wait that timed out. */
let serverView = async () => "";
export const setServerView = (/** @type {() => Promise<string>} */ f) => { serverView = f; };

/** Wait until a person sees `n` answers from the AI; the list is what they saw. @param {any} person @param {string} chat @param {number} n */
async function untilAnswers(person, chat, n) {
  let got = /** @type {any[]} */ ([]);
  for (let i = 0; i < 40; i++) { got = answers(await seen(person, chat)); if (got.length >= n) return got; await sleep(4000); }
  throw new Error(`waited almost three minutes for answer ${n} in the chat; ${person.name} saw ${JSON.stringify(got.map(m => m.text))}${await serverView()}`);
}

/**
 * @param {{ J: any, w: any, team: any, people: any[], needs: string[] }} o  people: Grace and Edith, each { name, app, joined }
 */
export async function sharedChatSteps({ J, w, team, people, needs }) {
  const owner = { id: String(w.mac.identity.id) };
  const [grace, edith] = people;
  /** @type {string} */ let chat = "";
  setServerView(async () => {
    let more = "";
    try {
      const view = async (/** @type {any} */ p) => ({ who: p.name, messages: (await seen(p, chat)).map(m => [String(m.author).slice(0, 24), String(m.text).slice(0, 80)]) });
      more = ` | chat as seen ${JSON.stringify([await view(grace), await view(edith)])} | chat.get ${JSON.stringify(await grace.joined.call("chat.get", [{ chat }])).slice(0, 700)} | accounts ${JSON.stringify(await grace.joined.call("accounts.list", [{}]))}`;
    } catch (e) { more = ` | chat view unreadable: ${String(e && /** @type {any} */ (e).message)}`; }
    try {
      const l = await w.operator("threads.list", { all: true });
      const rows = (Array.isArray(l) ? l : l.threads || l.rows || []).slice(-6);
      const out = [];
      for (const r of rows) {
        const g = await w.operator("threads.get", { thread: r.id || r.thread, limit: 12 }).catch((/** @type {any} */ e) => ({ error: String(e && e.message) }));
        out.push({ id: r.id || r.thread, provider: r.provider, account: r.account, status: r.status, events: ((g && g.events) || []).slice(-8).map((/** @type {any} */ x) => [x.type, String((x.payload && (x.payload.text || x.payload.reason || x.payload.error || x.payload.to)) || "").slice(0, 100)]), error: g && g.error });
      }
      const agent = String(sh(["exec", BOX, "sh", "-c", "echo rpc:; cat /work/fake-acp-rpc.log; echo launches:; cut -c1-300 /work/fake-acp.log"]).stdout).split("\n").join(",").slice(0, 1500);
      return `${more} | agent ${agent} | server threads ${JSON.stringify(out)}`;
    } catch (e) { return `${more} | server threads unreadable: ${String(e && /** @type {any} */ (e).message)}`; }
  });
  const accounts = /** @type {Record<string, any>} */ ({});
  const A = "the box has a stand-in Codex login and agent for the walk";
  await J.step(A, () => installStandins().join(" "), { needs, owner: "release" });
  const B = "each member signs in an AI account of their own on the server, through their own door; no one else can list, use or remove it";
  await J.step(B, async () => {
    for (const p of people) {
      const label = `${p.name}'s Codex`;
      await signInThroughDoor(p, label);
      const mine = await p.joined.call("accounts.list", [{ provider: "codex" }]);
      assert.equal(mine.length, 1, `${p.name} has one account: ${JSON.stringify(mine)}`);
      assert.equal(mine[0].label, label);
      assert.equal(mine[0].person, p.app.identity.id, "the account is the member's own");
      accounts[p.name] = mine[0];
    }
    const other = await edith.joined.call("accounts.list", [{ provider: "codex" }]);
    assert.ok(!other.some((/** @type {any} */ a) => a.id === accounts[grace.name].id), "Edith does not see Grace's account");
    await assert.rejects(() => edith.joined.call("accounts.remove", [{ id: accounts[grace.name].id }]), /no account/, "Edith cannot remove Grace's account");
    const owners = await w.operator("sessions.accounts.list", { provider: "codex" });
    const rows = JSON.stringify(owners);
    for (const p of people) assert.ok(!rows.includes(accounts[p.name].id), `the owner's own list does not hold ${p.name}'s account`);
    assert.notEqual(accounts[grace.name].uid, accounts[edith.name].uid, "each account runs as its own user");
    return `${people.length} members, accounts run as users ${people.map(p => accounts[p.name].uid).join(" and ")}`;
  }, { needs: [...needs, A], owner: "projects-flows" });

  const C = "Grace starts one chat with Edith and the AI in it, and sets it so the AI answers every message";
  await J.step(C, async () => {
    const made = await grace.joined.call("chat.create", [{ title: "Team day", people: [edith.app.identity.id, owner.id], agents: ["assistant"] }]);
    chat = String(made.chat);
    assert.match(chat, /^chat_/);
    await grace.joined.call("chat.reply-mode", [{ chat, mode: "every" }]);
    const mine = (await edith.joined.call("chat.list", [{}])).chats || [];
    assert.ok(mine.some((/** @type {any} */ c) => c.chat === chat && c.open === true), "Edith is in it and sees it in her list");
    return chat;
  }, { needs: [B], owner: "chat" });

  const D = "each member's message is answered on that member's own account, and the second member's AI is handed what the first said";
  await J.step(D, async () => {
    const send = (/** @type {any} */ p, /** @type {string} */ text) => p.joined.call("chat.send", [{ chat, text, to: ["assistant:assistant"], account: `codex:${accounts[p.name].id}` }]);
    await send(grace, "The code word is AMBER-92. Then say whoami.");
    const first = await untilAnswers(edith, chat, 1);
    const g = String(first[0].text);
    assert.ok(g.includes(`/${accounts[grace.name].uid}`) && !g.includes(`/${accounts[edith.name].uid}`), `Grace's turn ran as Grace's account (user ${accounts[grace.name].uid}): ${g}`);
    await send(edith, "Edith here. whoami, and which code word did Grace give?");
    const second = await untilAnswers(grace, chat, 2);
    const e = String(second[1].text);
    if (e.includes(`/${accounts[grace.name].uid}`)) throw new Error(`Edith's turn did not run on her account (user ${accounts[edith.name].uid}); the answers Grace sees: ${JSON.stringify(second.map(m => [m.author, m.text]))}${await serverView()}`);
    assert.ok(e.includes(`/${accounts[edith.name].uid}`) && !e.includes(`/${accounts[grace.name].uid}`), `Edith's turn ran as Edith's account (user ${accounts[edith.name].uid}): ${e}`);
    assert.ok(e.includes("AMBER-92"), `Edith's AI was handed Grace's earlier words from the one shared history: ${e}`);
    return `Grace: ${g} | Edith: ${e}`;
  }, { needs: [C], owner: "chat" });

  const E = "everyone in the chat sees the one history: both people's words and both AI answers";
  await J.step(E, async () => {
    for (const p of people) {
      const other = p === grace ? edith : grace;
      const ms = await seen(p, chat);
      assert.ok(ms.some(m => String(m.text).includes(other === edith ? "Edith here" : "AMBER-92") && String(m.author).includes(other.app.identity.id)), `${p.name} reads ${other.name}'s message: ${JSON.stringify(ms.map(m => m.text))}`);
      assert.equal(answers(ms).length, 2, `${p.name} sees both AI answers`);
    }
    return "both members read the same two answers and each other's message";
  }, { needs: [D], owner: "chat" });

  const F = "switching the chat to answer when mentioned: a plain message gets no AI turn and an @mention does";
  await J.step(F, async () => {
    const set = await edith.joined.call("chat.reply-mode", [{ chat, mode: "mention" }]);
    assert.equal(set.mode, "mention");
    const before = answers(await seen(grace, chat)).length;
    await edith.joined.call("chat.send", [{ chat, text: "Grace, are you free after lunch?", account: `codex:${accounts[edith.name].id}` }]);
    await sleep(8000);
    assert.equal(answers(await seen(grace, chat)).length, before, "a plain message between people got no AI turn");
    await edith.joined.call("chat.send", [{ chat, text: "@assistant whoami", account: `codex:${accounts[edith.name].id}` }]);
    const after = await untilAnswers(grace, chat, before + 1);
    assert.ok(String(after[before].text).includes(`/${accounts[edith.name].uid}`), `the mention ran on Edith's account: ${after[before].text}`);
    return `answers ${before} to ${after.length}`;
  }, { needs: [D], owner: "chat" });

  const G = "the owner, who is in the chat too, reads the same history from their own app";
  await J.step(G, async () => {
    const r = await w.call("stream.catchup", { chat, space: team.space });
    const texts = /** @type {any[]} */ (r.messages || []).map(m => String(m.text));
    assert.ok(texts.some(t => t.includes("Edith here")) && texts.some(t => t.includes("home:")), `the owner reads the members' words and the AI's answers: ${JSON.stringify(texts)}`);
    return `${texts.length} messages`;
  }, { needs: [F], owner: "chat" });
}
