// @ts-check
// A member's vault chip and #Name on a chat turn resolve from THEIR OWN vault, never the owner's. The Switchboard asks the vault module (vault.me.mention.resolve), naming the asker the kernel has already
// checked is in this chat; the vault reads only that person's own vault and answers a name, a kind and a note, never a value. An item that is not in their vault is plain text; a locked vault says so in words
// (its own line, which the chat shows). A chip alone hands nothing to an agent. A chip that carries her yes (signed over { asker, id, thread, agent }, plus origin exactly when the chip names one) (the device-signed presence the composer took at the tag, an opaque string the Vault checks and
// this file never reads) also asks the Vault to lend the item to the chat's agent for this turn (vault.me.mention.lend); the Vault refuses without a good yes, and then the chip stays a pill.

const MAX = 4;

/**
 * @param {{ call: (tool: string, input: any) => Promise<any>, asker: string, thread: string, said: string, chips: any[], names: string[], agent?: string | null }} o
 * @returns {Promise<{ kind: string, id: string, name: string, hint: string | null, hosts: string[], note: string | null, outside: boolean }[]>}
 */
export async function memberVaultTags({ call, asker, thread, said, chips, names, agent = null }) {
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
    const lent = await lendFor({ call, asker, thread, agent, id, chip: (Array.isArray(chips) ? chips : []).find(c => c && c.kind === "vault" && String(c.id) === id) });
    out.push({ kind: "vault", id, name: String(d.name || id), hint: d.kind ? String(d.kind) : null,   // the kind only: the vault's hint carries the start of the item's description, which can be a private note and has no place in the thread's text or events
    hosts: [], note: lent.note || (typeof d.note === "string" && d.note ? d.note : null), outside: false });
  }
  return out;
}

/**
 * The lend of her item to the chat's agent for this turn, asked only when the chip carries her yes and the turn has an agent that runs it (never named by the chat's text). Whatever the Vault answers is
 * the answer: a refusal leaves the chip a pill. The note says what the agent may do, and names the credential for vault.request when the Vault gave one; the value is never here.
 * @param {{ call: (tool: string, input: any) => Promise<any>, asker: string, thread: string, agent: string | null, id: string, chip: any }} o
 * @returns {Promise<{ note: string | null }>}
 */
async function lendFor({ call, asker, thread, agent, id, chip }) {
  const yes = chip && typeof chip.yes === "string" && chip.yes.length <= 4096 ? chip.yes : "";
  // A login with several sites is tagged for one: the app signs the origin into her yes when the chip names it, and the Vault checks it with the rest. Passed on only as the chip has it; a mismatch is the Vault's refusal.
  const origin = chip && typeof chip.origin === "string" && chip.origin.length <= 253 ? chip.origin : "";
  if (!yes || !agent) return { note: null };
  const r = await call("vault.me.mention.lend", { asker, id, thread, agent, yes, ...(origin ? { origin } : {}) }).catch(() => null);
  // A login whose site the Vault cannot tell (none saved, or several and none picked) is refused before anything is lent: the chip says so in words and stays a named pill.
  if (r && r.error && String(r.error.code) === "bad_input" && /^which site/i.test(String(r.error.message || ""))) return { note: "The agent was not given this login: Vyre could not tell which site it signs in to. Save the site on the item in your vault, or pick one when you tag it, then tag it again." };
  if (!r || r.error || !r.data || r.data.lent !== true) return { note: null };
  const use = typeof r.data.use === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(r.data.use) ? r.data.use : "";
  return { note: `${typeof r.data.note === "string" && r.data.note ? r.data.note : "The agent can use it for this turn and never sees it."}${use ? ` Pass credential "${use}" to vault.request.` : ""}` };
}
