import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Field, Icon, Text } from "@vyre/ui";

/**
 * A name shown as text that turns into a field when pressed (Enter or Save keeps it, Escape or Cancel leaves it). `size` is the text size it is drawn in: "page" for a page title, "body" for a card's own name.
 * A name that is empty or unchanged is not saved. Not editable: just the text.
 */
export function InlineName({ value, placeholder, size = "body", strong = true, editable = true, label, onCommit, startEmpty = false }: { value: string; placeholder?: string; size?: "page" | "body"; strong?: boolean; editable?: boolean; label?: string; onCommit: (v: string) => void; /** A thing just made, still on its placeholder name: it opens ready to type, with the field empty. Nothing is ever selected for an existing name. */ startEmpty?: boolean }) {
  const [editing, setEditing] = useState(startEmpty);
  const [text, setText] = useState(startEmpty ? "" : value);
  const shown = value.trim() || placeholder || "";
  if (!editable) return <Text size={size} strong={strong} accessibilityRole={size === "page" ? "header" : undefined}>{shown}</Text>;
  if (!editing) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`Rename ${label ?? shown}`} onPress={() => { setText(value); setEditing(true); }} className="flex-row items-center gap-s2 self-start">
        <Text size={size} strong={strong} tone={value.trim() ? "default" : "muted"} accessibilityRole={size === "page" ? "header" : undefined}>{shown}</Text>
        <Icon name="edit" size={14} tone="label" />
      </Pressable>
    );
  }
  const done = (keep: boolean) => { const next = text.trim(); setEditing(false); if (keep && next && next !== value.trim()) onCommit(next); };
  return (
    <View className="min-w-0 flex-row items-end gap-s2">
      <View className="min-w-0 flex-1"><Field label={label} name={label ?? "Name"} value={text} onChangeText={setText} placeholder={placeholder} autoFocus onSubmit={() => done(true)} /></View>
      <Button kind="primary" size="sm" label="Save" disabled={!text.trim()} onPress={() => done(true)} />
      <Button kind="ghost" size="sm" label="Cancel" onPress={() => done(false)} />
    </View>
  );
}

/** One line to add something: a field and a button, Enter works too. The text is handed over and the line is emptied; an empty line adds nothing. */
export function AddLine({ placeholder, label, onAdd, disabled }: { placeholder: string; label: string; onAdd: (text: string) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const add = () => { const t = text.trim(); if (!t || disabled) return; setText(""); onAdd(t); };
  return (
    <View className="min-w-0 flex-row items-end gap-s2">
      <View className="min-w-0 flex-1"><Field name={label} value={text} onChangeText={setText} placeholder={placeholder} onSubmit={add} disabled={disabled} /></View>
      <Button kind="secondary" size="sm" icon="plus" label={label} disabled={!text.trim() || disabled} onPress={add} />
    </View>
  );
}
