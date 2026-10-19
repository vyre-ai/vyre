import type { ReactNode } from "react";

/** What the trigger editor may ask of the box, handed in by the screen (the editor itself calls no tool): the webhook listener and its routes, and the person's watchers. Absent where a Flow is only drawn. */
export type TriggerSources = {
  /** hooks.list and hooks.status together; null when the box has no webhooks. */
  hooks?: () => Promise<{ enabled: boolean; listening: boolean; routes: { name: string; scheme?: string; header?: string; secret?: string }[]; public: { available: boolean; base?: string; why?: string }; urls: Record<string, string | null> } | null>;
  enableHooks?: () => Promise<void>;
  openRoute?: (name: string, scheme: string, header: string, secret: string) => Promise<void>;
  /** The names of the person's watchers (watchers.list). */
  watchers?: () => Promise<string[]>;
  /** The sheet that makes a new watcher; the editor opens it and takes the name it made. */
  newWatcher?: (open: boolean, onClose: () => void, onCreated: (name: string) => void) => ReactNode;
};
