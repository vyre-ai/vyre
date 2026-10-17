import { View } from "react-native";
import { Banner, EmptyState, Row, Sheet, Text } from "../index";

export type OpinionTarget = { id: string; label: string; sub?: string };

export function SecondOpinionSheet({ open, targets, busy, problem, onClose, onPick }: {
  open: boolean;
  targets: readonly OpinionTarget[];
  busy?: boolean;
  problem?: string;
  onClose: () => void;
  onPick: (to: string) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Second opinion">
      <View style={{ gap: 8 }}>
        <Text tone="muted" size="caption">Another assistant or model answers the same question from scratch and says where it differs.</Text>
        {problem ? <Banner tone="warn">{problem}</Banner> : null}
        {!targets.length ? <EmptyState title="No other model here" body="Add another assistant or switch model first." /> : null}
        {targets.map((t) => (
          <Row key={t.id} dense title={t.label} sub={t.sub} chevron onPress={() => !busy && onPick(t.id)} />
        ))}
      </View>
    </Sheet>
  );
}
