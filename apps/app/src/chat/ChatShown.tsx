// The screens the assistant showed in this chat (views.show), each drawn as a card from the same description the app draws in full: views.get with surface "chat", then ChatCard.
// Open goes to the full screen, where an action and its preview-then-token path apply as ever. Read-only here.
import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { ChatCard } from "@vyre/ui";
import type { BlockScreenData } from "@vyre/ui";
import { tool } from "../real/box";
import { getInput } from "../../screens/shell/module-view.js";

type Entry = { module: string; command: string; id?: string; title: string; at: number };

/** The shown entries of a thread, asked for when a turn ends: that is when the assistant has just shown one. */
export function useShownScreens(thread: string, busy: boolean, real: boolean) {
  const [items, setItems] = useState<Entry[]>([]);
  useEffect(() => {
    if (!real || busy) return;
    let live = true;
    tool<{ screens: Entry[] }>("views.shown", { thread }).then((d) => { if (live) setItems(d.screens ?? []); }).catch(() => {});
    return () => { live = false; };
  }, [real, thread, busy]);
  return items;
}

export function ShownScreen({ entry }: { entry: Entry }) {
  const router = useRouter();
  const [screen, setScreen] = useState<(BlockScreenData & { title?: string }) | null>(null);
  useEffect(() => {
    let live = true;
    tool<any>("views.get", getInput({ module: entry.module, view: entry.command, id: entry.id, surface: "chat" })).then((f) => { if (live && f && f.v === 2) setScreen(f); }).catch(() => {});
    return () => { live = false; };
  }, [entry.module, entry.command, entry.id]);
  if (!screen) return null;
  return <ChatCard screen={screen} onOpen={() => router.push(`/u/module/${entry.module}/${entry.command}` as never)} />;
}
