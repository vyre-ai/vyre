// "While you were away": one quiet card at the top of Now, once, when the person comes back after six hours or more and something major changed (new things that need them, Flow runs that finished or did not, documents
// signed, new members). Seen means seen: dismissing it, or leaving Now with it on screen, moves this device's mark forward, so the same changes never come back. The words are away.js; the card only draws them.
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Button, Card, Icon, Text } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { kvGet, kvSet } from "../../src/state/kv";
import { useSpaces } from "../shell/state";
import { visibleNeeds } from "../../src/state/answers";
import { useHidden, useNeeds, useNeedsFrom } from "../../src/state/needs";
import { awayLines, changesSince, isMajor, readState, topSeq, visited, wasAway } from "../../src/state/away.js";

type Ev = { type?: string; seq?: number; data?: unknown };

/** The card, drawn from its lines (the gallery draws it from a sample). */
export function AwayView({ lines, onSeen }: { lines: string[]; onSeen: () => void }) {
  return (
    <Card>
      <View className="gap-s2">
        <View className="flex-row items-center gap-s2"><Icon name="clock" tone="accent" /><Text strong>While you were away</Text></View>
        {lines.map((l) => <Text key={l}>{l}</Text>)}
        <View className="self-start pt-s1"><Button kind="ghost" label="Got it" onPress={onSeen} /></View>
      </View>
    </Card>
  );
}

export function AwayCard() {
  const space = useSpaces((s) => s.space);
  const key = `vyre.away.${space || "home"}`;
  const needsFrom = useNeedsFrom();
  const needIds = visibleNeeds(useNeeds(), useHidden()).map((n) => n.id);
  const ids = useRef<string[]>([]);
  ids.current = needIds;
  const [lines, setLines] = useState<string[] | null>(null);
  const seq = useRef(0);
  const decided = useRef(false);
  const shown = useRef(false);

  const markRef = useRef<() => Promise<void>>(async () => {});
  const mark = async () => { await kvSet(key, JSON.stringify(visited({ now: Date.now(), seq: seq.current, needs: ids.current }))); };
  markRef.current = mark;

  useEffect(() => {
    if (decided.current || needsFrom !== "box") return;
    decided.current = true;
    void (async () => {
      const state = readState(await kvGet(key));
      const read = await callT<{ events?: Ev[] }>("records.events", { ...(state ? { since: state.seq } : {}), limit: 300 });
      const events = read.error ? [] : read.data?.events ?? [];
      seq.current = Math.max(state?.seq ?? 0, topSeq(events));
      if (state && wasAway(state, Date.now())) {
        const c = changesSince(events, state.needs, ids.current, state.seq);
        if (isMajor(c)) { shown.current = true; setLines(awayLines(c)); return; }
      }
      await mark();
    })();
  }, [needsFrom, key]);

  // leaving Now with the card on screen is seeing it
  useEffect(() => () => { if (shown.current) void markRef.current(); }, []);

  if (!lines) return null;
  return <AwayView lines={lines} onSeen={() => { shown.current = false; setLines(null); void mark(); }} />;
}
