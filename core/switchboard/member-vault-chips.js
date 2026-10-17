// @ts-check
// A member's vault chip and #Name on a chat turn resolve from THEIR OWN vault, never the owner's. The Switchboard asks the vault module (vault.me.mention.resolve), naming the asker the kernel has already
// checked is in this chat; the vault reads only that person's own vault and answers a name, a kind and a note, never a value. An item that is not in their vault is plain text; a locked vault says so in words
// (its own line, which the chat shows). Tagging here does not hand the item to an agent: the note says so (the vault's words), and no use is recorded.

const MAX = 4;

/**
 * @param {{ call: (tool: string, input: any) => Promise<any>, asker: string, thread: string, said: string, chips: any[], names: string[] }} o
 * @returns {Promise<{ kind: string, id: string, name: string, hint: string | null, hosts: string[], note: string | null, outside: boolean }[]>}
 */
export async function memberVaultTags({ call, asker, thread, said, chips, names }) {
  const wanted = [...new Set([...(Array.isArray(chips) ? chips : []).filter(c => c && c.kind === "vault" && c.id != null && String(c.id)).map(c => String(c.id)), ...(Array.isArray(names) ? names : []).map(String)])].slice(0, MAX);
  /** @type {any[]} */ const out = [];
  for (const id of wanted) {
    const r = await call("vault.me.mention.resolve", { asker, id, thread, said }).catch(() => null);
    if (!r) continue;
    if (r.error) {
      // a locked vault is the one refusal worth saying: the person can unlock it and tag again; anything else (not theirs, not there) is plain text
      if (String(r.error.code) === "locked") out.push({ kind: "vault", id, name: id, hint: "locked", hosts: [], note: typeof r.error.message === "string" ? r.error.message : "Unlock your vault to tag one of your own items.", outside: false });
      continue;
    }
    const d = r.data && typeof r.data === "object" ? r.data : null;
    if (!d) continue;
    out.push({ kind: "vault", id, name: String(d.name || id), hint: d.kind ? String(d.kind) : null,   // the kind only: the vault's hint carries the start of the item's description, which can be a private note and has no place in the thread's text or events
     hosts: [], note: typeof d.note === "string" && d.note ? d.note : null, outside: false });
  }
  return out;
}
