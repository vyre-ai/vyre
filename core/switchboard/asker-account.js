// @ts-check
import { carriesPickedCredential } from "../sessions/providers.js";
// A shared chat's turn runs on the ASKER's own account of the thread's provider (0.3.3 G04). Accounts belong to people (sessions_accounts.person; Accounts.resolve({ provider, person }) considers only the
// accounts that serve that person), so a turn is never run on another member's sign-in:
//   - the asker has an own account for the provider: the turn runs on it (one turn, the conversation handed over, then the thread goes back to its own);
//   - none, and the asker is not the owner: refused in plain words ("add your own sign-in"), whatever the thread names or the machine's own credential would give (an owner's login is the owner's alone);
//   - none, and the asker is the owner: the thread's own account if it serves them (the home's, or no named account at all), else the home's default;
// a person's chip may name only an account that serves them (onceTarget resolves it with their person). A turn that arrives while another is running waits behind it (runQueuedOver) and shows as waiting.

/**
 * @param {any} sb the Switchboard @param {string} id the thread @param {{ asker: string }} kernelTurn @param {boolean} [memberOnly] the turn moves to another provider by the asker's chip: only whether they are in the chat is judged here (chipOver judges their sign-in for THAT provider)
 * @returns {Promise<{ provider: string, account: string, person: string | null } | null>} the one-turn target, or null when the thread's own account is theirs to use
 */
export async function askerOver(sb, id, kernelTurn, memberOnly = false) {
  const rec = sb.record(id);
  if (!rec || !kernelTurn || !kernelTurn.asker) return null;
  // Whether the asker is in the chat is the kernel's first word (a person who is not in it is refused as that, before anything about their sign-in is said).
  if (typeof sb.assertAsker === "function" && kernelTurn.chat) await sb.assertAsker(id, rec, kernelTurn);
  if (memberOnly) return null;
  const provider = rec.provider || "claude", asker = kernelTurn.asker, scope = { project: rec.project, agent: rec.agent };
  const mine = await sb.accountFor({ provider, person: asker, ...scope }).catch(() => null);
  if (mine && mine.id) return mine.id === rec.account ? null : { provider, account: String(mine.id), person: asker };
  // Nobody but the owner runs on the owner's login, nor on the machine's own credential or the ambient login of the user the server runs as (a Mac mini server's Claude Code login is the owner's): a person with no sign-in of their own is refused ALWAYS, whatever account the thread names or none, and whether or not any credential is visible to take.
  const owner = ownerOf(sb);
  if (owner === "") throw ownerUnknown();
  if (owner !== null && !isOwner(sb, owner, asker)) throw needOwnSignIn();
  if (!rec.account) return null;
  const serves = await sb.accountFor({ provider, account: rec.account, person: asker, ...scope }).catch(() => null);
  if (serves) return null;
  const home = await sb.accountFor({ provider, ...scope }).catch(() => null);
  if (home && home.id) return home.id === rec.account ? null : { provider, account: String(home.id), person: null };
  throw Object.assign(new Error("This chat runs on another member's sign-in, and you have none of your own here. Add your own sign-in to use it. Nothing was sent."), { code: "account_required" });
}

/** Is a turn running on this thread (so another person's one-turn must wait)? @param {any} sb @param {string} id */
export function busyTurn(sb, id) {
  const st = sb.live.get(id), rec = sb.record(id);
  return Boolean(sb.once.has(id) || (st && st.turn && rec && ["working", "waiting"].includes(String(rec.status))));
}

/**
 * A queued one-turn (the turn's facts carry `over`) is run when the thread is free: marked delivered and sent as the one-turn it was asked as. True when this took the rows.
 * @param {any} sb @param {string} id @param {any[]} rows the queued rows of one turn @param {any} kt the turn's facts @param {(at: number, rowId: number) => { changes: number | bigint }} mark @param {number} now @param {symbol} [lock] the drain's lock, released only by it
 */
export function runQueuedOver(sb, id, rows, kt, mark, now, lock) {
  if (!kt || !kt.over) return false;
  const r = rows[0];
  if (!mark(now, r.id).changes) { sb.drainDone(id, false, lock); return true; }   // the row is another drain's: release only our own lock, and do not drain again (the winner is in flight)
  const rec = sb.record(id);
  // One hop at a time: the previous hop back is finished first, the target is checked BEFORE the stream is told a turn began (a hop that cannot start says so in words and began nothing), and the drain
  // lock is released when the hop has started or failed, whichever, so the rows behind it are never stranded.
  void (async () => {
    let announced = false;
    try {
      if (!(await revertSettled(sb, id, false))) {
        // the hop back is still going past the wait: nothing is judged on the hop's state; the row goes back to the queue and the next turn's end (or resume) drains it
        // brought out again once the hop back is over (or now, when it already is and the thread is idle); a second time past the wait it is dropped in words, never left waiting for nothing
        const again = (sb.putBack ||= new Set()).has(r.id);
        if (again) { sb.putBack.delete(r.id); sb.db.prepare("UPDATE threads_inbox SET via = 'dropped' WHERE id = ?").run(r.id); sb.emit("thread.text", { message: "vyre", text: "A message waiting for this turn could not be started: the chat was busy for too long. Nothing was written to the session. Send it again from the chat.", done: true, notice: true }, id, rec ? rec.project : null); sb.drainDone(id, false, lock); return; }
        sb.putBack.add(r.id);
        sb.db.prepare("UPDATE threads_inbox SET delivered_at = NULL, via = NULL WHERE id = ?").run(r.id);
        sb.drainDone(id, false, lock);
        const back = sb.reverting.get(id);
        if (back) void back.finally(() => sb.drainDone(id, true)); else sb.drainDone(id, true);   // (a request to drain again: our own lock was released above)
        return;
      }
      await sb.onceTarget(id, kt.over);
      const sent = () => { announced = true; sb.emit("thread.sent", { text: String(r.text).slice(0, 2000), surface: r.surface, queued: Number(r.id), uuid: r.uuid || null, via: "turn", queued_at: Number(r.at), step: 0, ...(r.kind ? { kind: r.kind } : {}), ...(r.request ? { request: r.request } : {}) }, id, rec ? rec.project : null); };
      // told to the stream from inside sendOnce, right after the hop is claimed (onClaim): a hop that loses the claim or is refused first was never announced
      const started = await sb.sendOnce(id, r.text, r.surface, kt.over, { queue: false, onClaim: sent, kernelTurn: { chat: kt.chat, asker: kt.asker, ...(kt.space ? { space: kt.space } : {}) } });
      if (started === null) { sent(); await sb.deliverRow(id, r, kt); }   // no hop was needed: announced here, then delivered plainly   // no hop was needed (the thread already is on the asker's account): the words still go in, under their asker
      sb.drainDone(id, true, lock);   // (the hop's turn may already have ended while this settled: drainDone drains again only when the thread is idle with no hop pending)
    } catch (/** @type {any} */ e) {
      // The announced turn ends FIRST (the stream's member stops running), then the room is told: a notice while a turn still runs would take the reply path with no session and be dropped.
      try { sb.db.prepare("UPDATE threads_inbox SET via = 'refused' WHERE id = ?").run(r.id); } catch { /* the row keeps the mark it had */ }   // the row says what happened (a refused message is neither delivered nor answered); nothing runs it again by itself
      if (announced) sb.endAnnouncedTurn(id, rec ? rec.project : null);   // (nothing was announced if the target was refused first)
      sb.emit("thread.text", { message: "vyre", text: hopRefusal(e && e.code), done: true, notice: true }, id, rec ? rec.project : null);
      sb.drainDone(id, true, lock);
    }
  })();
  return true;
}

/** A chip names an account only the sender may use: a turn on the thread's own account is no exception (it may be another member's). Refused in words, nothing sent. @param {any} sb @param {{ provider: string, account?: string | null, person?: string | null }} over */
export async function servesChip(sb, over) {
  if (!over.person || !over.account) return;
  await sb.accountFor({ provider: over.provider, account: over.account, person: over.person }).catch(() => { throw Object.assign(new Error("That account is not yours to use here. Nothing was sent, and the turn did not move to another provider."), { code: "account_unavailable" }); });
}

const needOwnSignIn = () => Object.assign(new Error("You have no sign-in of your own here, and nobody else's is used for your messages. Add your own sign-in (Settings, your AI accounts) to use this chat. Nothing was sent."), { code: "account_required" });
/** The kernel is there but cannot say who owns the Space, so nobody can be told to be the owner: said as that (the owner too), not as "you have no sign-in of your own". */
const ownerUnknown = () => Object.assign(new Error("This server cannot tell just now who owns this Space, so it cannot tell whose sign-in your message may use. Nothing was sent. Try again in a minute; if it keeps happening, run vyre status on the server."), { code: "unavailable" });

/**
 * A session started or resumed for a chat turn whose asker is not the owner runs on that person's own account of the provider, never on the machine's own credential or the owner's login: their account
 * is named for the launch, and a person with none is refused (the thread is not left half made). The owner's turns, a named agent's and a launch that already names an account are unchanged.
 * @param {any} sb @param {any} rec the thread's record @param {any} o the launch options @param {string} id
 */
export async function memberAccount(sb, rec, o, id) {
  const asker = o.kernelTurn && o.kernelTurn.asker, owner = ownerOf(sb);
  if (!asker || owner === null || isOwner(sb, owner, asker) || o.agent) return o;
  const provider = rec.provider || o.provider || "claude";
  // An account the launch already names must serve this person: the owner's, or another member's, is "no account" to them whatever the input says.
  if (o.account) {
    await sb.accountFor({ provider, account: o.account, person: asker, project: rec.project, agent: rec.agent }).catch(() => { if (!o.resume) sb.db.prepare("DELETE FROM threads_runs WHERE id = ?").run(id); throw Object.assign(new Error("That account is not yours to use here. Nothing was sent."), { code: "account_unavailable" }); });
    return o;
  }
  const mine = await sb.accountFor({ provider, person: asker, project: rec.project, agent: rec.agent }).catch(() => null);
  if (mine && mine.id) return { ...o, account: String(mine.id) };
  if (!o.resume) sb.db.prepare("DELETE FROM threads_runs WHERE id = ?").run(id);
  throw owner === "" ? ownerUnknown() : needOwnSignIn();
}

/**
 * The kernel's owner in the form askers are compared in (canonical). null: this Switchboard has no kernel (one person, nobody to compare with). "": there is a kernel and its owner cannot be read, so
 * nobody can be told to be the owner: every asker is treated as a member (fails closed, never open).
 * @param {any} sb @returns {string | null}
 */
function ownerOf(sb) {
  const o = sb.deps && typeof sb.deps.owner === "function" ? sb.deps.owner() : null;
  return o == null ? null : o ? sb.canon(o) : "";
}
const isOwner = (/** @type {any} */ sb, /** @type {string} */ owner, /** @type {string} */ asker) => Boolean(owner) && sb.canon(asker) === owner;

/**
 * A chip (`@claude`, `@codex:acct`) in a kernel turn: where the one turn runs, for the asker. askerOver has already judged the asker (in the chat, a sign-in of their own). A chip names an account only when it
 * serves them (servesChip); a chip with no account is the asker's OWN account of that provider, never the thread's. Null: the thread's own account is theirs and the chip changes nothing.
 * @param {any} sb @param {string} id the thread @param {string} provider @param {string | null} account @param {{ asker: string }} kt @param {{ provider: string, account: string, person: string | null } | null} own what askerOver gave
 */
export async function chipOver(sb, id, provider, account, kt, own) {
  const rec = sb.record(id), cur = (rec && rec.provider) || "claude";
  if (account) return { provider, account, person: kt.asker };
  if (provider === cur) return own;
  const mine = rec ? await sb.accountFor({ provider, person: kt.asker, project: rec.project, agent: rec.agent }).catch(() => null) : null;
  if (mine && mine.id) return { provider, account: String(mine.id), person: kt.asker };
  const owner = ownerOf(sb);
  if (owner === "") throw ownerUnknown();
  if (owner !== null && !isOwner(sb, owner, kt.asker)) throw needOwnSignIn();
  return { provider, account: null, person: kt.asker };
}

/**
 * Does a move to this account leave the thread's own account for another of the same provider? A native session lives in the folder of the account that made it (a Codex session in that account's CODEX_HOME),
 * so another account cannot load it: it starts a fresh session and is handed the conversation (the seed), where a provider that ran the thread under the same account resumes its own.
 * @param {{ provider?: string|null, account?: string|null }} rec @param {string} to the provider moved to @param {{ id: string } | null} acct the account moved to
 */
export function movesAccount(rec, to, acct) {
  return (rec.provider || "claude") === to && (rec.account || null) !== (acct ? acct.id : null);
}

/**
 * A hop back in flight (turnEnded records it in sb.reverting) must finish before the next person's turn is judged: the thread's provider and account are the hop's until it has. True when settled, or when
 * nothing was reverting; false when it is still going after the wait (sb.revertWaitMs, 10 s), and nothing may be judged on the wrong base then.
 * @param {any} sb @param {string} id @param {boolean} [waitDrain] also wait for a queued hop being started (the drain lock): a send judged meanwhile would see a base about to change @returns {Promise<boolean>}
 */
export async function revertSettled(sb, id, waitDrain = true) {
  const limit = Date.now() + (typeof sb.revertWaitMs === "number" ? sb.revertWaitMs : 10_000);
  /** @type {any} */ let timer;
  const left = () => Math.max(0, limit - Date.now());
  const back = sb.reverting.get(id);
  if (back) {
    const settled = await Promise.race([back.then(() => true, () => true), new Promise(r => { timer = setTimeout(() => r(false), left()); })]);
    clearTimeout(timer);
    if (!settled) return false;
  }
  // a queued hop being started (the drain lock) is a base that is about to change too: wait for it to have started
  if (!waitDrain) return true;   // (the queued hop's own start does not wait for itself)
  while (sb.draining && sb.draining.has(id) && left() > 0) await new Promise(r => { setTimeout(r, 20); });
  return !(sb.draining && sb.draining.has(id));
}

/** What nobody's personal skills means to the skills library: a person id that owns nothing, so a launch with no verified person gets the shared (space, project, agent) skills only. */
export const NOBODY = "-";

/**
 * Whose personal skills a launch is given (skills.materialise `person`): the verified asker of the turn it is launched for, else the running turn's asker (a respawn); a thread that a verified chat turn
 * started (its stored `person`) and is launched with NO verified person (the hop back, a plain resume) gets nobody's, never the starter's or, by the library's default, the owner's. A thread no chat turn
 * started (an ordinary one: the owner's own) is unchanged: the library's default.
 * @param {any} sb @param {any} rec @param {any} o the launch options @returns {string}
 */
export function libraryPerson(sb, rec, o) {
  const verified = (o.kernelTurn && o.kernelTurn.asker) || (rec && sb.turnAsker.get(rec.id)) || null;
  if (verified) return String(verified);
  // A hop with no turn of its own (the hop back, or a person's own surface asking another provider for one turn): the person the hop's account was resolved for. This relies on the lookup that already ran at the top of
  // doSwitchProvider: an account serves only its own person (Accounts.serves), so a person who does not own the account fails there, before any launch. Canonical, so an owner who adopted an identity keeps his skills.
  if (o.skillsPerson) return String(o.skillsPerson);
  return o.person ? NOBODY : /** @type {any} */ (undefined);
}


/** The words the room sees when a person's hop onto their own account could not start: one fixed sentence per cause and the next step, never the lookup's own message (it can carry one person's account id). @param {string | undefined} code */
export function hopRefusal(code) {
  if (code === "busy") return "The chat is busy with another turn. Nothing was sent. Send the message again in a moment.";
  if (code === "no_session") return "The team's chat could not be opened for you just now, so your message was not sent. Nothing was written. Send it again in a minute.";
  if (code === "open_elsewhere") return "This chat is open in another window or terminal on that computer, so your message was not run. Nothing was sent. Close it there, then send the message again.";
  if (code === "denied" || code === "account_required") return "That sign-in is not yours to use here. Nothing was sent. Pick your own account, or add one under AI accounts.";
  if (code === "account_unavailable" || code === "account_removed" || code === "not_found" || code === "unavailable") return "Your sign-in for that AI is not available right now. Nothing was sent. Open AI accounts to sign in again, then send the message again.";
  return "Your message could not run on your own account. Nothing was sent. Send it again, or pick another account.";
}

/**
 * An agent's thread started on behalf of a person who is not the Space owner never runs on the owner's login (the sign-in an agent with NO picked credential falls back to); an agent that has one runs on it: it is refused, with the
 * next step, before anything is made. `who` is the one person on the call's kernel chain (null for the planner, a Flow, an automation: nobody to compare, today's behaviour), `owner` the kernel's owner
 * (undefined: no kernel; "": a kernel whose owner cannot be read, so nobody can be told to be the owner and every person counts as a member). A launch that names an account is judged by memberAccount.
 * @param {any} sb @param {{ agent?: string, account?: string, env?: any, fallback?: any, for_person?: string }} i @param {string | null} who @param {string | undefined} owner
 */
export async function agentLaunchGuard(sb, i, who, owner) {
  const launch = /** @type {any} */ (i);
  const forPerson = typeof launch.for_person === "string" && launch.for_person ? launch.for_person : null;   // honored only from an internal module (the tool drops it from anyone else's input)
  const hasTools = !(launch.lean || launch.tools === "none");
  if (!i.agent && !hasTools) return;                       // a tool-less job reads and writes text only
  if (i.account || owner === undefined) return;
  const person = forPerson || who;
  if (forPerson === "automation") return;                  // an owner's or a Flow's own setting, named by the module that makes it (the duty wake, the integrator)
  // The gate judges ONE situation: a call that carries a person who is not the owner or an admin. A call with no person on it (the owner's surfaces, a session asking a teammate, a restart re-running a queued
  // request, a duty, the integrator, a Flow) is not judged and not refused here, as before the gate existed.
  if (!person) return;
  if (owner && sb.canon(person) === sb.canon(owner)) return;
  // an admin's turn is the owner's kind of turn
  const role = typeof sb.deps.membershipOf === "function" ? await Promise.resolve(sb.deps.membershipOf(person)).catch(() => null) : null;
  if (role && (role.role === "owner" || role.role === "admin")) return;
  if (!i.agent) throw Object.assign(new Error("An agentless job with tools runs on the machine's own sign-in, which is the owner's. Ask the owner to run it. Nothing was started."), { code: "no_account" });
  // A credential PICKED for the agent (its vault token or key in the launch's env, or a fallback key) is the owner's: a turn that somebody else drives runs on it ONLY when the launch delivers it where the turn's tools cannot read it
  // (the sandboxed launch hands it over by a file descriptor: delivered "fd"). An environment variable or a file the turn can print is refused, whatever the delivery is not known to be.
  if (carriesPickedCredential(launch)) {
    const how = typeof sb.deps.credentialDelivery === "function" ? sb.deps.credentialDelivery(i) : undefined;
    if (how === "fd") return;
    if (how === undefined) throw Object.assign(new Error(`${i.agent}'s sign-in cannot be used for a teammate's request yet. The owner can run it for you. Nothing was started.`), { code: "no_account" });
    throw Object.assign(new Error(`${i.agent}'s sign-in cannot be used for a teammate's request yet. Ask the owner to give it an API key or a setup token. Nothing was started.`), { code: "no_account" });
  }
  throw Object.assign(new Error(`${i.agent} has no AI sign-in picked for it, and the owner's is not used for your request. Ask the owner to pick one for it. Nothing was started.`), { code: "no_account" });
}

/** The launch input with `for_person` kept only when a first-party module made the call (anyone else's is dropped: a person's own words never say who the work is for). @param {any} i @param {any} meta */
export const trustedLaunch = (i, meta) => {
  if (!i) return i;
  const first = Boolean(meta && meta.firstParty === true && String(meta.caller || "").startsWith("module:"));
  const { for_person, read_only, ...rest } = i;
  // `for_person` from any first-party module; `read_only` (one folder the session may read, its own agent folder) only from the agents module: nobody else widens what a sandbox can read.
  return { ...rest, ...(for_person !== undefined && first ? { for_person } : {}), ...(read_only !== undefined && first && String(meta.caller) === "module:agents" ? { read_only } : {}) };
};

/** The first person on a kernel chain (a member's session chain carries her and the assistant: she is who asks). @param {any} chain @returns {string | null} */
const firstPerson = (chain) => { const h = chain && Array.isArray(chain.hops) ? chain.hops.find((/** @type {any} */ x) => x && x.actor && x.actor.kind === "person") : null; return h ? String(h.actor.id) : null; };

/**
 * The whole check of an agent or teammate launch, for the tool that launches (threads.launch) and for the check a module asks for BEFORE it queues work (threads.launch-check, team.ask): who asks is the
 * first person on the call's chain, else the person the module says the work is for (for_person; "automation" is an owner's or a Flow's own setting, named by the module); then agentLaunchGuard judges. Answers who was found.
 * @param {any} sb @param {any} i @param {any} chain @param {string | undefined} owner @returns {Promise<string | null>}
 */
export async function checkLaunch(sb, i, chain, owner) {
  const who = firstPerson(chain);
  await agentLaunchGuard(sb, i, who, owner);
  return who || (typeof i.for_person === "string" && i.for_person && i.for_person !== "automation" ? i.for_person : null);
}

/**
 * The person whose rights decide what project a thread may use: the verified asker of the turn; when the launch has none (a plain resume, a hop back, a restart: libraryPerson answers NOBODY) the person the
 * thread was STARTED for, which the thread keeps; undefined when there is no person at all (the owner's own terminal). @param {any} sb @param {any} rec @param {any} [o]
 */
export function projectPerson(sb, rec, o = {}) {
  const who = libraryPerson(sb, rec, o);
  return who === NOBODY && o && o.person ? String(o.person) : who;
}

/**
 * May the person this thread is for use its project's memory, brief and skills? True with no project, or with no person to judge (the owner's own terminal); otherwise the work module answers: the Space's owner or an
 * admin, or the project's owner or team. An answer that cannot be had counts as no, and a no costs her the project's room, never her turn. @param {any} sb @param {any} rec @param {any} [o]
 */
export async function projectMay(sb, rec, o = {}) {
  if (!rec || !rec.project) return true;
  const who = projectPerson(sb, rec, o);
  if (who === undefined || who === null) return true;
  return sb.deps.call("work.project.may-read", { project: rec.project, person: String(who) }).then((/** @type {any} */ r) => Boolean(r && !r.error && r.data && r.data.ok === true), () => false);
}

/**
 * Has the thread left the base a one-turn hop started from? By provider, or by ACCOUNT (a hop onto another person's account of the same provider moves nothing else): then the hop must be reverted.
 * @param {{ provider?: string | null, account?: string | null }} at the thread's record now @param {{ provider: string, account?: string | null }} back where the hop started
 */
export function hopMovedAway(at, back) {
  return (at.provider || "claude") !== back.provider || (at.account || null) !== (back.account || null);
}

/**
 * Where a hidden job (the models probe) makes its throwaway folder. On a box whose sessions run as an account's own uid the spawner accepts a work folder only under /work or that account's home, so the probe
 * is made under the work folder when there is one; anywhere else, the system's temp folder.
 * @param {{ work?: string, tmp: string, exists?: (p: string) => boolean }} o
 */
export function probeBase(o) {
  const work = o.work || "/work";
  return (o.exists || (() => false))(work) ? work : o.tmp;
}
