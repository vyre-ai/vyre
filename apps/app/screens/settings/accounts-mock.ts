// AI accounts in a mock build: sample rows in sessions.accounts.list's own shape, read through the same model and drawn by the same list as the real box's. Nothing is sent anywhere.
import { accountsOf, type Account, type Flow, type RouteEntry } from "./accounts-model";
import type { AccountsApi } from "./AccountsCard";

const SAMPLE = [
  { id: "ac_claude", provider: "claude", label: "Work", kind: "login", signed_in_at: 1, is_default: true, identity: { email: "ada@juniper.studio" } },
  { id: "ac_codex", provider: "codex", label: "Codex", kind: "login", signed_in_at: 1, is_default: true, identity: { email: "ada@juniper.studio" } },
  { id: "ac_router", provider: "openrouter", label: "Router", kind: "api-key", vault_item: "ai-key-openrouter-sample", is_default: true },
];

/** The sample's own copy of the rows, so Remove and Make default show their effect in the sample. */
export function sampleAccounts(): AccountsApi {
  let rows: Account[] = accountsOf(SAMPLE);
  let entries: RouteEntry[] = [{ provider: "claude", account: "ac_claude" }];
  const nothing = async (): Promise<Flow> => ({ id: "", step: "failed", provider: "", message: "This is a sample. Sign in on your own Vyre." });
  return {
    list: async () => rows,
    start: nothing,
    follow: nothing,
    paste: async () => ({}),
    addKey: async () => { throw new Error("This is a sample. Add a key on your own Vyre."); },
    replaceKey: async () => { throw new Error("This is a sample. Replace a key on your own Vyre."); },
    makeDefault: async (id: string) => { const p = rows.find((a) => a.id === id)?.provider; rows = rows.map((a) => (a.provider === p ? { ...a, isDefault: a.id === id } : a)); return {}; },
    remove: async (id: string) => { rows = rows.filter((a) => a.id !== id); return {}; },
    setPrivacy: async () => ({}),
    setGo: async () => ({}),
    assistant: async () => ({ name: "juno", entries }),
    setAssistant: async (_name: string, next: RouteEntry[]) => { entries = next; return {}; },
  };
}
