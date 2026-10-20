import { useMemo } from "react";
import { useRouter } from "expo-router";
import { hooksSource } from "./watchers-source";
import type { TriggerSources } from "@vyre/ui";

/** What the Flow editor's trigger may ask of the real box: webhook routes (hooks.list, hooks.status, hooks.open, hooks.enable). Watchers belong to agents now, never to Flows. */
/** The sources, with the Vault link: adding the signing secret opens the Vault's Add sheet prefilled with the item's name (the same sheet a stuck task sends you to). */
export function useTriggerSources(): TriggerSources {
  const router = useRouter();
  return useMemo(() => ({ ...triggerSources, openVault: (item: string, mode: "add" | "see" = "add") => router.push((mode === "see" ? `/u/vault?item=${encodeURIComponent(item)}` : `/u/vault?add=${encodeURIComponent(item)}&kind=api-key`) as never) }), [router]);
}

const triggerSources: TriggerSources = {
  hooks: () => hooksSource.state(),
  enableHooks: async () => { await hooksSource.enable(true); },
  openRoute: async (name, scheme, header, secret) => { await hooksSource.open(name, scheme, header, secret); },
};
