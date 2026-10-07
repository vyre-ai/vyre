// @ts-check
// A record picked with # in the composer (`{ kind: "record", id: <urn> }` in a send's `mentions`), made safe to put in front of the model. The kernel decides, not the
// composer: the id must be a record reference in THIS Space, and the record is read under the SENDER's own chain through `records.reference`, so a record the sender may
// not read, one that is not there, or a reference someone made up is not a tag at all (the words stay plain text, a send is never blocked by it). What the model is told
// is the reference's text: the record as data, with every sealed part (and any part the room may not read) a `{{field:urn#name}}` placeholder and no value.

const MAX_RECORDS = 4;
const NOTE_MAX = 6000;
const URN = /^vyre:\/\/([^/\s]+)\/([a-z][a-z0-9_-]{0,63})\/([A-Za-z0-9_-]{1,64})$/;

/**
 * @param {any[]} chips the composer's picks
 * @param {{ kernel: any, chain: any }} o kernel: ctx.kernel (its `space` and `records.reference`); chain: this call's own kernel chain (null when the kernel refused it)
 * @returns {Promise<{ chips: any[], tags: { kind: string, id: string, name: string, hint: null, hosts: string[], note: string, outside: boolean }[] }>}
 *   chips: the picks that are not records (for the mentions providers); tags: the records that passed
 */
export async function recordTags(chips, { kernel, chain }) {
  const picks = Array.isArray(chips) ? chips : [];
  const others = picks.filter(c => !(c && c.kind === "record"));
  const wanted = picks.filter(c => c && c.kind === "record").slice(0, MAX_RECORDS);
  /** @type {any[]} */ const tags = [];
  if (!wanted.length || !kernel || !kernel.records || typeof kernel.records.reference !== "function" || !chain) return { chips: others, tags };
  // The module's own service chain reads anything; a tag is the PERSON's pick, so a chain with no person in it tags nothing.
  if (!Array.isArray(chain.hops) || !chain.hops.some((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person")) return { chips: others, tags };
  for (const c of wanted) {
    const m = URN.exec(String(c.id ?? ""));
    if (!m || m[1] !== kernel.space || tags.some(t => t.id === String(c.id))) continue;
    let ref = null;
    try { ref = await kernel.records.reference(chain, m[2], m[3]); } catch { ref = null; }
    if (!ref) continue;
    tags.push({ kind: "record", id: String(c.id), name: String(ref.title || m[3]).slice(0, 120), hint: null, hosts: [], note: String(ref.text).slice(0, NOTE_MAX), outside: true });
  }
  return { chips: others, tags };
}
