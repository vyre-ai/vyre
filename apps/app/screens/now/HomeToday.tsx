import { View } from "react-native";
import { Card, Divider, Row, SectionLabel, Chip } from "@vyre/ui";
import { timeOf } from "../../src/time/show.js";
import { todayStrip } from "./home-model.js";

/** What is on today, in time order: the next item marked, what has passed quiet. */
export function HomeToday({ items, now, onOpen }: { items: { id: string; at: number; title: string; sub?: string; record?: string }[]; now: number; onOpen?: (record: string) => void }) {
  const s = todayStrip(items, now);
  if (!s.rows.length) return null;
  return (
    <View className="gap-s1 pb-s3">
      <SectionLabel>Today</SectionLabel>
      <Card flush>
        {s.rows.map((r, i) => (
          <View key={r.id}>{i ? <Divider /> : null}
            <Row dense title={r.title} sub={`${timeOf(r.at)}${r.sub ? ` · ${r.sub}` : ""}`} end={r.id === s.nextId ? <Chip tone="accent">Next</Chip> : undefined} onPress={r.record && onOpen ? () => onOpen(r.record as string) : undefined} />
          </View>
        ))}
      </Card>
    </View>
  );
}
