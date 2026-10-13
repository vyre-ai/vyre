import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button } from "../components/Button";
import { Text } from "../components/Text";
import { TemplateComposer } from "./TemplateComposer";
import type { Draft, Options } from "./logic.js";

/** A templated field of a step shown as its words, with a button that opens the full-screen composer. */
export function ComposeField({ label, value, onChange, draft, stepId, options, placeholder, multiline = true, count = false }: {
  label: string; value: string; onChange: (v: string) => void; draft: Draft; stepId: string; options: Options; placeholder?: string; multiline?: boolean; count?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-s1">
      <Text size="caption" strong tone="label">{label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Write ${label}`} onPress={() => setOpen(true)} className="min-h-12 rounded-card border border-edge bg-surface-3 px-s3 py-s2">
        <Text numberOfLines={multiline ? 4 : 1} tone={value ? "default" : "muted"}>{value || placeholder || "Write it"}</Text>
      </Pressable>
      <View className="flex-row"><Button kind="ghost" size="sm" icon="edit" label={`Write ${label.toLowerCase()} in full screen`} onPress={() => setOpen(true)} /></View>
      {open ? <TemplateComposer open onClose={() => setOpen(false)} title={label} value={value} onChange={onChange} draft={draft} stepId={stepId} options={options} multiline={multiline} count={count} /> : null}
    </View>
  );
}
