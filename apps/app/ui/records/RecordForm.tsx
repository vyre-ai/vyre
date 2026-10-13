import { View } from "react-native";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { GroupedList } from "../components/GroupedList";
import type { Group } from "../components/groups.js";
import { Text } from "../components/Text";
import { editField } from "../fields/registry";
import type { FieldEnv } from "../fields/types";
import type { FieldRow } from "../setup/FieldRows";
import { formOrder } from "./logic.js";

// A picker draws its own label; the others get one from the form.
const OWN_LABEL = ["choice", "multi_choice", "link", "actor"];

/** The create form of any type, drawn from its fields: required first, hidden left out, each field in its own editor, errors under the field after a first try. */
export function RecordForm({ fields, values, onChange, errors, env, noun, groups = [], onCreate, onCreateMore, onCancel }: {
  fields: FieldRow[]; values: Record<string, any>; onChange: (name: string, v: any) => void; errors: Record<string, string>; env: FieldEnv; noun: string; /** The type's groups: the form is drawn in sections. */ groups?: Group[]; onCreate: () => void; onCreateMore?: () => void; onCancel: () => void;
}) {
  return (
    <View className="gap-s3">
      <GroupedList groups={groups} items={formOrder(fields as any) as any[]} itemNoun="fields" renderItems={(items) => (
        <Card className="gap-s4">
        {items.map((f: any) => (
          <View key={f.name} className="gap-s1">
            {OWN_LABEL.includes(f.kind) && !f.sealed ? null : <View className="flex-row items-baseline gap-s2"><Text size="caption" strong tone="label">{f.label}</Text>{f.required ? <Text size="caption" tone="label">Required</Text> : null}</View>}
            {editField({ kind: f.sealed ? "sealed" : f.kind, definition: OWN_LABEL.includes(f.kind) && f.required ? { ...f, label: `${f.label}, required` } : f, value: values[f.name], mode: "edit", error: errors[f.name], onChange: (v) => onChange(f.name, v) }, env)}
            {f.description ? <Text size="caption" tone="label">{f.description}</Text> : null}
          </View>
        ))}
        </Card>
      )} />
      <View className="flex-row flex-wrap gap-s2">
        <Button kind="primary" label={`Create ${noun}`} onPress={onCreate} />
        {onCreateMore ? <Button kind="secondary" label="Create and add another" onPress={onCreateMore} /> : null}
        <Button kind="ghost" label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}
