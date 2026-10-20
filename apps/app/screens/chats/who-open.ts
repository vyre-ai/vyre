// How a name or avatar opens a who's side pane. The shell's right pane registers its opener once (setWhoOpener); until it does, or where there is no pane (a phone), the pane opens as a page (/u/chats/who).
import type { WhoKind } from "./who-model.js";

type Opener = (kind: WhoKind, id: string) => void;
let opener: Opener | null = null;

/** The shell's right pane says how it opens a who; pass null when it goes away. */
export function setWhoOpener(f: Opener | null): void { opener = f; }

/** Open the pane for a who: the shell's pane when it is mounted, else `fallback` (a page). */
export function openWho(kind: WhoKind, id: string, fallback: (path: string) => void): void {
  if (opener) { opener(kind, id); return; }
  fallback(`/u/chats/who?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
}
