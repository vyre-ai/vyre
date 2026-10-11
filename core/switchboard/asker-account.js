// @ts-check
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
  if (!mark(now, r.id).changes) { sb.drainDone(id, true, lock); return true; }
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
        if (back) void back.finally(() => sb.drainDone(id, true)); else sb.drainDone(id, true, lock);
        return;
      }
      await sb.onceTarget(id, kt.over);
      announced = true;
      sb.emit("thread.sent", { text: String(r.text).slice(0, 2000), surface: r.surface, queued: Number(r.id), uuid: r.uuid || null, via: "turn", queued_at: Number(r.at), step: 0, ...(r.kind ? { kind: r.kind } : {}), ...(r.request ? { request: r.request } : {}) }, id, rec ? rec.project : null);
      const started = await sb.sendOnce(id, r.text, r.surface, kt.over, { queue: false, kernelTurn: { chat: kt.chat, asker: kt.asker } });
      if (started === null) await sb.deliverRow(id, r, kt);   // no hop was needed (the thread already is on the asker's account): the words still go in, under their asker
      sb.drainDone(id, true, lock);   // (the hop's turn may already have ended while this settled: drainDone drains again only when the thread is idle with no hop pending)
    } catch (/** @type {any} */ e) {
      sb.emit("thread.text", { message: "vyre", text: `Your message could not run on your own account: ${e.message}`, done: true, notice: true }, id, rec ? rec.project : null);
      if (announced) sb.endAnnouncedTurn(id, rec ? rec.project : null);   // the turn announced as begun for these words ends here (nothing was announced if the target was refused first)
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
  return o.person ? NOBODY : /** @type {any} */ (undefined);
}

