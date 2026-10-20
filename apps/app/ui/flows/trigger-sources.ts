import type { FlowHook } from "./webhook-model.js";

/**
 * What the trigger editor may ask of the server, handed in by the screen (the editor itself calls no tool): the Flow's own webhook address. Absent where a Flow is only drawn. Watchers belong to agents now, never to Flows.
 * The webhook parts are bound to the Flow being edited; a Flow not saved yet has none, and the editor says it gets its address when it is turned on.
 */
export type TriggerSources = {
  /** The Flow's own webhook address (hooks.flow): null when the server takes no webhooks. */
  flowHook?: () => Promise<FlowHook | null>;
  /** A new token: the old address stops working (hooks.flow.renew). */
  renewHook?: () => Promise<void>;
  /** One delivery through the server's own listener, checked like any other; it starts nothing (hooks.flow.test). */
  testHook?: () => Promise<{ ok: boolean; line: string }>;
  /** Advanced, verify a signature: scheme none, hmac-sha256, github or stripe; an empty secret makes one in the Vault (hooks.flow.sign). Asks for the person's yes. */
  signHook?: (scheme: string, header: string, secret: string) => Promise<void>;
  /** Open the Vault at this item: its Add sheet (a name to fill in), or the item itself to reveal its value (a presence act in the Vault). Leaves the editor. */
  openVault?: (item: string, mode?: "add" | "see") => void;
};
