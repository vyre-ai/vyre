import { View } from "react-native";
import { Button, Chip, Menu, Text } from "@vyre/ui";
import type { LayoutScope } from "./layout-state";

/**
 * The row under a table's views: how many columns it shows (a press opens the columns sheet), what it groups by, how tall its rows are, whether its first column stays put, and whose layout this is.
 * Columns and Group are the layout (records.layout.set, yours or the Space's); row height and the frozen column stay on this device.
 */
export function TableControls({ columns, onColumns, fields, groupBy, onGroup, density, onDensity, freeze, onFreeze, scope, mine }: {
  columns: number; onColumns: () => void;
  fields: { name: string; label: string }[]; groupBy?: string; onGroup: (name: string | null) => void;
  density: "comfortable" | "compact"; onDensity: (d: "comfortable" | "compact") => void;
  freeze: boolean; onFreeze: (on: boolean) => void;
  scope: LayoutScope; mine: boolean;
}) {
  const grouped = fields.find((f) => f.name === groupBy);
  return (
    <View className="flex-row flex-wrap items-center gap-s2">
      <Button kind="secondary" size="sm" icon="list" label={`Columns ${columns}`} onPress={onColumns} />
      <Menu trigger={<Button kind="secondary" size="sm" icon="grid" label={grouped ? `Group: ${grouped.label}` : "Group"} />}
        items={[{ label: "No grouping", selected: !grouped, onPress: () => onGroup(null) }, ...fields.map((f) => ({ label: f.label, selected: f.name === groupBy, onPress: () => onGroup(f.name) }))]} />
      <Chip onPress={() => onDensity(density === "comfortable" ? "compact" : "comfortable")}>{density === "comfortable" ? "Comfortable" : "Compact"}</Chip>
      <Chip selected={freeze} onPress={() => onFreeze(!freeze)}>Freeze first column</Chip>
      <View className="flex-1" />
      <Text size="caption" tone="label">{scope === "space" ? "Space default" : mine ? "Your layout" : "Space layout"}</Text>
    </View>
  );
}
