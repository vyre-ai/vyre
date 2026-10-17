// @ts-check
// A person's own mute and list-pin for chats (not work.chat.pin's assistant/engineer pin): synced across devices.

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** @param {{ db: any }} o */
export function createChatPrefs({ db }) {
  const ensure = () => db.exec(`CREATE TABLE IF NOT EXISTS work_chat_prefs (
    person TEXT NOT NULL, chat TEXT NOT NULL, muted INTEGER NOT NULL DEFAULT 0, list_pin INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL,
    PRIMARY KEY (person, chat))`);
  ensure();
  const personOf = (/** @type {any} */ chain) => {
    const h = chain && chain.hops && chain.hops.length === 1 ? chain.hops[0] : null;
    if (!h || h.actor.kind !== "person") throw fail("not_allowed", "only a person has chat preferences");
    return String(h.actor.id);
  };
  const rowsOf = (/** @type {string} */ person) => /** @type {any[]} */ (ensure(), db).prepare("SELECT chat, muted, list_pin FROM work_chat_prefs WHERE person = ?").all(person);
  return {
    /** @param {any} chain */
    get(chain) {
      const person = personOf(chain);
      const muted = [];
      const pinned = [];
      for (const r of rowsOf(person)) {
        const chat = String(r.chat);
        if (r.muted) muted.push(chat);
        if (r.list_pin) pinned.push(chat);
      }
      return { muted, pinned };
    },
    /** @param {any} chain @param {{ chat: string, muted?: boolean, pinned?: boolean }} i */
    set(chain, i) {
      const person = personOf(chain);
      const chat = String(i.chat || "").trim();
      if (!chat) throw fail("bad_input", "name the chat");
      ensure();
      const row = /** @type {any} */ (db.prepare("SELECT muted, list_pin FROM work_chat_prefs WHERE person = ? AND chat = ?").get(person, chat));
      const muted = i.muted !== undefined ? (i.muted ? 1 : 0) : (row ? Number(row.muted) : 0);
      const listPin = i.pinned !== undefined ? (i.pinned ? 1 : 0) : (row ? Number(row.list_pin) : 0);
      if (!muted && !listPin) {
        db.prepare("DELETE FROM work_chat_prefs WHERE person = ? AND chat = ?").run(person, chat);
        return { chat, muted: false, pinned: false };
      }
      db.prepare(`INSERT INTO work_chat_prefs (person, chat, muted, list_pin, at) VALUES (?,?,?,?,?)
        ON CONFLICT(person, chat) DO UPDATE SET muted = excluded.muted, list_pin = excluded.list_pin, at = excluded.at`)
        .run(person, chat, muted, listPin, Date.now());
      return { chat, muted: Boolean(muted), pinned: Boolean(listPin) };
    },
    /** For push and glance: is this chat muted for this person? @param {string} person @param {string} chat */
    isMuted(person, chat) {
      const r = /** @type {any} */ (ensure(), db).prepare("SELECT muted FROM work_chat_prefs WHERE person = ? AND chat = ?").get(person, chat);
      return Boolean(r && r.muted);
    },
  };
}
