// Where a session runs (R031-95 UX): the chip beside the state line, and the one line in the chat when it moves. The words and rules are screens/runner/runner-model.js; the box is the runner
// (session-transfer). A box without the runner has no placement, so there is no chip and no line.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Chip, Menu, Text, showToast } from "@vyre/ui";
import { listen } from "../api/box";
import { runner } from "../../screens/runner/runner";
import { chipOf, fresher, leaseLine, movedLine, placingLine, placingWords, type Placement } from "../../screens/runner/runner-model.js";

/** The session's placement, kept current by the box's own move events. */
export function usePlacement(thread: string, real: boolean) {
  const [p, setP] = useState<Placement | null>(null);
  const [lines, setLines] = useState<{ at: number; text: string }[]>([]);
  // While the process starts on a computer the status line says so (thread.placing); it is gone once it is up or has fallen back to the server.
  const [starting, setStarting] = useState("");
  // The same fact can arrive twice: a line is never put twice in a row.
  const say = useCallback((at: number, text: string) => setLines((l) => (l.length && l[l.length - 1].text === text ? l : [...l.slice(-4), { at, text }])), []);
  useEffect(() => {
    if (!real) return;
    let live = true;
    runner.placement(thread).then((x) => { if (live) setP(x); }).catch(() => {});
    const off = listen((e: any) => {
      if (e?.type === "thread.placing" && String(e?.payload?.thread ?? "") === thread) {
        setStarting(placingWords(e.payload));
        const line = placingLine(e.payload);
        if (line) say(Date.now(), line);
        // Where it runs may have changed under it (the row is taken back on a fallback): ask again, the box is the one fact.
        if (e.payload.state !== "starting") runner.placement(thread).then((x) => { if (live) setP((cur) => (x && fresher(cur?.epoch, x.epoch) ? x : cur)); }).catch(() => {});
        return;
      }
      if (e?.type === "lease.borrowed" && String(e?.payload?.thread ?? "") === thread) {
        const line = leaseLine({ computer: e.payload.computer, limit: e.payload.limit });
        if (line) say(Number(e.payload.at ?? Date.now()), line);
        return;
      }
      if (e?.type !== "thread.moved" || String(e?.payload?.thread ?? "") !== thread) return;
      setStarting("");
      const to = e.payload.to === "mac" ? "mac" : e.payload.to === "paused" ? "paused" : "server";
      const epoch = Number.isInteger(e.payload.epoch) ? e.payload.epoch : undefined;
      // A higher epoch wins: an update that arrives late never moves the chip back.
      setP((cur) => (fresher(cur?.epoch, epoch) ? { where: to === "mac" ? "mac" : "server", computer: e.payload.computer, reason: e.payload.reason ?? null, since: e.payload.at ?? Date.now(), ...(to === "paused" ? { state: "paused" as const } : {}), ...(epoch !== undefined ? { epoch } : {}) } : cur));
      say(Number(e.payload.at ?? Date.now()), movedLine({ to, reason: e.payload.reason }));
    });
    return () => { live = false; off?.(); };
  }, [thread, real, say]);
  const move = useCallback(async (to: "mac" | "server") => {
    try { const x = await runner.move(thread, to); if (x) setP(x); } catch (e) { showToast(e instanceof Error ? e.message : "That did not go through."); }
  }, [thread]);
  return { placement: p, lines, move, starting };
}

/** The chip: where it runs; tap to see why, or move it to the other place. */
export function PlacementChip({ placement, onMove }: { placement: Placement | null; onMove: (to: "mac" | "server") => void }) {
  const c = chipOf(placement);
  if (!c) return null;
  if (!c.moveTo) return <View accessibilityLabel={c.label} style={{ minHeight: 44, justifyContent: "center" }}><Chip tone={c.tone}>{c.label}</Chip></View>;
  const moveTo = c.moveTo;
  const items = [...(c.why ? [{ label: `On the server because ${c.why}`, onPress: () => {} }] : []), { label: c.moveLabel, onPress: () => onMove(moveTo) }];
  return <Menu trigger={<View accessibilityRole="button" accessibilityLabel={`${c.label}. Tap to change.`} style={{ minHeight: 44, justifyContent: "center" }}><Chip tone={c.tone} icon={placement?.where === "mac" ? "laptop" : "server"}>{c.label}</Chip></View>} items={items} />;
}

/** The "Moved to the server: lid closed." lines, quiet, under the transcript. */
export function MovedLines({ lines }: { lines: { at: number; text: string }[] }) {
  if (!lines.length) return null;
  return <View accessibilityLiveRegion="polite" style={{ gap: 2 }}>{lines.map((l) => <Text key={l.at} size="caption" tone="label">{l.text}</Text>)}</View>;
}
