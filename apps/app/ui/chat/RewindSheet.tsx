import { View } from "react-native";
import { Banner, Button, EmptyState, Row, Sheet, Text } from "../index";

export type RewindPoint = { uuid: string; text: string; at?: number | null };

export function RewindSheet({ open, points, busy, problem, onClose, onPick }: {
  open: boolean;
  points: readonly RewindPoint[];
  busy?: boolean;
  problem?: string;
  onClose: () => void;
  onPick: (uuid: string) => void;
}) {
  const clip = (t: string) => (t.length > 120 ? `${t.slice(0, 117)}…` : t);
  return (
    <Sheet open={open} onClose={onClose} title="Go back to">
      <View style={{ gap: 8 }}>
        <Text tone="muted" size="caption">Your messages, newest first. The chat continues from just before the one you pick.</Text>
        {problem ? <Banner tone="warn">{problem}</Banner> : null}
        {!points.length ? <EmptyState title="Nothing to go back to" body="Send a message first." /> : null}
        {points.map((p) => (
          <Row key={p.uuid} dense title={clip(p.text)} sub={p.at ? new Date(p.at).toLocaleString() : undefined}
            end={<Button size="sm" label="Rewind" disabled={busy} onPress={() => onPick(p.uuid)} />} />
        ))}
      </View>
    </Sheet>
  );
}
