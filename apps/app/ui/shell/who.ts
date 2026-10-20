// The right pane of the shell: who (an agent, a person or a group) is open beside the main view, or nobody. Anything can open it (a chat's title, a right-click or long press on an avatar or a row);
// the shell draws the slot and mounts the one component registered for it (the chat screens register their WhoPane). Pure state, no screen knowledge.

import type { ComponentType } from "react";
import { create } from "zustand";

export type WhoKind = "agent" | "person" | "group";
export type Who = { kind: WhoKind; id: string };

type S = {
  who: Who | null;
  /** The last one shown, so the toggle (Cmd Option B) can bring it back. */
  last: Who | null;
  Pane: ComponentType<Who & { onClose: () => void }> | null;
  open: (who: Who) => void;
  close: () => void;
  toggle: () => void;
  register: (c: ComponentType<Who & { onClose: () => void }>) => void;
};

export const useWho = create<S>((set, get) => ({
  who: null, last: null, Pane: null,
  open: (who) => set({ who, last: who }),
  close: () => set({ who: null }),
  toggle: () => { const s = get(); if (s.who) set({ who: null }); else if (s.last) set({ who: s.last }); },
  register: (Pane) => set({ Pane }),
}));

/** Open this one's side pane. The one call every entry point uses: openWho("agent", id), openWho("person", id), openWho("group", chatId). */
export const openWho = (kind: WhoKind, id: string) => { if (kind && id) useWho.getState().open({ kind, id }); };
export const closeWho = () => useWho.getState().close();
/** The chat screens call this once at load with their WhoPane (props kind, id, onClose). */
export const registerWhoPane = (c: S["Pane"]) => { if (c) useWho.getState().register(c); };

/**
 * Web props for an avatar or a row: a right-click opens that one's pane (and keeps the browser's menu away). A touch long press is the row's own press-and-hold; rows that have none use `onLongPress`.
 * @example <View {...whoPress("agent", id)} />
 */
export const whoPress = (kind: WhoKind, id: string): { onContextMenu: (e: { preventDefault: () => void; stopPropagation?: () => void }) => void } => ({
  onContextMenu: (e) => { e.preventDefault(); e.stopPropagation?.(); openWho(kind, id); },
});
