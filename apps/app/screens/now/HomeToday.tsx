import { useMemo, useState } from "react";
import { View } from "react-native";
import { Card, Segmented, Text } from "@vyre/ui";
import { Section } from "../../ui/tasks/Section";
import { rangeOf } from "../calendar/logic.js";

export type Dated = { id: string; at: number; title: string; sub?: string };

/** Today on Home: the dated records, as the day or the week. */
export function HomeToday({ items, now }: { items: Dated[]; now: number }) {
  const [span, setSpan] = useState<"day" | "week">("day");
  const shown = useMemo(() => {
    const { from, to } = rangeOf(span, new Date(now));
    return items.filter((e) => e.at >= from.getTime() && e.at < to.getTime()).sort((a, b) => a.at - b.at);
  }, [items, now, span]);
  return (
    <Section title="Today">
      <View className="gap-s3">
        <Segmented label="When" options={[["day", "Day"], ["week", "Week"]]} value={span} onChange={setSpan} />
        {shown.length ? (
          <Card>
            <View className="gap-s3">
              {shown.map((e) => (
                <View key={e.id} className="min-w-0 gap-s1">
                  <Text medium numberOfLines={2}>{e.title}</Text>
                  {e.sub ? <Text size="secondary" tone="label">{e.sub}</Text> : null}
                </View>
              ))}
            </View>
          </Card>
        ) : <Text tone="label">{span === "week" ? "Nothing this week." : "Nothing today."}</Text>}
      </View>
    </Section>
  );
}
