import { useState } from "react";
import { View } from "react-native";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";
import { Text } from "../components/Text";
import { editField, renderField, KINDS } from "../fields/registry";
import { isSealedValue, sampleFor } from "../fields/logic.js";
import type { FieldEnv } from "../fields/types";
import { viewDefOf } from "./logic.js";

/** Add a field: a name, one of the fifteen kinds, and both renderers drawn live from a sample so the person sees how it shows and how it is edited. */
export function AddFieldSheet({ open, onClose, def, env, onAdd }: { open: boolean; onClose: () => void; def: any; env: FieldEnv; onAdd: (d: { label: string; kind: string }) => void }) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState("text");
  const vd = viewDefOf(def);
  const draft = { name: "new", label: label.trim() || "New field", kind, options: ["Option A", "Option B"], to: def.name };
  const sample = sampleFor(draft, env);
  return (
    <Sheet open={open} onClose={onClose} title={`Add a field to ${vd.plural}`}>
      <Text tone="muted">{`Every ${def.label.toLowerCase()} gets it. The list, board, record page and the agent's view pick it up with no new screen.`}</Text>
      <Field label="Name" value={label} placeholder="For example Preferred contact time" onChangeText={setLabel} />
      <View className="gap-s1">
        <Text size="caption" strong tone="label">Kind</Text>
        <View accessibilityRole="menu" className="flex-row flex-wrap gap-s1">{KINDS.map(([k, l]) => <Chip key={k} selected={k === kind} onPress={() => setKind(k)}>{l}</Chip>)}</View>
      </View>
      <View className="gap-s2">
        <Text size="caption" strong tone="label">How it shows</Text>
        {renderField({ kind, definition: draft as any, value: sample, mode: "view", read_only: true }, env)}
        <Text size="caption" strong tone="label">How it is edited</Text>
        <View key={kind}>{editField({ kind, definition: draft as any, value: isSealedValue(sample) ? null : sample, mode: "edit" }, env)}</View>
      </View>
      <View className="flex-row gap-s2">
        <Button kind="primary" label={`Add to ${vd.plural}`} disabled={!label.trim()} onPress={() => { onAdd({ label, kind }); setLabel(""); setKind("text"); }} />
        <Button kind="ghost" label="Cancel" onPress={onClose} />
      </View>
    </Sheet>
  );
}
