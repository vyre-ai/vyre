// A story as one list: entries newest first under a heading per day, each a type mark and one plain line. The project's timeline and every record's timeline are this (work.timeline), so there is one way a story reads.
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Card, Chip, Divider, Icon, Row, SectionLabel, Text } from "@vyre/ui";
import type { IconName } from "@vyre/ui";
import { dayLabel, entryAction, groupByDay } from "./days.js";

export type Entry = { type: string; kind: string; id: string; urn: string; title: string; line: string; at: number; mine?: boolean; shared?: boolean; chat?: string };
const ICON: Record<string, IconName> = { stage: "projects", task: "task", email: "mail", text: "chat", call: "phone", meeting: "cal", chat: "chat", file: "file", flow: "flows", document: "file", record: "records", person: "person" };

export function TimelineEntries({ rows }: { rows: Entry[] }) {
  const router = useRouter();
  return (
    <View className="gap-s3">
      {groupByDay(rows).map((g) => (
        <View key={g.key}>
          <SectionLabel>{dayLabel(g.at)}</SectionLabel>
          <Card flush>
            {g.items.map((e, i) => {
              const act = entryAction(e);
              return (
                <View key={`${e.type}:${e.id}`}>
                  {i ? <Divider /> : null}
                  <Row dense lead={<View className="pr-s3"><Icon name={ICON[e.kind] ?? "records"} /></View>} title={<Text medium size="body">{e.line}</Text>} end={e.type === "chat" ? <Chip>{e.mine ? "Yours" : "Shared"}</Chip> : undefined} onPress={act ? () => router.push(act.route as never) : undefined} />
                </View>
              );
            })}
          </Card>
        </View>
      ))}
    </View>
  );
}
