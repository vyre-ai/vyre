// @ts-check
// fake-reply-port: the contract of reply-port.js over an in-memory chat, for the tests (not a test itself). It follows the lead's ruling for kernel-2's
// chats.appendOpen: open stamps the reply with the chat's membership version at that moment, the reply is delivered only to people who were in the chat at that
// version and still are, and a change of the list bumps the version. `kernel` is the little of ctx.kernel that group.js uses (a chat's list, session tokens,
// chats.append); `port` is the reply port. When the real chats.appendOpen lands, the tests that use this keep their meaning: swap the port, not the tests.

/** @typedef {{ id: string, people: string[], assistants: string[], version: number, history: Map<number, Set<string>> }} Chat */

export function createFakeKernel() {
  /** @type {Map<string, Chat>} */ const chats = new Map();
  /** @type {Map<string, { chat: string, person: string, agent?: string }>} */ const tokens = new Map();
  let n = 0;
  /** every chats.append the kernel took, in order @type {any[]} */ const appended = [];
  /** every open reply @type {{ grp: string, ver: number, deltas: string[], final: any, token: string }[]} */ const replies = [];
  /** chats whose appends/opens the kernel refuses (an assistant removed) @type {Set<string>} */ const refuse = new Set();
  const e = (/** @type {string} */ c) => Object.assign(new Error(c), { code: c });

  /** @param {string} id @param {string[]} people @param {string[]} [assistants] */
  function create(id, people, assistants = []) {
    const c = { id, people: [...people], assistants: [...assistants], version: 1, history: new Map([[1, new Set(people)]]) };
    chats.set(id, c);
    return c;
  }
  /** The list changes: the membership version moves. @param {string} id @param {{ add?: string[], remove?: string[] }} ch */
  function change(id, ch) {
    const c = /** @type {Chat} */ (chats.get(id));
    for (const p of ch.add || []) if (!c.people.includes(p)) c.people.push(p);
    c.people = c.people.filter(p => !(ch.remove || []).includes(p));
    c.version++;
    c.history.set(c.version, new Set(c.people));
  }
  const chatOf = (/** @type {string} */ token) => { const t = tokens.get(token); if (!t) throw e("denied"); return t; };

  const kernel = {
    space: "spc_fake",
    chats: {
      /** @param {string} token @param {any} m */
      async append(token, m) {
        const t = chatOf(token);
        if (refuse.has(t.chat)) throw e("denied");
        const c = chats.get(t.chat); if (!c || !c.people.includes(t.person)) throw e("not_found");
        const rec = { id: `k${++n}`, chat: t.chat, by: t.person, agent: t.agent, ...m };
        appended.push(rec);
        return { id: rec.id };
      },
      /** @param {any} chain @param {string} id */
      async read(chain, id) {
        const c = chats.get(id);
        if (!c || !c.people.includes(chain.person)) throw e("not_found");
        return { id, people: [...c.people], assistants: [...c.assistants] };
      },
    },
    for: () => ({
      surfaces: {
        /** @param {any} chain @param {{ chat: string, agent?: string }} o */
        async open(chain, o) {
          const c = chats.get(o.chat);
          if (!c || !c.people.includes(chain.person)) throw e("not_found");
          const token = `tok${++n}`;
          tokens.set(token, { chat: o.chat, person: chain.person, ...(o.agent ? { agent: o.agent } : {}) });
          return { token, expires: Date.now() + 24 * 3600_000 };
        },
      },
    }),
    /** @param {{ token: string }} meta */
    chain: async meta => ({ person: chatOf(meta.token).person }),
  };

  /** @type {import("./reply-port.js").ReplyPort} */
  const port = {
    stamp: grp => /** @type {Chat} */ (chats.get(grp)).version,
    async open({ grp, token }) {
      const t = chatOf(token);
      const c = chats.get(grp);
      if (refuse.has(grp) || !c || t.chat !== grp || !c.people.includes(t.person)) throw e("denied");
      const r = { grp, ver: c.version, deltas: /** @type {string[]} */ ([]), final: null, token };
      replies.push(r);
      return {
        ver: r.ver,
        write: async d => { if (refuse.has(grp)) throw e("denied"); r.deltas.push(d); },
        close: async f => { if (refuse.has(grp)) throw e("denied"); r.final = f; appended.push({ id: `k${++n}`, chat: grp, by: t.person, agent: t.agent, kind: "text", body: f }); },
      };
    },
    // In the chat at that version, and still in it.
    mayReceive: (grp, person, ver) => { const c = /** @type {Chat} */ (chats.get(grp)); const at = c.history.get(ver); return Boolean(at && at.has(person.replace(/^person:/, "")) && c.people.includes(person.replace(/^person:/, ""))); },
  };
  return { kernel, port, create, change, chats, appended, replies, refuse };
}
