// A quiet line after /later (planner.add): the reminder title and a link to the planner.
import { View } from "react-native";
import { Button, Icon, Text } from "../index";

export type LaterPlannerState =
  | { kind: "scheduled"; id?: string; title: string; when?: string }
  | { kind: "cleared" }
  | null;

export function laterWords(s: LaterPlannerState): string {
  if (!s || s.kind === "cleared") return "";
  const when = s.when ? ` (${s.when})` : "";
  return `Follow-up scheduled${when}: ${s.title}`;
}

export function LaterPlannerNote({ s, onOpenPlanner, onClear }: { s: LaterPlannerState; onOpenPlanner?: () => void; onClear: () => void }) {
  if (!s || s.kind === "cleared") return null;
  return (
    <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", paddingVertical: 4 }}>
      <Icon name="clock" tone="accent" />
      <Text size="caption" tone="label" style={{ flexShrink: 1 }}>{laterWords(s)}</Text>
      {onOpenPlanner ? <Button kind="secondary" size="sm" label="Planner" onPress={onOpenPlanner} /> : null}
      <Button kind="ghost" size="sm" label="Close" onPress={onClear} />
    </View>
  );
}
