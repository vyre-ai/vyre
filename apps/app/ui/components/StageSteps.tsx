import { Pressable, View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";

/**
 * An ordered stage strip: done, current, to come. Used by records, projects and Flows. Each step is a mark and a word, so colour is never the only signal.
 * `strip` is the phone's form (ui-review, record page): 4 high bars with a 6 gap and only the current stage's name, once, above them.
 */
export function StageSteps({ stages, current, onSelect, strip }: { stages: string[]; current: number; onSelect?: (stage: string, i: number) => void; strip?: boolean }) {
  const list = (
    <View accessibilityRole="list" className={strip ? "flex-row gap-s2" : "flex-row gap-s1"} style={strip ? { gap: 6 } : undefined}>
      {stages.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "next";
        const bar = <View className={cn("h-s1 rounded-full", state === "done" ? "bg-ok" : state === "current" ? "bg-accent" : "bg-edge-strong")} />;
        const body = (
          <View className="min-w-0 flex-1 gap-s1">
            {bar}
            {strip ? null : <Text size="caption" strong={state === "current"} tone={state === "next" ? "label" : state === "done" ? "muted" : "default"} numberOfLines={1}>{s}</Text>}
          </View>
        );
        return onSelect ? (
          <Pressable key={s} accessibilityRole="button" accessibilityLabel={s} accessibilityState={{ selected: state === "current" }} onPress={() => onSelect(s, i)} className="min-w-0 flex-1 py-s1">{body}</Pressable>
        ) : (
          <View key={s} accessibilityLabel={s} accessibilityState={{ selected: state === "current" }} className="min-w-0 flex-1 py-s1">{body}</View>
        );
      })}
    </View>
  );
  if (!strip) return list;
  return (
    <View className="gap-s1">
      {stages[current] ? <Text size="caption" strong tone="muted">{stages[current]}</Text> : null}
      {list}
    </View>
  );
}

/**
 * The stage in a list row: one 6 x 3 segment per stage with a 3 gap (done segments the quiet ink at half strength, the current one the accent, the rest the
 * edge) and, when `name` is on, the stage's name on one line to the right. No stage shows an en dash.
 */
export function StageMini({ stages, current, name = true }: { stages: string[]; current: number; name?: boolean }) {
  if (!stages.length || current < 0) return <Text tone="faint">{"–"}</Text>;
  return (
    <View accessible accessibilityLabel={`Stage ${stages[current]}, ${current + 1} of ${stages.length}`} className="flex-row items-center gap-s2">
      <View className="flex-row items-center" style={{ gap: 3 }}>
        {stages.map((s, i) => <View key={s} style={{ width: 6, height: 3, borderRadius: 2 }} className={cn(i < current ? "bg-text-2 opacity-50" : i === current ? "bg-accent" : "bg-edge-strong")} />)}
      </View>
      {name ? <Text size="caption" tone="muted" numberOfLines={1} className="min-w-0 flex-shrink">{stages[current]}</Text> : null}
    </View>
  );
}
