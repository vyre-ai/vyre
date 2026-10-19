import { NewWatcherSheet } from "./NewWatcherSheet";
import { hooksSource, watchersSource } from "./watchers-source";
import type { TriggerSources } from "@vyre/ui";

/** What the Flow editor's trigger may ask of the real box: webhook routes (hooks.list, hooks.status, hooks.open, hooks.enable) and the person's watchers (watchers.list), with the sheet that makes a new watcher. */
export const triggerSources: TriggerSources = {
  hooks: () => hooksSource.state(),
  enableHooks: async () => { await hooksSource.enable(true); },
  openRoute: async (name, scheme, header, secret) => { await hooksSource.open(name, scheme, header, secret); },
  watchers: async () => (await watchersSource.list()).map((w) => w.name),
  newWatcher: (open, onClose, onCreated) => <NewWatcherSheet open={open} onClose={onClose} onCreated={onCreated} />,
};
