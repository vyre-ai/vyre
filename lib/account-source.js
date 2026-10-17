// @ts-check
// lib/account-source.js: where an AI account's key or token may be read from. An account with no person is the home's (its item is in the home's vault). An account of one person
// is read only from that person's own vault; if such a row is not marked as kept there, it is refused and the home's vault is never tried (that item would be the owner's).

/** @param {{ person?: string | null, kind?: string, own_vault?: any }} a */
export const mayReadHomeVault = a => !(a && a.person && a.kind !== "login" && !a.own_vault);
