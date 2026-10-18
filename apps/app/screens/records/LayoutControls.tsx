import { useState } from "react";
import { View } from "react-native";
import { Button, Chip, IconButton, Menu, Row, Sheet, Switch, Text } from "@vyre/ui";
import type { LayoutScope } from "./layout-state";
import { moveName, toggleName } from "../../ui/views/layout.js";

/**
 * The layout of a type, kept out of the way: one icon that opens "My layout" or "Space default", "Columns..." and "Reset to Space layout". Your own layout lies over the Space's; only an owner or admin changes
 * the Space's. The columns sheet turns fields on and off and moves them up and down; it saves to the scope chosen.
 */
export function LayoutControls({ fields, columns, scope, onScope, mine, onColumns, onReset }: { fields: { name: string; label: string }[]; columns: string[]; scope: LayoutScope; onScope: (s: LayoutScope) => void; mine: boolean; onColumns: (c: string[]) => void; onReset: () => void }) {
  const [open, setOpen] = useState(false);
  const items = [
    { label: "My layout", selected: scope === "mine", onPress: () => onScope("mine") },
    { label: "Space default", selected: scope === "space", onPress: () => onScope("space") }, // always offered: the kernel decides who may, and a refusal shows in its own words
    { label: "Columns...", onPress: () => setOpen(true) },
    ...(mine ? [{ label: "Reset to Space layout", onPress: onReset }] : []),
  ];
  const label = (n: string) => fields.find((f) => f.name === n)?.label ?? n;
  const off = fields.map((f) => f.name).filter((n) => !columns.includes(n));
  return (
    <>
      <Menu trigger={<IconButton icon="grid" label={scope === "space" ? "Layout, Space default" : "Layout"} />} items={items} />
      <Sheet open={open} onClose={() => setOpen(false)} title="Columns">
        <View className="gap-s3">
          <Text tone="muted">{scope === "space" ? "Everyone who has not set their own layout sees this." : "Only you see this. The Space's layout shows again when you reset it."}</Text>
          {columns.map((n, i) => (
            <Row key={n} title={label(n)} end={<View className="flex-row items-center gap-s1"><Button kind="ghost" size="sm" label="Up" disabled={i === 0} onPress={() => onColumns(moveName(columns, n, -1))} /><Button kind="ghost" size="sm" label="Down" disabled={i === columns.length - 1} onPress={() => onColumns(moveName(columns, n, 1))} /><Switch on label={`Show ${label(n)}`} onChange={() => onColumns(toggleName(columns, n))} /></View>} />
          ))}
          {off.length ? <Text size="caption" tone="label">Hidden</Text> : null}
          <View className="flex-row flex-wrap gap-s1">{off.map((n) => <Chip key={n} onPress={() => onColumns(toggleName(columns, n))}>{`+ ${label(n)}`}</Chip>)}</View>
          <View className="flex-row"><Button kind="primary" label="Done" onPress={() => setOpen(false)} /></View>
        </View>
      </Sheet>
    </>
  );
}
