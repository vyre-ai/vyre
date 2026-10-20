// @ts-check
// Each person's own model in a chat (owner, 20 Oct 2026: "each person's pick is their own"; the chat model switcher shows "the asker's own accounts and models"). A pick is kept per chat slot (its
// thread) and per person: it never changes the chat for anyone else. A turn someone asks runs on THEIR pick: on another provider or account it is the one-turn hop the asker's own account already takes
// (the whole conversation handed over, then back), on the same provider and account the model and effort are set for that turn. A turn by someone with no pick runs on the chat's own model, the one it
// had before anyone picked. The switch shows in the thread as one quiet line, "<person> switched to <model>", naming the model by its real name from the one model service.
import { providerName } from "./switched.js";

const TABLE = `CREATE TABLE IF NOT EXISTS threads_picks (thread TEXT NOT NULL, person TEXT NOT NULL, provider TEXT NOT NULL, account TEXT, model TEXT NOT NULL, effort TEXT, at INTEGER NOT NULL, PRIMARY KEY (thread, person))`;
/** The chat's own model, kept under this person key when the first pick is made, so a turn with no pick goes back to it. */
const BASE = "";
const ready = new WeakSet();
/** @param {any} db */
const table = (db) => { if (!ready.has(db)) { db.exec(TABLE); ready.add(db); } return db; };

/** @typedef {{ provider: string, account: string | null, model: string, effort: string | null }} Pick */

/** A person's pick for a thread, or null. @param {any} db @param {string} thread @param {string} person @returns {Pick | null} */
export function pickOf(db, thread, person) {
  const r = /** @type {any} */ (table(db).prepare("SELECT provider, account, model, effort FROM threads_picks WHERE thread = ? AND person = ?").get(String(thread), String(person)));
  return r ? { provider: String(r.provider), account: r.account == null ? null : String(r.account), model: String(r.model), effort: r.effort == null ? null : String(r.effort) } : null;
}

/** @param {any} db @param {string} thread @param {string} person @param {Pick} p */
function keep(db, thread, person, p) {
  table(db).prepare("INSERT INTO threads_picks (thread, person, provider, account, model, effort, at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(thread, person) DO UPDATE SET provider = excluded.provider, account = excluded.account, model = excluded.model, effort = excluded.effort, at = excluded.at")
    .run(String(thread), String(person), p.provider, p.account, p.model, p.effort, Date.now());
}

/** The words of a refusal, with what to do next. @param {string} m @param {string} code */
const no = (m, code) => Object.assign(new Error(m), { code });
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/\[\]-]{0,119}$/, EFFORT = /^[a-z]{2,10}$/;

/** The model's real name from the one model service, else its id. @param {any} sb @param {string} provider @param {string} model */
async function nameOf(sb, provider, model) {
  try {
    const r = await sb.deps.call("models.list", { provider, limit: 500 });
    const hit = r && !r.error && r.data && Array.isArray(r.data.models) ? r.data.models.find((/** @type {any} */ m) => m && m.id === model) : null;
    return hit ? String(hit.name || hit.label || model) : model;
  } catch { return model; }
}

/**
 * A person picks the model a chat slot answers THEM on (threads.chat-switch). Their own account of that provider: the one they name when it is theirs, else their own for the provider; none is refused
 * in plain words. Nothing stops or restarts: the person's next turn runs on it. Says "<person> switched to <model>" in the thread, once.
 * @param {any} sb the Switchboard @param {{ thread: string, person: string | null, provider: string, model: string, account?: string | null, effort?: string | null }} o
 */
export async function pickChat(sb, o) {
  const person = o.person ? String(sb.canon ? sb.canon(o.person) : o.person) : "";
  if (!person) throw no("Only a person picks a model for a chat. Pick it from your own signed-in app.", "denied");
  const provider = String(o.provider || ""), model = String(o.model || "").trim(), effort = o.effort ? String(o.effort) : null;
  if (!MODEL.test(model)) throw no("That is not a model name. Pick one from the list of your models.", "bad_input");
  if (effort && !EFFORT.test(effort)) throw no("That is not an effort level. Pick one the model offers.", "bad_input");
  if (provider !== "claude" && !(sb.deps.providers && sb.deps.providers.get(provider))) throw no(`There is no ${providerName(provider)} here. Connect your own AI account in Settings, AI accounts.`, "bad_input");
  const rec = sb.must(String(o.thread));
  // the account is the person's own: the one they named when it serves them, else theirs of that provider; never the owner's or another member's
  const acct = await sb.accountFor({ provider, ...(o.account ? { account: String(o.account) } : {}), person, project: rec.project, agent: rec.agent }).catch(() => null);
  const own = acct && acct.id && (!acct.person || String(sb.canon ? sb.canon(acct.person) : acct.person) === person) ? acct : null;
  // the owner with no account row runs on the machine's own sign-in of the provider the chat already runs on (as a turn of theirs would); nobody else ever does
  const owner = sb.deps && typeof sb.deps.owner === "function" ? sb.deps.owner() : null;
  const ownerHere = !own && !o.account && owner && String(sb.canon ? sb.canon(owner) : owner) === person && provider === (rec.provider || "claude");
  if (!own && !ownerHere) throw no(`You have no ${providerName(provider)} account of your own here. Connect your own AI account in Settings, AI accounts.`, "account_required");
  if (o.account && own && String(own.id) !== String(o.account)) throw no("That account is not yours. Pick one of your own AI accounts.", "denied");
  const db = sb.db;
  // the chat's own model, kept once: a turn by someone with no pick runs on it
  if (!pickOf(db, rec.id || o.thread, BASE)) keep(db, String(o.thread), BASE, { provider: rec.provider || "claude", account: rec.account || null, model: String(rec.model || ""), effort: rec.effort || null });
  const pick = { provider, account: own ? String(own.id) : null, model, effort };
  keep(db, String(o.thread), person, pick);
  const name = await nameOf(sb, provider, model);
  // the one quiet line: the app reads {person:<id>} as the person's name in the chat
  sb.emit("thread.text", { message: "vyre", text: `{person:${person}} switched to ${name}`, done: true, notice: true }, String(o.thread), rec.project);
  return { thread: String(o.thread), provider, model, name, ...(pick.account ? { account: pick.account } : {}), ...(effort ? { effort } : {}), mine: true };
}

/**
 * The target of a turn the asker asked, after their own pick: `own` (askerOver's answer, their own account when the thread runs on another's) unless they picked a provider or account of their own, which
 * is then the one-turn hop with their model; on the same provider and account their model and effort are set for this turn. A turn by someone with no pick puts the chat's own model back. A chip (@codex)
 * is asked for before this and wins.
 * @param {any} sb @param {string} id the thread @param {{ asker?: string } | null | undefined} kt the chat turn @param {any} own
 */
export async function pickOver(sb, id, kt, own) {
  if (!kt || !kt.asker || !sb.db) return own;
  const rec = sb.record(id);
  if (!rec) return own;
  const person = String(sb.canon ? sb.canon(kt.asker) : kt.asker);
  const p = pickOf(sb.db, id, person) || pickOf(sb.db, id, BASE);
  if (!p || !p.model) return own;
  const cur = rec.provider || "claude", at = own || { provider: cur, account: rec.account || null };
  if (p.provider !== at.provider || (p.account && p.account !== at.account)) {
    // only the asker's own pick moves a turn to another account; the chat's own base is where it already runs
    if (!pickOf(sb.db, id, person)) return own;
    return { provider: p.provider, account: p.account, person, model: p.model, ...(p.effort ? { effort: p.effort } : {}) };
  }
  if (own) return { ...own, model: p.model, ...(p.effort ? { effort: p.effort } : {}) };
  try {
    if (p.model !== rec.model) await sb.switchModel(id, p.model);
    if (p.effort && p.effort !== rec.effort) await sb.switchEffort(id, p.effort);
  } catch { /* a busy turn keeps its model: this one runs on what is set */ }
  return null;
}
