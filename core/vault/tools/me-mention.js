// @ts-check
// me-mention: a member's own #item chip in a chat turn. In a group chat the turn arrives with an asker (a person the kernel has already checked is in the chat), and the Switchboard resolves the chips for THAT
// person: the answer comes from her own vault only, never the owner's, and is a name, a kind and a note, never a value. Her vault needs her unlock (people.js keeps the lease per person); a locked one says so
// in words the chat can show. Only the Switchboard asks, and its module is named `threads`, so its caller label is module:threads and nothing broader (the person is its to name, and is checked here to be a member and not the owner). This is the picker and the chip; what a chip LETS an agent do with
// her item in that turn is a separate step (the owner's # tag records a use; hers will use the lend path), and nothing here grants it.

const PERSON = /^per_[A-Za-z0-9_-]{1,64}$/;
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const denied = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "denied" });
const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });
const hintOf = (/** @type {any} */ i) => `${i.kind}${i.description ? " · " + String(i.description).slice(0, 120) : ""}`;

const TURN_MS = 30 * 60_000;
/** What can be lent to an agent for a turn: a login (the copy-and-grant of member-share.js) and an app connection (a connection share). Anything else is not lent. */
const LENDABLE = new Set(["login", "connection"]);

/**
 * @param {{ ctx: any, people: import("../people.js").PeopleVaults, internal: (name: string, description: string, input: any, run: Function) => void,
 *   define?: (name: string, def: any) => void, now?: () => number,
 *   lend?: { login?: { shareAs: (owner: string, i: any) => Promise<any>, endFor: (owner: string, thread: string) => Promise<number> }, connection?: { lendTurn: (person: string, name: string, agent: string, thread: string, expires: number) => Promise<any>, endTurn: (person: string, thread: string) => Promise<number> } } }} o
 */
export function register({ ctx, people, internal, define, now = Date.now, lend = {} }) {
  /** The asker, once she is a member and not the owner; the caller must be the Switchboard. @param {any} input @param {any} meta */
  const asker = async (input, meta) => {
    if (String((meta && meta.caller) || "") !== "module:threads") throw denied("only the Switchboard (the threads module) resolves a member's chip");
    const id = String((input && input.asker) || "");
    if (!PERSON.test(id)) throw bad("name the person who asked");
    if (String(ctx.kernel && ctx.kernel.owner) === id) throw denied("the owner's chips are the owner's vault");
    let ms = null;
    try { const c = await ctx.kernel.chain({}); ms = ctx.kernel.grants && ctx.kernel.grants.members ? await ctx.kernel.grants.members.list(c) : null; } catch { ms = null; }
    if (!Array.isArray(ms) || !ms.some((/** @type {any} */ m) => String(m.person) === id)) throw denied("that person is not a member of this Space");
    return id;
  };
  const locked = (/** @type {any} */ e) => (e && e.code === "locked" ? Object.assign(new Error("Unlock your vault to tag one of your own items."), { code: "locked" }) : e);

  internal("vault.me.mention.search", "A member's own # picker: names, kinds and a note of the items in HER vault, for the person the Switchboard names. Never a value.", obj({ asker: str, q: str, limit: { type: "integer" } }, ["asker"]),
    async (input, meta) => {
      const id = await asker(input, meta);
      try { const { items } = await people.list(id, { filter: input.q ? String(input.q) : undefined }); return { items: items.slice(0, Math.min(Number(input.limit) || 30, 100)).map((/** @type {any} */ i) => ({ id: i.name, name: i.name, kind: i.kind, hint: hintOf(i), icon: "key" })) }; } catch (e) { throw locked(e); }
    });

  internal("vault.me.mention.resolve", "A member's own # chip in a turn: the item in HER vault by name, for the person the Switchboard names; answers name, kind and a note, never a value, and grants nothing by itself.", obj({ asker: str, id: str, thread: str, said: str }, ["asker", "id", "thread"]),
    async (input, meta) => {
      const id = await asker(input, meta);
      let items;
      try { items = (await people.list(id, {})).items; } catch (e) { throw locked(e); }
      const it = items.find((/** @type {any} */ i) => i.name === String(input.id));
      if (!it) throw Object.assign(new Error(`no item of yours named ${String(input.id).slice(0, 60)}`), { code: "not_found" });
      return { id: it.name, name: it.name, kind: it.kind, hint: hintOf(it), note: "Only its name is shown in the chat, never the value." };
    });

  // ---- the turn lend: tagging her own item is the explicit act ----
  // The Switchboard calls this at the tag, with her presence for this exact call (the registry's floor asks for it; nothing here asks twice). The chat's agent gets Fill in only: the login or the connection is used
  // for it and never shown, held to this chat's thread, and taken back when the turn ends (vault.me.mention.end), with a short expiry as the backstop. Passkeys, notes, keys and everything else are not lent.
  /** @param {string} thread */
  const threadOk = thread => { if (!/^[A-Za-z0-9._:-]{1,120}$/.test(String(thread || ""))) throw bad("name the chat's thread"); return String(thread); };
  const agentName = (/** @type {any} */ a) => { const n = String(a || "").toLowerCase(); if (!/^[a-z][a-z0-9_-]{0,39}$/.test(n) || n === "assistant") throw bad("name the agent that runs this turn"); return n; };
  const def = define || ((/** @type {string} */ n, /** @type {any} */ d) => ctx.tool(n, d));
  def("vault.me.mention.lend", {
    internal: true,
    description: "A member tagged one of her own items in a chat: lend it to that chat's agent at Fill in for this turn only. { asker, id, thread, agent, origin? } -> { lent, name, agent, until }. Switchboard only (module:threads); asks for her presence; the agent never sees the value.",
    input: obj({ asker: str, id: str, thread: str, agent: str, origin: str }, ["asker", "id", "thread", "agent"]),
    presence: { summary: async (/** @type {any} */ i) => `Let ${String((i && i.agent) || "the agent").slice(0, 40)} use ${JSON.stringify(String((i && i.id) || "").slice(0, 60))} for this turn, without seeing it` },
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      const owner = await asker(input, meta);
      const thread = threadOk(input.thread), agent = agentName(input.agent), expires = now() + TURN_MS;
      let items;
      try { items = (await people.list(owner, {})).items; } catch (e) { throw locked(e); }
      const it = items.find((/** @type {any} */ i) => i.name === String(input.id));
      if (!it) throw Object.assign(new Error(`no item of yours named ${String(input.id).slice(0, 60)}`), { code: "not_found" });
      if (!LENDABLE.has(it.kind)) throw bad("that kind of item is not lent to an agent: a login or an app connection is");
      if (it.kind === "connection") {
        if (!lend.connection) throw Object.assign(new Error("lending a connection needs the Vault's connection shares"), { code: "unavailable" });
        await lend.connection.lendTurn(owner, it.name, agent, thread, expires);
      } else {
        if (!lend.login) throw Object.assign(new Error("lending a login needs the member shares"), { code: "unavailable" });
        let origin = input.origin ? String(input.origin) : "";
        if (!origin) { const f = (await people.get(owner, { name: it.name })).fields || {}; origin = String(f.url || f.website || f.origin || ""); }
        if (!origin) throw bad("which site does the agent sign in to? this login has no address saved: name it when you tag it");
        await lend.login.shareAs(owner, { item: it.name, agent, origin, expires, sessions: [thread] });
      }
      return { lent: true, name: it.name, agent, until: expires, note: "The agent can use it for this turn and never sees it. It ends when the turn ends." };
    },
  });

  internal("vault.me.mention.end", "The turn is over (finished, failed or cancelled), or the chat closed: take back everything a member lent for that thread. { asker, thread } -> { ended }. Switchboard only.", obj({ asker: str, thread: str }, ["asker", "thread"]),
    async (input, meta) => {
      const owner = await asker(input, meta), thread = threadOk(input.thread);
      let ended = 0;
      if (lend.connection) ended += await lend.connection.endTurn(owner, thread);
      if (lend.login) ended += await lend.login.endFor(owner, thread);
      return { ended };
    });
}

