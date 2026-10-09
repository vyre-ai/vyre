// Which preview is open in Vyre's own pane (a column beside the chat on a computer, a full-screen sheet on a phone). One at a time; the card that opens it names it, and the chat screen draws it.
import { useSyncExternalStore } from "react";

type Open = { id: string; title: string } | null;
let current: Open = null;
const subs = new Set<() => void>();
export const openPreview = (p: { id: string; title: string }) => { current = p; subs.forEach((f) => f()); };
export const closePreview = () => { current = null; subs.forEach((f) => f()); };
export const usePreviewPane = (): Open => useSyncExternalStore((f) => { subs.add(f); return () => void subs.delete(f); }, () => current, () => null);
