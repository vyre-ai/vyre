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
