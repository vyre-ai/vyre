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
// (the stand-in agent answers "home: ..."; the lines Vyre says about a turn moving to a member's account are the assistant's too, and are not answers)
const answers = (/** @type {any[]} */ ms) => ms.filter(m => /^assistant:/.test(String(m.author)) && /^home: /.test(String(m.text)));

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
 * Wait until a person sees the AI's answer to ONE message: the assistant messages that come after the person's message `said` (matched by its words) and before the next person's message. Returns
 * those answers. A chat that shows one answer twice (two assistant messages for one turn) fails here, so this step can neither pass nor fail on a duplicate. @param {any} person @param {string} chat @param {string} said
 */
async function untilAnswerTo(person, chat, said) {
  let after = /** @type {any[]} */ ([]);
  for (let i = 0; i < 40; i++) {
    const ms = await seen(person, chat);
    const at = ms.findIndex(m => /^person:/.test(String(m.author)) && String(m.text).includes(said));
    if (at >= 0) {
      const next = ms.findIndex((m, k) => k > at && /^person:/.test(String(m.author)));
      after = answers(ms.slice(at + 1, next < 0 ? undefined : next));
      if (after.length >= 1) { await sleep(3000); const again = await seen(person, chat); const a2 = again.findIndex(m => /^person:/.test(String(m.author)) && String(m.text).includes(said)); const n2 = again.findIndex((m, k) => k > a2 && /^person:/.test(String(m.author))); return answers(again.slice(a2 + 1, n2 < 0 ? undefined : n2)); }
    }
    await sleep(4000);
  }
  throw new Error(`waited almost three minutes for the answer to "${said}"; ${person.name} saw ${JSON.stringify(after.map(m => m.text))}${await serverView()}`);
}

/**
 * @param {{ J: any, w: any, team: any, people: any[], needs: string[] }} o  people: Grace and Edith, each { name, app, joined }
 */
export async function sharedChatSteps({ J, w, team, people, needs }) {
  const owner = { id: String(w.mac.identity.id) };
  const [grace, edith] = people;
  /** @type {string} */ let chat = "";
  let ownerAcctId = "";
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

  const T = "each member's FIRST chat.create into the team Space (the first call into a module there can take about 30 s): the time of each";
  await J.step(T, async () => {
    const ms = [];
    for (const p of people) { const t0 = Date.now(); const c = await p.joined.call("chat.create", [{ title: `${p.name}'s notes` }]); assert.match(String(c.chat), /^chat_/); ms.push(`${p.name} ${Date.now() - t0} ms`); }
    return ms.join(", ");
  }, { needs: [B], owner: "chat" });
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
    const first = await untilAnswerTo(edith, chat, "The code word is AMBER-92");
    assert.equal(first.length, 1, `Grace's turn is answered once, not ${first.length} times: ${JSON.stringify(first.map(m => m.text))}`);
    const g = String(first[0].text);
    assert.ok(g.includes(`/${accounts[grace.name].uid}`) && !g.includes(`/${accounts[edith.name].uid}`), `Grace's turn ran as Grace's account (user ${accounts[grace.name].uid}): ${g}`);
    await send(edith, "Edith here. whoami, and which code word did Grace give?");
    const second = await untilAnswerTo(grace, chat, "Edith here");
    assert.equal(second.length, 1, `Edith's turn is answered once, not ${second.length} times: ${JSON.stringify(second.map(m => m.text))}`);
    const e = String(second[0].text);
    if (e.includes(`/${accounts[grace.name].uid}`)) throw new Error(`Edith's turn did not run on her account (user ${accounts[edith.name].uid}); the answer Grace sees to her message: ${JSON.stringify(e)}${await serverView()}`);
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
    assert.ok(texts.some(t => t.includes("Edith here")) && texts.some(t => t.startsWith("home: ")), `the owner reads the members' words and the AI's answers: ${JSON.stringify(texts)}`);
    return `${texts.length} messages`;
  }, { needs: [F], owner: "chat" });

  const H = "the owner signs in their own AI and sends one message that gets a turn on the owner's own account";
  await J.step(H, async () => {
    // the owner's account is the home's own: signed in at the server's terminal, as the owner's sign-in always is
    const first = await w.operator("sessions.accounts.signin", { provider: "codex", label: "Owner's Codex" });
    assert.equal(first.step, "code", JSON.stringify(first));
    for (let i = 0; i < 40; i++) { const st = await w.operator("sessions.accounts.signin", { flow: first.flow }); if (st.step === "done") break; if (st.step === "failed") throw new Error(`the owner's sign-in failed: ${JSON.stringify(st)}`); await sleep(3000); }
    const mine = (await w.operator("sessions.accounts.list", { provider: "codex" })).find((/** @type {any} */ a) => a.label === "Owner's Codex");
    assert.ok(mine && mine.uid != null, "the owner's account exists and runs as a user of its own");
    for (const p of people) assert.notEqual(mine.uid, accounts[p.name].uid, "and it is not a member's");
    ownerAcctId = mine.id;
    await w.call("stream.send", { chat, space: team.space, text: "@assistant whoami, owner here", to: ["assistant:assistant"], account: `codex:${mine.id}` });
    let got = "";
    for (let i = 0; i < 40 && !got; i++) { await sleep(4000); got = String((answers(await seen(grace, chat)).find(m => String(m.text).includes(`/${mine.uid}`)) || {}).text || ""); }
    assert.ok(got, `the owner's turn answered on the owner's account (user ${mine.uid})`);
    assert.ok(!got.includes(`/${accounts[grace.name].uid}`) && !got.includes(`/${accounts[edith.name].uid}`), `and on no member's: ${got}`);
    return got;
  }, { needs: [G], owner: "chat" });

  // ---- the vault and the folders, from a MEMBER's own session on the server (rc1-a's steps; the owner's session is the control)
  const I = "from a member's session: the daemon's main socket is closed to them, the owner's vault answers a refusal in words and shows no item name, and another chat's folder cannot be listed";
  await J.step(I, async () => {
    const itemName = "walk-owner-item";
    await w.operator("vault.put", { name: itemName, kind: "secret", value: "WALK-NOT-A-REAL-VALUE" });
    const transcript = /** @type {string[]} */ ([]);
    const note = (/** @type {string} */ who, /** @type {string} */ cmd, /** @type {string} */ out) => transcript.push(`${who}$ ${cmd}\n${out}\n`);
    // answers() only counts the "home:" lines of the stand-in; the terminal answers are "walk-term ..." lines, counted here
    const walkTerms = async () => (await seen(grace, chat)).filter(m => /^assistant:/.test(String(m.author)) && /^walk-term/.test(String(m.text)));
    const R = async (/** @type {any} */ who, /** @type {string} */ cmd) => {
      const known = new Set((await walkTerms()).map(m => m.message));
      await (who === "owner" ? w.call("stream.send", { chat, space: team.space, text: `@assistant walk-term:${cmd}`, to: ["assistant:assistant"], account: `codex:${ownerAcctId}` }) : edith.joined.call("chat.send", [{ chat, text: `@assistant walk-term:${cmd}`, to: ["assistant:assistant"], account: `codex:${accounts[edith.name].id}` }]));
      for (let i = 0; i < 40; i++) { await sleep(4000); const fresh = (await walkTerms()).filter(m => !known.has(m.message)); if (fresh.length) { const out = String(fresh[0].text); note(who, cmd, out); return out; } }
      throw new Error(`no answer to ${cmd} from ${who}`);
    };
    const sock = "$(ls /home/vyre/.vyre/vyred.sock 2>/dev/null || echo /home/vyre/.vyre/vyred.sock)";
    const net = (/** @type {string} */ p) => `node -e 'require("net").connect(${JSON.stringify(p)}).on("connect",()=>{console.log("CONNECTED");process.exit(0)}).on("error",e=>{console.log("ERR "+e.code);process.exit(2)})'`;
    const s1 = await R("member", net("/home/vyre/.vyre/vyred.sock"));
    assert.match(s1, /ERR (EACCES|EPERM|ENOENT)/, `the member cannot open the daemon's main socket: ${s1}`);
    assert.doesNotMatch(s1, /CONNECTED/);
    const s2 = await R("member", "vyre vault list 2>&1");
    assert.match(s2, /owner's vault/, `vault list is refused in words: ${s2}`);
    assert.ok(!s2.includes(itemName), "and shows no item name");
    const s3 = await R("member", `vyre vault reveal ${itemName} 2>&1`);
    assert.match(s3, /owner's vault/, `vault reveal is refused in words: ${s3}`);
    assert.ok(!s3.includes("WALK-NOT-A-REAL-VALUE"), "and no value");
    const s4 = await R("member", "vyre vault put walkx 2>&1 < /dev/null; vyre vault lock 2>&1");
    assert.match(s4, /owner's vault/, `vault put and lock are refused: ${s4}`);
    // folders: another chat's parent cannot be listed by a member's session, and the walk's own chat folder is not named by its id
    const s5 = await R("member", "ls /work/chats 2>&1; ls /work/chats/* 2>&1");
    assert.match(s5, /Permission denied/i, `a session cannot list the chats' parents: ${s5}`);
    // control: the owner's own session lists the vault
    const c1 = await R("owner", "vyre vault list 2>&1");
    assert.ok(c1.includes(itemName), `the owner's session lists the owner's vault: ${c1}`);
    const still = await w.operator("vault.list", {});
    assert.ok(JSON.stringify(still).includes(itemName), "the item is unchanged and the vault is not locked");
    await w.operator("vault.delete", { name: itemName }).catch(() => {});
    return transcript.join("\n");
  }, { needs: [H], owner: "chat" });
}
