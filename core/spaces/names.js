// @ts-check
// spaces.names: this Space's name and one person's Vyre name, for what a Flow run prints about itself. Split out of index.js so the module stays inside its file-size record; the handler is the one
// index.js had, with the module's own helpers handed in.

/** @param {{ tool: Function, spaces: any, identity: any, K: any, nameOf: (id: string) => Promise<any>, refuse: (m: string, c: string) => Error, obj: Function, str: any }} d */
export function registerNames({ tool, spaces, identity, K, nameOf, refuse, obj, str }) {
  // The names a run can print about itself ({space.name}, {approver.name}, {me.name}): this Space's name and one person's Vyre name, read by the Space's own host alone, with no person on the call (the
  // member list is for the person who asks; a Flow's run has only its approver). Never anything but a name; a name it does not know is null.
  tool("spaces.names", "This Space's name and one person's Vyre name, for what a Flow run prints about itself: { space, person? } -> { space, person }. Only the Space's own host asks.",
    obj({ space: str, person: str }, ["space"]), async (i, meta) => {
      if (String((meta && meta.caller) || "") !== "module:vyred") throw refuse("only the Space's own host asks for these names", "denied"); // internal-word: the caller label, not shown text
      const id = String(i.space || "").trim().toLowerCase(), row = spaces.get(id);
      let st = null; try { st = identity.status(); } catch { st = null; }
      const own = K && id === String(K.space) && st && st.exists && st.name ? String(st.name) : "";
      const plain = (/** @type {any} */ n) => (typeof n === "string" && n.trim() ? n.trim().replace(/(\.vyre\.run)+$/, "") : null);
      const person = i.person ? plain(await nameOf(String(i.person))) : null;
      return { space: plain(row && row.name) || plain(own), person };
    }, { internal: true });
}
