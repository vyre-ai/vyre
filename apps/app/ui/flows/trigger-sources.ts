/** What the trigger editor may ask of the box, handed in by the screen (the editor itself calls no tool): the webhook listener and its routes. Absent where a Flow is only drawn. */
export type TriggerSources = {
  /** hooks.list and hooks.status together; null when the box has no webhooks. */
  hooks?: () => Promise<{ enabled: boolean; listening: boolean; routes: { name: string; scheme?: string; header?: string; secret?: string }[]; public: { available: boolean; base?: string; why?: string }; urls: Record<string, string | null> } | null>;
  enableHooks?: () => Promise<void>;
  openRoute?: (name: string, scheme: string, header: string, secret: string) => Promise<void>;
  /** Open the Vault at this item: its Add sheet (a name to fill in), or the item itself to reveal its value (a presence act in the Vault). Leaves the editor. */
  openVault?: (item: string, mode?: "add" | "see") => void;
};
