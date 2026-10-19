import { useMemo } from "react";
import { useRouter } from "expo-router";
import { NewWatcherSheet } from "./NewWatcherSheet";
import { hooksSource, watchersSource } from "./watchers-source";
import type { TriggerSources } from "@vyre/ui";

/** What the Flow editor's trigger may ask of the real box: webhook routes (hooks.list, hooks.status, hooks.open, hooks.enable) and the person's watchers (watchers.list), with the sheet that makes a new watcher. */
/** The sources, with the Vault link: adding the signing secret opens the Vault's Add sheet prefilled with the item's name (the same sheet a stuck task sends you to). */
export function useTriggerSources(): TriggerSources {
  const router = useRouter();
  return useMemo(() => ({ ...triggerSources, openVault: (item: string) => router.push(`/u/vault?add=${encodeURIComponent(item)}&kind=api-key` as never) }), [router]);
}

const triggerSources: TriggerSources = {
  hooks: () => hooksSource.state(),
  enableHooks: async () => { await hooksSource.enable(true); },
  openRoute: async (name, scheme, header, secret) => { await hooksSource.open(name, scheme, header, secret); },
  watchers: async () => (await watchersSource.list()).map((w) => w.name),
  newWatcher: (open, onClose, onCreated) => <NewWatcherSheet open={open} onClose={onClose} onCreated={onCreated} />,
};
