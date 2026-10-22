import { useMemo, useState } from "react";
import { View } from "react-native";
import { Segmented, Text } from "@vyre/ui";
import { rangeOf } from "../calendar/logic.js";
import { HomeSection } from "./HomeSection";

export type Dated = { id: string; at: number; title: string; sub?: string };

function inSpan(items: Dated[], span: "day" | "week", now: number) {
  const { from, to } = rangeOf(span, new Date(now));
  return items.filter((e) => e.at >= from.getTime() && e.at < to.getTime()).sort((a, b) => a.at - b.at);
}

/** Today on Home: the dated records, as the day or the week. Hidden when the week has nothing. The toggle sits on the heading. */
export function HomeToday({ items, now }: { items: Dated[]; now: number }) {
  const week = useMemo(() => inSpan(items, "week", now), [items, now]);
  const day = useMemo(() => inSpan(items, "day", now), [items, now]);
  const [span, setSpan] = useState<"day" | "week">(day.length ? "day" : "week");
  if (!week.length) return null;
  const shown = span === "week" ? week : day;
  return (
    <HomeSection title="Today" count={shown.length} end={<Segmented label="When" options={[["day", "Day"], ["week", "Week"]]} value={span} onChange={setSpan} />}>
      <View className="gap-s2">
        {shown.map((e) => (
          <View key={e.id} className="min-w-0 gap-s1">
            <Text medium numberOfLines={2}>{e.title}</Text>
            {e.sub ? <Text size="secondary" tone="label">{e.sub}</Text> : null}
          </View>
        ))}
      </View>
    </HomeSection>
  );
}
