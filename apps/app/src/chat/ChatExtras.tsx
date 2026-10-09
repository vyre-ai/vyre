// Cards beside a chat's transcript that come from the box rather than from the stream's rows: the spend cap that paused this chat, the watcher cards the assistant has shown here, and the
// assistant's welcome in an empty chat. The shapes are the box's own (extras.js). Real boxes only: the sample world has none of these.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { allowsMock } from "@vyre/ui";
import { SpendCapCard, WatcherCard, WelcomeCard } from "../../screens/chat-tools";
import { listen } from "../api/box";
import { tool } from "../real/box";
import { isSpendCapFor, spendCardData, watcherNames } from "./extras.js";
import { ShownScreen, useShownScreens } from "./ChatShown";

export function ChatExtras({ thread, empty, busy }: { thread: string; empty: boolean; busy: boolean }) {
  const real = !allowsMock();
  const [cap, setCap] = useState<ReturnType<typeof spendCardData> | null>(null);
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!real) return;
    return listen((e) => { if (isSpendCapFor(e, thread)) setCap(spendCardData(e.payload)); });
  }, [real, thread]);
  // The cards the assistant showed in this chat are asked for when a turn ends: that is when it has just shown one.
  useEffect(() => {
    if (!real || busy) return;
    let live = true;
    tool("watchers.shown", { thread }).then((d) => { if (live) setNames(watcherNames(d)); }).catch(() => {});
    return () => { live = false; };
  }, [real, thread, busy]);
  const screens = useShownScreens(thread, busy, real);
  if (!real) return null;
  if (!cap && !names.length && !empty && !screens.length) return null;
  return (
    <View style={{ width: "100%", maxWidth: 860, alignSelf: "center", paddingHorizontal: 12, gap: 8, paddingTop: 6 }}>
      {empty ? <WelcomeCard /> : null}
      {names.map((n) => <WatcherCard key={n} name={n} />)}
      {screens.map((e) => <ShownScreen key={`${e.module}/${e.command}/${e.id ?? ""}`} entry={e} />)}
      {cap ? <SpendCapCard data={cap as never} /> : null}
    </View>
  );
}
