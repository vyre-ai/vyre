import { View } from "react-native";
import { Button, Card, Row, SectionLabel, Text } from "../index";

export type BackgroundTask = { id: string; title: string; status: string; live?: boolean };

export function BackgroundTasksCard({ tasks, onOpen, onStop }: {
  tasks: readonly BackgroundTask[];
  onOpen?: () => void;
  onStop?: (id: string) => void;
}) {
  const live = tasks.filter((t) => t.live ?? /^(running|working|started|pending)$/i.test(t.status));
  if (!tasks.length) return null;
  return (
    <Card>
      <View style={{ gap: 4 }}>
        <SectionLabel first meta={live.length ? String(live.length) : undefined}>Running here</SectionLabel>
        {tasks.slice(0, 3).map((t) => (
          <Row key={t.id} dense title={t.title} sub={t.status}
            end={t.live && onStop ? <Button kind="ghost" size="sm" label="Stop" onPress={() => onStop(t.id)} /> : undefined} />
        ))}
        {tasks.length > 3 ? <Text size="caption" tone="muted">{`${tasks.length - 3} more in the panel`}</Text> : null}
        {onOpen ? <Row dense title="See all background work" chevron onPress={onOpen} /> : null}
      </View>
    </Card>
  );
}
