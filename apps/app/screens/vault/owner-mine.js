// @ts-check
// The owner has no "member's own vault": vault.me.* refuses the owner by design ("the owner uses the vault tools", core/vault/tools/me.js ME_REFUSAL). So when the Mine tab is asked for by the
// owner, the screen shows the owner's vault (the vault.* tools) under it instead of the refusal; a member keeps vault.me.*.

/**
 * Is this a server's answer that it has no member vault to offer for Mine: the owner's refusal ("the owner uses the vault tools"), or a Mac server's `core_owned` ("vyre-core holds the vault here": it keeps one
 * vault and has none for a member yet)? Either way Mine shows the vault the server does have (vault.*), the Space's, and says nothing went wrong. @param {any} e
 */
export const isOwnerRefusal = e => Boolean(e) && ((e.code === "denied" && /the owner uses the vault tools/.test(String(e.message || ""))) || e.code === "core_owned");

/** The scope whose tools a call uses: the owner's Mine is the Space vault. @param {boolean} owner @param {"space" | "mine"} scope @returns {"space" | "mine"} */
export const toolScope = (owner, scope) => (owner ? "space" : scope);

/**
 * The owner's vault in its two places (the owner has one store, vault.list): Mine is every item in no folder, which only the owner holds unless the owner lets someone use one;
 * Shared is every item in one of the Space's folders (a named vault: core/vault/tools/named.js, the `folder` vault.list gives) or in a vault shared from elsewhere (a name with a
 * slash, core/vault/shared.js). An item moves between them only by the owner's explicit Move (vault.named.move).
 * @template {{ name: string, folder?: string }} T @param {T[]} rows @returns {{ mine: T[], shared: T[] }}
 */
export function splitOwner(rows) {
  const isShared = (/** @type {T} */ r) => Boolean(r.folder) || String(r.name).includes("/");
  return { mine: rows.filter((r) => !isShared(r)), shared: rows.filter(isShared) };
}

/** The scope a screen asks for, as the store it reads: the owner's Mine and Shared are two parts of vault.list; a member's are vault.me.list and vault.me.shared.list. @param {boolean} owner @param {"mine" | "shared"} scope */
export const storeOf = (owner, scope) => (owner ? (scope === "mine" ? "owner-mine" : "owner-shared") : scope === "mine" ? "member-own" : "member-shared");
