// @ts-check
// One persistent chat per person for their assistant, and one for @Engineer (R031-94). They are ordinary chats on the one chat UI: this file is only the rule "one per person per kind", who may have an
// Engineer chat, and what the Chats list says about them. A chat stays the same chat across rollover (the switchboard rolls the session, never the chat), so a pinned chat is the person's one long thread.
//
//   work.chat.persistent { kind }      the caller's pinned chat of that kind, or null when there is none yet (and whether they may have one)
//   work.chat.pin { kind, chat }       make a chat the caller is in their pinned one; a second, different chat of the same kind is refused and names the first
//   work.chat.list rows               carry `pinned: "assistant" | "engineer"` for the caller's own pinned chats

export const KINDS = Object.freeze(["assistant", "engineer"]);
const fail = (/** @type {string} */ code, /** @type {string} */ message, /** @type {any} */ more = {}) => Object.assign(new Error(message), { code, ...more });

/** @param {{ db: any, kernel: () => any, agentOf: (chain: any, chat: string) => Promise<string[]> }} o */
export function createPersistent({ db, kernel, agentOf }) {
  db.exec("CREATE TABLE IF NOT EXISTS work_persistent (person TEXT NOT NULL, kind TEXT NOT NULL, chat TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (person, kind))");
  const personOf = (/** @type {any} */ chain) => { const h = chain && chain.hops && chain.hops.length === 1 ? chain.hops[0] : null; if (!h || h.actor.kind !== "person") throw fail("not_allowed", "a persistent chat is a person's own: it is asked for by that person, directly"); return h.actor; };
  /** May this person have a chat of this kind: anyone for the assistant, an owner or an admin for the Engineer. */
  const mayHave = (/** @type {any} */ person, /** @type {string} */ kind) => {
    if (kind === "assistant") return true;
    const role = kernel().members && kernel().members.roleOf ? kernel().members.roleOf({ kind: "person", id: person.id, space: kernel().space }) : null;
    return role === "owner" || role === "admin";
  };
  const kindOk = (/** @type {unknown} */ k) => { if (!KINDS.includes(/** @type {string} */ (k))) throw fail("bad_input", `kind is one of ${KINDS.join(", ")}`); return /** @type {string} */ (k); };
  const row = (/** @type {string} */ person, /** @type {string} */ kind) => db.prepare("SELECT chat FROM work_persistent WHERE person = ? AND kind = ?").get(person, kind);

  return {
    /** @param {any} chain @param {{ kind: string }} i */
    async get(chain, i) {
      const person = personOf(chain), kind = kindOk(i.kind);
      const r = row(person.id, kind);
      return { kind, chat: r ? String(r.chat) : null, allowed: mayHave(person, kind) };
    },
    /** @param {any} chain @param {{ kind: string, chat: string }} i */
    async pin(chain, i) {
      const person = personOf(chain), kind = kindOk(i.kind);
      if (!mayHave(person, kind)) throw fail("not_allowed", kind === "engineer" ? "@Engineer is for an owner or an admin of this Space" : "not allowed");
      const chat = String(i.chat || "");
      const have = row(person.id, kind);
      if (have && String(have.chat) === chat) return { kind, chat, existing: true };
      if (have) throw fail("exists", `you already have your ${kind} chat (${have.chat}): there is one, and it is kept going`, { chat: String(have.chat) });
      const mine = new Set((await kernel().chats.mine(chain)).map((/** @type {any} */ m) => m.chat));
      if (!mine.has(chat)) throw fail("not_found", "no such chat of yours");
      if (kind === "engineer" && !(await agentOf(chain, chat)).includes("engineer")) throw fail("bad_input", "the Engineer's chat is a chat with the engineer agent");
      db.prepare("INSERT INTO work_persistent (person, kind, chat, at) VALUES (?,?,?,?)").run(person.id, kind, chat, Date.now());
      return { kind, chat, existing: false };
    },
    /** The caller's pinned chats, by chat id. @param {string} person @returns {Map<string, string>} */
    pinnedOf(person) { return new Map(db.prepare("SELECT chat, kind FROM work_persistent WHERE person = ?").all(person).map((/** @type {any} */ r) => [String(r.chat), String(r.kind)])); },
  };
}
