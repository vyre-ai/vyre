import { useMemo } from "react";
import { useRouter } from "expo-router";
import { NewWatcherSheet } from "./NewWatcherSheet";
import { flowHookSource, watchersSource } from "./watchers-source";
import { dayTimeOf } from "../../src/time/show.js";
import type { TriggerSources } from "@vyre/ui";

/**
 * What the Flow editor's trigger may ask of the real server: the Flow's own webhook address (hooks.flow, renew, test, sign), bound to the Flow being edited (a Flow not saved yet has none), and the
 * person's watchers (watchers.list), with the sheet that makes a new watcher. The Vault link opens the item to reveal a signing secret.
 */
export function useTriggerSources(flow?: string): TriggerSources {
  const router = useRouter();
  return useMemo(() => ({
    ...triggerSources,
    ...(flow ? {
      flowHook: async () => { const h = await flowHookSource.state(flow); if (h && h.last && h.last.at) { const ms = Date.parse(h.last.at); if (Number.isFinite(ms)) h.last.when = dayTimeOf(ms); } return h; },
      renewHook: async () => { await flowHookSource.renew(flow); },
      testHook: () => flowHookSource.test(flow),
      signHook: async (scheme: string, header: string, secret: string) => { await flowHookSource.sign(flow, scheme, header, secret); },
    } : {}),
    openVault: (item: string, mode: "add" | "see" = "add") => router.push((mode === "see" ? `/u/vault?item=${encodeURIComponent(item)}` : `/u/vault?add=${encodeURIComponent(item)}&kind=api-key`) as never),
  }), [router, flow]);
}

const triggerSources: TriggerSources = {
  watchers: async () => (await watchersSource.list()).map((w) => w.name),
  newWatcher: (open, onClose, onCreated) => <NewWatcherSheet open={open} onClose={onClose} onCreated={onCreated} />,
};
