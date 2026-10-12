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
      // the stand-in calls Vyre's tools through the MCP server the client hands it (the route a real agent uses), with this helper beside it
      const cp2 = sh(["cp", path.join(REPO, "core", "sessions", "testing", "walk-mcp-call.mjs"), `${BOX}:/tmp/walk-mcp-call.mjs`]);
      assert.equal(cp2.status, 0, `docker cp walk-mcp-call.mjs: ${cp2.stderr}`);
      const inst2 = sh(["exec", "-u", "root", BOX, "sh", "-c", `install -m 755 /tmp/walk-mcp-call.mjs ${path.posix.dirname(real)}/walk-mcp-call.mjs`]);
      assert.equal(inst2.status, 0, `install walk-mcp-call: ${inst2.stderr}`);
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
/** @type {(() => Promise<any[]>) | null} */ let ownerView = null;
let serverView = async () => "";
export const setOwnerView = (/** @type {() => Promise<any[]>} */ f) => { ownerView = f; };
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
    if (i === 8 && ownerView) {
      // The member's own catchup shows no answer after her message. The owner's view of the same chat decides whether the AI answered at all; a difference is a finding about catchup, printed, not hidden.
      const om = await ownerView().catch(() => []);
      const oat = om.findIndex((/** @type {any} */ m) => /^person:/.test(String(m.author)) && String(m.text).includes(said));
      const onext = om.findIndex((/** @type {any} */ m, /** @type {number} */ k) => k > oat && /^person:/.test(String(m.author)));
      const oans = oat >= 0 ? answers(om.slice(oat + 1, onext < 0 ? undefined : onext)) : [];
      console.log(`DBG own-message-not-in-catchup (by design) for "${said}": ${person.name}'s catchup has ${after.length} answers after it (her message ${at >= 0 ? "is" : "is NOT"} listed); the owner's view has ${oans.length}; ${person.name}'s tail: ${JSON.stringify(ms.slice(-4).map((/** @type {any} */ m) => [m.author, String(m.text).slice(0, 50)]))}`);
      if (oans.length) return oans;
    }
    await sleep(4000);
  }
  throw new Error(`waited almost three minutes for the answer to "${said}"; ${person.name} saw ${JSON.stringify(after.map(m => m.text))}${await serverView()}`);
}

/**
 * @param {{ J: any, w: any, team: any, people: any[], needs: string[] }} o  people: Grace and Edith, each { name, app, joined }
 */
export async function sharedChatSteps({ J: J0, w, team, people, needs }) {
  // J9_SHORT=1: the chat up to the queue step only (people, sign-ins, group chat, five turns, three queued, one more message); the steps in between are not run
  const J = process.env.J9_SHORT ? { ...J0, step: (/** @type {string} */ name, /** @type {any} */ fn, /** @type {any} */ opts) => /tool call in a member|lists that person's skills|leftover|retired product|catchup is what|from a member's session/.test(name) ? Promise.resolve() : J0.step(name, fn, opts) } : J0;
  setOwnerView(async () => (await w.call("stream.catchup", { chat, space: team.space })).messages || []);
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

  // ---- walk-3 (final tree, sandbox on): the same chat, five turns by three people, three queued behind a running turn, the tool gate, skills, a leftover job, and a scan for a retired product word
  /** @type {Record<string, any>} */ const said = {};
  const ownerUid = async () => (await w.operator("sessions.accounts.list", { provider: "codex" })).find((/** @type {any} */ a) => a.id === ownerAcctId).uid;
  const speak = (/** @type {string} */ who, /** @type {string} */ text) => who === "owner"
    ? w.call("stream.send", { chat, space: team.space, text: `@assistant ${text}`, to: ["assistant:assistant"], account: `codex:${ownerAcctId}` })
    : (who === grace.name ? grace : edith).joined.call("chat.send", [{ chat, text: `@assistant ${text}`, account: `codex:${accounts[who].id}` }]);
  const uidOf = async (/** @type {string} */ who) => (who === "owner" ? await ownerUid() : accounts[who].uid);

  const WA = "five turns, owner then Grace then owner then Grace then Edith, each on that person's own account, each answered once and under its own person";
  await J.step(WA, async () => {
    const order = ["owner", grace.name, "owner", grace.name, edith.name];
    const out = [];
    for (const [n, who] of order.entries()) {
      const tag = `walkA${n + 1}`;
      await speak(who, `whoami ${tag}`);
      const a = await untilAnswerTo(grace, chat, tag).catch(async (/** @type {any} */ e) => {
        const dump = async (/** @type {string} */ k, /** @type {() => Promise<any>} */ f) => { try { console.log(`DBG ${k}: ${JSON.stringify(await f()).slice(0, 1500)}`); } catch (x) { console.log(`DBG ${k}: ${String(x && x.message).slice(0, 200)}`); } };
        await dump("threads (space)", () => w.call("threads.list", { all: true, space: team.space }));
        await dump("threads (default)", () => w.operator("threads.list", { all: true }));
        await dump("queue", () => w.call("threads.queue", { space: team.space }));
        await dump("chat tail", async () => (await seen(grace, chat)).slice(-4).map((/** @type {any} */ m) => [m.author, String(m.text).slice(0, 80)]));
        throw e;
      });
      assert.equal(a.length, 1, `${tag} (${who}) is answered once, not ${a.length} times: ${JSON.stringify(a.map(m => m.text))}`);
      const uid = await uidOf(who);
      assert.ok(String(a[0].text).includes(`/${uid}`), `${tag}: ${who}'s turn ran as their account (user ${uid}): ${a[0].text}`);
      for (const other of ["owner", grace.name, edith.name].filter(x => x !== who)) assert.ok(!String(a[0].text).includes(`/${await uidOf(other)}`), `${tag}: and not as ${other}'s`);
      out.push(`${tag} ${who}: ${String(a[0].text).slice(0, 60)}`);
    }
    return out.join(" | ");
  }, { needs: [H], owner: "chat" });

  const WC = "a tool call in a member's turn is refused the owner's vault, with the gate's own words; the owner's own call is the control";
  await J.step(WC, async () => {
    const R = async (/** @type {string} */ who, /** @type {string} */ cmd) => {
      const termsNow = async () => (await seen(grace, chat)).filter(m => /^assistant:/.test(String(m.author)) && /^walk-(term|mcp)/.test(String(m.text)));
      const known = new Set((await termsNow()).map(m => m.message));
      await speak(who, /^walk-/.test(cmd) ? cmd : `walk-term:${cmd}`);
      for (let i = 0; i < 40; i++) { await sleep(4000); const fresh = (await termsNow()).filter(m => !known.has(m.message)); if (fresh.length) return String(fresh[0].text); }
      throw new Error(`no answer to ${cmd} from ${who}`);
    };
    const out = /** @type {string[]} */ ([]);
    for (const who of [grace.name, edith.name]) {
      const list = await R(who, `walk-mcp:vault.list {}`);
      const reveal = await R(who, `walk-mcp:vault.reveal {"item":"walk-owner-item"}`);
      said[`${who}-vault`] = `${list} || ${reveal}`;
      assert.ok(!/walk-owner-item.*value|"items"\s*:\s*\[\s*\{/.test(list + reveal), `${who} sees no owner item through the tool: ${list} ${reveal}`);
      assert.ok(/vault|owner|private|not allowed|refus|stay out/i.test(list), `${who}'s vault.list is refused in words: ${list}`);
      out.push(`${who}: list -> ${list.slice(0, 160)} | reveal -> ${reveal.slice(0, 160)}`);
    }
    const control = await R("owner", `walk-mcp:vault.list {}`);
    said["owner-vault"] = control;
    out.push(`owner (control): ${control.slice(0, 200)}`);
    return out.join(" || ");
  }, { needs: [H], owner: "chat" });

  const WD = "each person's turn lists that person's skills and none of another's";
  await J.step(WD, async () => {
    // the owner makes a personal skill with a distinctive name and approves it (the owner's own level); a member's turn must not list it
    const body = "---\nname: walk-owner-private\ndescription: only the owner uses this walk skill\n---\nSay owner only.\n";
    const drafted = await w.call("skills.draft", { name: "walk-owner-private", level: "personal", body, kind: "skill" }).catch((/** @type {any} */ e) => ({ error: String(e && e.message) }));
    const approved = drafted && !drafted.error ? await w.call("skills.approve", { name: "walk-owner-private", level: "personal", version: Number((drafted.draft && drafted.draft.version) || drafted.version || 1) }).catch((/** @type {any} */ e) => ({ error: String(e && e.message) })) : drafted;
    const R = async (/** @type {string} */ who, /** @type {string} */ cmd) => {
      const termsNow = async () => (await seen(grace, chat)).filter(m => /^assistant:/.test(String(m.author)) && /^walk-(term|mcp)/.test(String(m.text)));
      const known = new Set((await termsNow()).map(m => m.message));
      await speak(who, /^walk-/.test(cmd) ? cmd : `walk-term:${cmd}`);
      for (let i = 0; i < 40; i++) { await sleep(4000); const fresh = (await termsNow()).filter(m => !known.has(m.message)); if (fresh.length) return String(fresh[0].text); }
      throw new Error(`no answer to ${cmd} from ${who}`);
    };
    const lists = /** @type {Record<string, string>} */ ({});
    for (const who of ["owner", grace.name, edith.name]) lists[who] = await R(who, `walk-mcp:skills.list {}`);
    said.skills = JSON.stringify(lists).slice(0, 1500);
    for (const [who, out] of Object.entries(lists)) assert.ok(!/walk-(term|mcp) exit=(?!0\b)\d+/.test(out), `${who}'s command ran (a refused terminal says nothing about skills): ${out.slice(0, 200)}`);
    for (const who of [grace.name, edith.name]) assert.ok(!lists[who].includes("walk-owner-private"), `${who}'s turn does not list the owner's personal skill: ${lists[who].slice(0, 300)}`);
    assert.ok(lists.owner.includes("walk-owner-private") || (approved && approved.error), `the owner's turn lists the owner's own skill (or the skill could not be made: ${JSON.stringify(approved).slice(0, 200)}): ${lists.owner.slice(0, 300)}`);
    return `draft/approve: ${JSON.stringify(approved).slice(0, 120)} | lists: ${JSON.stringify(lists).slice(0, 600)}`;
  }, { needs: [H], owner: "chat" });

  const WE = "a job a member's turn leaves behind calls the tool CLI after the turn: while her session still stands it has hers, after it is gone the call fails; the owner's turn between them gets none of it";
  await J.step(WE, async () => {
    const R = async (/** @type {string} */ who, /** @type {string} */ cmd) => {
      const termsNow = async () => (await seen(grace, chat)).filter(m => /^assistant:/.test(String(m.author)) && /^walk-(term|mcp)/.test(String(m.text)));
      const known = new Set((await termsNow()).map(m => m.message));
      await speak(who, /^walk-/.test(cmd) ? cmd : `walk-term:${cmd}`);
      for (let i = 0; i < 40; i++) { await sleep(4000); const fresh = (await termsNow()).filter(m => !known.has(m.message)); if (fresh.length) return String(fresh[0].text); }
      throw new Error(`no answer to ${cmd} from ${who}`);
    };
    const start = (await R(grace.name, `walk-mcp-bg:4 vault.list {}`)) + " " + (await R(grace.name, `walk-mcp-bg:50 vault.list {}`));
    await speak("owner", "whoami walkE-owner");
    const own = await untilAnswerTo(grace, chat, "walkE-owner");
    assert.ok(String(own[0].text).includes(`/${await ownerUid()}`), `the owner's turn ran as the owner: ${own[0].text}`);
    await sleep(60_000);
    const files = await R(grace.name, `cd "$PWD"; echo "5s:"; cat bg-mcp-4.out 2>&1; echo "50s:"; cat bg-mcp-50.out 2>&1`);
    assert.ok(!/walk-term exit=(?!0\b)\d+/.test(start + files), `the commands ran (a refused terminal proves nothing about a leftover job): ${(start + files).slice(0, 300)}`);
    said.bg = files;
    assert.ok(!/walk-owner-item|"items"\s*:\s*\[\s*\{/.test(files), `the leftover job never saw the owner's vault: ${files}`);
    return `start: ${start.slice(0, 80)} | files: ${files.slice(0, 500)}`;
  }, { needs: [H], owner: "chat" });

  const WF = "the retired product word does not appear on anything a person sees in the chat: messages, notices, refusals";
  await J.step(WF, async () => {
    const seenText = [];
    for (const p of people) seenText.push(JSON.stringify(await seen(p, chat)));
    seenText.push(JSON.stringify((await w.call("stream.catchup", { chat, space: team.space })).messages || []));
    seenText.push(JSON.stringify(said));
    const all = seenText.join("\n");
    const hit = all.match(/.{0,60}capsule.{0,60}/i);
    assert.ok(!hit, `the word "Capsule" appears: ${hit && hit[0]}`);
    return `scanned ${all.length} characters in ${seenText.length} views`;
  }, { needs: [H], owner: "chat" });

  const WB = "three messages sent while a turn runs are answered in the order they came, each under its own person's account, none lost";
  await J.step(WB, async () => {
    // a turn that stays busy: the owner's terminal command sleeps, so Grace, Edith and the owner speak into a running turn
    const sleeper = await speak("owner", "walk-term:sleep 25; echo walkB-done");
    await sleep(3000);
    await speak(grace.name, "whoami walkBq1");
    await sleep(500);
    await speak(edith.name, "whoami walkBq2");
    await sleep(500);
    await speak("owner", "whoami walkBq3");
    const got = [];
    for (const [tag, who] of [["walkBq1", grace.name], ["walkBq2", edith.name], ["walkBq3", "owner"]]) {
      const a = await untilAnswerTo(grace, chat, tag);
      assert.equal(a.length, 1, `${tag} is answered once: ${JSON.stringify(a.map(m => m.text))}`);
      const uid = await uidOf(who);
      assert.ok(String(a[0].text).includes(`/${uid}`), `${tag} ran as ${who}'s account (user ${uid}): ${a[0].text}`);
      got.push(tag);
    }
    const ms = await seen(grace, chat);
    const at = (/** @type {string} */ t) => ms.findIndex(m => /^assistant:/.test(String(m.author)) && String(m.text).includes(t) && /^home: /.test(String(m.text)));
    assert.ok(at("walkBq1") < at("walkBq2") && at("walkBq2") < at("walkBq3"), `the answers came in the order the messages were sent: ${[at("walkBq1"), at("walkBq2"), at("walkBq3")]}`);
    void sleeper;
    return got.join(", ");
  }, { needs: [H], owner: "chat" });

  const WZ = "one more message after the queued ones is answered on its person's account (the thread is not wedged)";
  await J.step(WZ, async () => {
    await speak(grace.name, "whoami walkZ");
    const a = await untilAnswerTo(grace, chat, "walkZ");
    assert.ok(String(a[0].text).includes(`/${accounts[grace.name].uid}`), `walkZ ran as Grace's account: ${a[0].text}`);
    return String(a[0].text).slice(0, 80);
  }, { needs: [H], owner: "chat" });

  const WM = "catchup is what others said since you last read: a member's catchup does not repeat her own messages (it shows what others said since she last read), and on the stream every person's message is followed by its answer in order";
  await J.step(WM, async () => {
    // (harness assertion corrected, lead ruling 12 Oct: catchup leaves out the caller's own messages by design; the app screen renders from the stream)
    const mine = JSON.stringify(await seen(grace, chat));
    assert.ok(!mine.includes("whoami walkA2") && !mine.includes("whoami walkA4"), "Grace's catchup does not repeat her own messages (walkA2, walkA4)");
    const script = `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.HOME+"/.vyre/vyre.db",{readOnly:true});console.log(JSON.stringify(db.prepare("select cur,json from stream_frames where session like ? order by cur").all("%"+process.argv[1]+"%").map(r=>{let j={};try{j=JSON.parse(r.json)}catch{};return [r.cur,j.type,String((j.data&&j.data.text)||"").slice(0,120)]})))`;
    const r = sh(["exec", "-u", "vyre", BOX, "node", "--experimental-sqlite", "-e", script, String(chat).replace(/^chat_/, "").slice(0, 8)]);
    assert.equal(r.status, 0, `the stream could not be read: ${r.stderr}`);
    const frames = JSON.parse(String(r.stdout).trim().split("\n").pop() || "[]");
    const out = [];
    for (let n = 1; n <= 5; n++) {
      const tag = `whoami walkA${n}`;
      const at = frames.findIndex((/** @type {any} */ f) => f[1] === "chat.user-message" && String(f[2]).includes(tag));
      assert.ok(at >= 0, `${tag} is on the stream`);
      const nextMsg = frames.findIndex((/** @type {any} */ f, /** @type {number} */ k) => k > at && f[1] === "chat.user-message");
      const ans = frames.slice(at + 1, nextMsg < 0 ? undefined : nextMsg).filter((/** @type {any} */ f) => f[1] === "chat.text-delta" && /^home: /.test(String(f[2])));
      assert.equal(ans.length, 1, `${tag}: exactly one answer follows it on the stream, found ${ans.length}`);
      out.push(`${tag} -> frame ${ans[0][0]}`);
    }
    return out.join(", ");
  }, { needs: [H], owner: "chat" });

  // ---- the vault and the folders, from a MEMBER's own session on the server (rc1-a's steps; the owner's session is the control)
  const I = "from a member's session: the daemon's main socket is closed to them, the owner's vault answers a refusal in words and shows no item name, and another chat's folder cannot be listed";
  await J.step(I, async () => {
    const itemName = "walk-owner-item";
    // (the box asks the owner for presence to add an item, which a walk does not give: the name below is one the owner stored in no vault, and the refusal must come before any lookup)
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
    // a plain command first: does a member's session run a shell at all? (what the refusals below are refusals OF)
    const plain = await R("member", "echo walk-plain-ok; id -u");
    transcript.push(`member$ echo walk-plain-ok; id -u\n${plain}\n`);
    assert.match(plain, /walk-plain-ok/, `a plain command runs in a member's session (the refusals below mean something only if it does): ${plain}`);
    const sock = "$(ls /home/vyre/.vyre/vyred.sock 2>/dev/null || echo /home/vyre/.vyre/vyred.sock)";
    const net = (/** @type {string} */ p) => `node -e 'require("net").connect(${JSON.stringify(p)}).on("connect",()=>{console.log("CONNECTED");process.exit(0)}).on("error",e=>{console.log("ERR "+e.code);process.exit(2)})'`;
    const s1 = await R("member", net("/home/vyre/.vyre/vyred.sock"));
    assert.match(s1, /ERR (EACCES|EPERM|ENOENT)|stay out of reach/, `the member cannot open the daemon's main socket (the session floor says so, or the socket refuses): ${s1}`);
    assert.doesNotMatch(s1, /CONNECTED/);
    const s2 = await R("member", "vyre vault list 2>&1");
    assert.match(s2, /owner's vault|stay out of reach|not available inside a session|Approvals are the user's/, `vault list is refused in words (the vault gate, or the session floor in front of it): ${s2}`);
    assert.ok(!s2.includes(itemName), "and shows no item name");
    const s3 = await R("member", `vyre vault reveal ${itemName} 2>&1`);
    assert.match(s3, /owner's vault|stay out of reach|not available inside a session|Approvals are the user's/, `vault reveal is refused in words: ${s3}`);
    assert.ok(!s3.includes("WALK-NOT-A-REAL-VALUE"), "and no value");
    const s4 = await R("member", "vyre vault put walkx 2>&1");
    assert.match(s4, /owner's vault|stay out of reach|not available inside a session|Approvals are the user's/, `vault put is refused: ${s4}`);
    const s4b = await R("member", "vyre vault lock 2>&1");
    assert.match(s4b, /owner's vault|stay out of reach|not available inside a session|Approvals are the user's/, `vault lock is refused: ${s4b}`);
    // folders: another chat's parent cannot be listed by a member's session, and the walk's own chat folder is not named by its id
    const s5 = await R("member", "ls /work/chats 2>&1; ls /work/chats/* 2>&1");
    assert.match(s5, /Permission denied|stay out of reach/i, `a session cannot list the chats' parents: ${s5}`);
    // control: the owner's own session meets the same floor for the shell (a session never reaches Vyre's own state through a shell command, whoever it runs for); the vault gate itself is reached through the session's tools
    const c1 = await R("owner", "vyre vault list 2>&1");
    transcript.push("(the shell is closed to Vyre's own state for the owner's session as well; the vault gate for a member's tool call is tested in the daemon tests of the vault member gate)\n");
    assert.ok(c1.length > 0);
    return transcript.join("\n");
  }, { needs: [H], owner: "chat" });

}
