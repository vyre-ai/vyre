// After "Turn this into a Flow": one quiet line above the box while the assistant makes the draft, then "Draft ready" with Open it (the Flow's page, where the person reads the steps and says yes). Nothing runs from here.
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Icon, Text } from "@vyre/ui";
import { callT } from "../real/call-tool";
import { Turning } from "./Live";
import { draftWords, flowsFrom, newDraft } from "./draft-watch.js";

type S = { kind: "making" } | { kind: "ready"; id: string; title: string } | { kind: "none" } | null;

/** Starts watching on a tap: remembers which Flows exist, then looks every two seconds, for up to two minutes, for one that is new. */
export function useFlowDraft() {
  const [s, setS] = useState<S>(null);
  const before = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  useEffect(() => stop, []);
  // a draft is not in flows.list until it is approved, so the Flows are read from their definitions
  const rows = async () => { const r = await callT<unknown>("records.list", { type: "def-flow" }); return r.error ? [] : flowsFrom(r.data); };
  const start = useCallback(async () => {
    stop();
    before.current = (await rows()).map((r) => r.id);
    setS({ kind: "making" });
    const t0 = Date.now();
    timer.current = setInterval(async () => {
      const hit = newDraft(before.current, await rows());
      if (hit) { stop(); setS({ kind: "ready", ...hit }); } else if (Date.now() - t0 > 120_000) { stop(); setS({ kind: "none" }); }
    }, 2000);
  }, []);
  return { s, start, clear: () => { stop(); setS(null); } };
}

export function FlowDraftNote({ s, onClear }: { s: S; onClear: () => void }) {
  const router = useRouter();
  if (!s) return null;
  return (
    <View accessibilityLiveRegion="polite" style={{ width: "100%", maxWidth: 860, alignSelf: "center", paddingHorizontal: 16, paddingVertical: 4, flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {s.kind === "making" ? <Turning name="refresh" /> : <Icon name="flows" tone={s.kind === "ready" ? "accent" : "label"} />}
      <Text size="caption" tone="label" style={{ flexShrink: 1 }}>{draftWords(s)}</Text>
      {s.kind === "ready" ? <Button kind="secondary" label="Open it" onPress={() => { router.push(`/u/flows/${s.id}` as never); onClear(); }} /> : null}
      {s.kind !== "making" ? <Button kind="ghost" label="Close" onPress={onClear} /> : null}
    </View>
  );
}
