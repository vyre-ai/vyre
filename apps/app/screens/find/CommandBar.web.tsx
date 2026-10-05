// Cmd-K (Ctrl-K) opens Find over whatever page is showing, from every place; Esc closes it. The shell mounts <CommandBar /> once.
import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Sheet } from "@vyre/ui";
import { FindPanel } from "./FindPanel";

export function CommandBar({ onGo }: { onGo?: (href: string) => void }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);
  return (
    <Sheet open={open} onClose={() => setOpen(false)} title="Search">
      {open ? <FindPanel autoFocus onGo={(href) => { setOpen(false); (onGo ?? ((h: string) => router.push(h as never)))(href); }} /> : null}
    </Sheet>
  );
}
