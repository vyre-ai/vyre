import { useState } from "react";
import { View } from "react-native";
import { Button, Chip, IconButton, Row, Sheet, Switch, Text } from "@vyre/ui";
import { moveName, toggleName } from "../../ui/views/layout.js";

/**
 * The fields pinned under a record's name: a small pencil beside them opens this sheet to turn fields on, off and move them. It saves to the scope the layout menu has chosen (yours, or the Space default for an admin).
 */
export function HeaderFields({ fields, names, spaceScope, onNames }: { fields: { name: string; label: string }[]; names: string[]; spaceScope: boolean; onNames: (n: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const label = (n: string) => fields.find((f) => f.name === n)?.label ?? n;
  const rest = fields.map((f) => f.name).filter((n) => !names.includes(n));
  return (
    <>
      <IconButton icon="edit" label="Edit header" onPress={() => setOpen(true)} />
      <Sheet open={open} onClose={() => setOpen(false)} title="Header fields">
        <View className="gap-s3">
          <Text tone="muted">{spaceScope ? "These show under the name for everyone who has not set their own." : "These show under the name for you. Up to eight."}</Text>
          {names.map((n, i) => (
            <Row key={n} title={label(n)} end={<View className="flex-row items-center gap-s1"><Button kind="ghost" size="sm" label="Up" disabled={i === 0} onPress={() => onNames(moveName(names, n, -1))} /><Button kind="ghost" size="sm" label="Down" disabled={i === names.length - 1} onPress={() => onNames(moveName(names, n, 1))} /><Switch on label={`Show ${label(n)}`} onChange={() => onNames(toggleName(names, n))} /></View>} />
          ))}
          {rest.length ? <Text size="caption" tone="label">Add a field</Text> : null}
          <View className="flex-row flex-wrap gap-s1">{rest.map((n) => <Chip key={n} onPress={() => names.length < 8 && onNames(toggleName(names, n))}>{`+ ${label(n)}`}</Chip>)}</View>
          <View className="flex-row"><Button kind="primary" label="Done" onPress={() => setOpen(false)} /></View>
        </View>
      </Sheet>
    </>
  );
}
