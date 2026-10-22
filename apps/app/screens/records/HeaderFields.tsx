import { useState } from "react";
import { View } from "react-native";
import { Button, Chip, IconButton, Row, Sheet, Switch, Text } from "@vyre/ui";
import { moveName, toggleName } from "../../ui/views/layout.js";

/**
 * The fields pinned under a record's name: a small pencil beside them opens this sheet to turn fields on, off and move them. It saves to the scope the layout menu has chosen (yours, or the Space default for an admin).
 */
export function HeaderFields({ fields, names, spaceScope, onNames, trigger = true, open: openProp, onOpen }: {
  fields: { name: string; label: string }[]; names: string[]; spaceScope: boolean; onNames: (n: string[]) => void;
  /** false when the page opens this sheet from its More menu. */ trigger?: boolean; open?: boolean; onOpen?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const setOpen = (next: boolean) => { if (openProp === undefined) setOwn(next); onOpen?.(next); };
  // The record's ID is the header line, never a fact under the name.
  const list = fields.filter((f) => f.name !== "ref");
  const shown = names.filter((n) => n !== "ref");
  const label = (n: string) => list.find((f) => f.name === n)?.label ?? n;
  const rest = list.map((f) => f.name).filter((n) => !shown.includes(n));
  return (
    <>
      {trigger ? <IconButton icon="edit" label="Edit header" onPress={() => setOpen(true)} /> : null}
      <Sheet open={open} onClose={() => setOpen(false)} title="Header fields">
        <View className="gap-s3">
          <Text tone="muted">{spaceScope ? "These show under the name for everyone who has not set their own." : "These show under the name for you. Up to eight."}</Text>
          {shown.map((n, i) => (
            <Row key={n} title={label(n)} end={<View className="flex-row items-center gap-s1"><Button kind="ghost" size="sm" label="Up" disabled={i === 0} onPress={() => onNames(moveName(shown, n, -1))} /><Button kind="ghost" size="sm" label="Down" disabled={i === shown.length - 1} onPress={() => onNames(moveName(shown, n, 1))} /><Switch on label={`Show ${label(n)}`} onChange={() => onNames(toggleName(shown, n))} /></View>} />
          ))}
          {rest.length ? <Text size="caption" tone="label">Add a field</Text> : null}
          <View className="flex-row flex-wrap gap-s1">{rest.map((n) => <Chip key={n} onPress={() => shown.length < 8 && onNames(toggleName(shown, n))}>{`+ ${label(n)}`}</Chip>)}</View>
          <View className="flex-row"><Button kind="primary" label="Done" onPress={() => setOpen(false)} /></View>
        </View>
      </Sheet>
    </>
  );
}
