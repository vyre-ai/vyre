// @ts-check
// The words of the vault health card, from the counts vault.health.summary gives (no name, no value).

/** @typedef {{ total: number, rotate: number, fix: number }} VaultHealth */

/** The card's two lines, or null when nothing needs attention. @param {VaultHealth} h */
export function healthLines(h) {
  const total = Number(h && h.total) || 0;
  if (total <= 0) return null;
  const bits = [h.rotate > 0 ? `${h.rotate} to rotate` : "", h.fix > 0 ? `${h.fix} to fix` : ""].filter(Boolean);
  return { title: `${total} vault item${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention`, detail: `${bits.join(", ")}. The Vault names each one.` };
}
