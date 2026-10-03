import { Pressable, View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";

/** An ordered stage strip: done, current, to come. Used by records, projects and Flows. Each step is a mark and a word, so colour is never the only signal. */
export function StageSteps({ stages, current, onSelect }: { stages: string[]; current: number; onSelect?: (stage: string, i: number) => void }) {
  return (
    <View accessibilityRole="list" className="flex-row gap-s1">
      {stages.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "next";
        const body = (
          <View className="min-w-0 flex-1 gap-s1">
            <View className={cn("h-s1 rounded-full", state === "done" ? "bg-ok" : state === "current" ? "bg-accent" : "bg-edge-strong")} />
            <Text size="caption" strong={state === "current"} tone={state === "next" ? "label" : state === "done" ? "muted" : "default"} numberOfLines={1}>{s}</Text>
          </View>
        );
        return onSelect ? (
          <Pressable key={s} accessibilityRole="button" accessibilityState={{ selected: state === "current" }} onPress={() => onSelect(s, i)} className="min-w-0 flex-1 py-s1">{body}</Pressable>
        ) : (
          <View key={s} accessibilityState={{ selected: state === "current" }} className="min-w-0 flex-1 py-s1">{body}</View>
        );
      })}
    </View>
  );
}
