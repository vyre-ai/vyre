// The pure half of the Vault's Held fields tab and Share. Held fields are the sealed fields of records: the Vault holds the value, a record keeps only a reference,
// and an assistant reads "<Label> on file, sealed". The list is read from the Store's own types and records (a sealed value comes back as { sealed, ref }, never the
// text), so nothing here ever holds a value; a value exists only in the screen's state after a person's own Reveal.
import { isRevealable, isSealedValue } from "../../ui/fields/logic.js";
import { isSealedField, titleOf, viewDefOf } from "../../ui/views/logic.js";

export type Held = { id: string; urn: string; type: string; typeLabel: string; title: string; field: string; label: string };

/** Every sealed field a person may reveal, across every record type: one row per record and field that holds a value, named by the record and the field. Newest type first is not promised; order is the types' order, then the records'. */
export function heldFields(types: any[], byType: Record<string, any[]>): Held[] {
  const out: Held[] = [];
  for (const def of types) {
    const sealedFields = (def.fields || []).filter(isSealedField);
    if (!sealedFields.length) continue;
    const vd = viewDefOf(def);
    for (const rec of byType[def.name] || []) {
      for (const f of sealedFields) {
        const v = rec?.data?.[f.name];
        if (!isSealedValue(v) || !isRevealable(v) || v.present === false) continue;
        out.push({ id: `${rec.urn}/${f.name}`, urn: rec.urn, type: def.name, typeLabel: def.label || def.name, title: titleOf(def, rec, vd), field: f.name, label: f.label || f.name });
      }
    }
  }
  return out;
}

/** The line under a held field: what holds it, and what an assistant reads. */
export const heldLine = (h: Held): string => `${h.typeLabel}. Assistants read "${h.label} on file, sealed".`;

/** Held fields grouped by record, so Jane Doe's three fields sit under one name. */
export function heldByRecord(rows: Held[]): { urn: string; title: string; typeLabel: string; fields: Held[] }[] {
  const by = new Map<string, { urn: string; title: string; typeLabel: string; fields: Held[] }>();
  for (const h of rows) {
    const g = by.get(h.urn);
    if (g) g.fields.push(h); else by.set(h.urn, { urn: h.urn, title: h.title, typeLabel: h.typeLabel, fields: [h] });
  }
  return [...by.values()];
}

export type Share = { module: string; project: string };

/** The input of vault.grant for what the person typed, or the first thing wrong in words. The Vault uses the item for the module; the module never sees the value. */
export function shareInput(item: string, s: Share): { input: Record<string, unknown> } | { error: string } {
  const mod = s.module.trim();
  if (!mod) return { error: "Say who gets it: a module or an assistant by name." };
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(mod)) return { error: "Use the name as it appears under Who has it, with no spaces." };
  const [name, watcher] = mod.split("/");
  const project = s.project.trim();
  return { input: { name: item, module: name, ...(watcher ? { watcher } : {}), ...(project ? { project } : {}) } };
}

/** What a grant answered, in words. A grant from a person's own device is active at once; one waiting for a yes says so. */
export function shareNote(who: string, item: string, r: { grant?: { status?: string } } | undefined): string {
  return r?.grant?.status === "pending" ? `${who} asked for ${item}. It waits for your yes.` : `${who} can now use ${item}. It never sees the value.`;
}

/** The words for a refused share, from the box's code. */
export function shareRefusal(code: string | undefined, message: string): string {
  if (code === "presence_required") return "That needs you. Approve on this device, then try again.";
  if (code === "locked" || code === "vault_locked") return "Unlock the vault first.";
  if (code === "not_found") return "That item is no longer in the vault.";
  if (code === "denied" || code === "forbidden") return "This device may not share vault items.";
  return message || "The vault did not answer.";
}
