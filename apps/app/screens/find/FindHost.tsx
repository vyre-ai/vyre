// The command bar: Cmd-K (Ctrl-K off a Mac) opens Find over any page on desktop and the web. Mount <FindHost /> once in the shell; anything can call openFind() (the Search button does).
// Esc closes it. A browser or a phone with no keyboard shortcut still reaches Find through /u/search.
import { useEffect } from "react";
import { Platform } from "react-native";
import { create } from "zustand";
import { Sheet } from "@vyre/ui";
import FindPanel from "./FindPanel";
import type { Scope } from "./model";

const useBar = create<{ open: boolean; n: number; scope: Scope; recordType: string; recordLabel: string }>(() => ({ open: false, n: 0, scope: "all", recordType: "", recordLabel: "" }));
/** Opens the main search. A page's own search button passes its scope (chats, projects, settings, ...); a record type page also names that type. The bar's Cmd K and the sidebar's Search open it on everything. */
export const openFind = (scope: Scope = "all", focus?: { type?: string; label?: string }) => useBar.setState((s) => ({ open: true, n: s.n + 1, scope, recordType: focus?.type || "", recordLabel: focus?.label || "" }));
export const closeFind = () => useBar.setState({ open: false });

export function FindHost() {
  const { open, n, scope, recordType, recordLabel } = useBar();
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); useBar.setState((s) => ({ open: !s.open, n: s.n + 1, scope: "all", recordType: "", recordLabel: "" })); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  // A new panel (and so a clean box and fresh recents) each time it opens.
  return <Sheet open={open} onClose={closeFind} title="Find">{open ? <FindPanel key={n} onDone={closeFind} initialScope={scope} recordType={recordType} recordLabel={recordLabel} /> : null}</Sheet>;
}
