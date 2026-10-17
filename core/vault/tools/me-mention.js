// @ts-check
// me-mention: a member's own #item chip in a chat turn. In a group chat the turn arrives with an asker (a person the kernel has already checked is in the chat), and the Switchboard resolves the chips for THAT
// person: the answer comes from her own vault only, never the owner's, and is a name, a kind and a note, never a value. Her vault needs her unlock (people.js keeps the lease per person); a locked one says so
// in words the chat can show. Only the Switchboard asks, and its module is named `threads`, so its caller label is module:threads and nothing broader (the person is its to name, and is checked here to be a member and not the owner). This is the picker and the chip; what a chip LETS an agent do with
// her item in that turn is not this tool's: nothing here grants it (it is used by reference, #Vault.<Name>, in 0.7).

const PERSON = /^per_[A-Za-z0-9_-]{1,64}$/;
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const denied = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "denied" });
const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });
const hintOf = (/** @type {any} */ i) => `${i.kind}${i.description ? " · " + String(i.description).slice(0, 120) : ""}`;

/** @param {{ ctx: any, people: import("../people.js").PeopleVaults, internal: (name: string, description: string, input: any, run: Function) => void }} o */
export function register({ ctx, people, internal }) {
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
}

