// One item's fields as rows to fill or change: each a name in its one form (shown live as it is typed), a value kept exactly as given, and a Plain switch. A value that starts or
// ends with a space or a new line gets a quiet note and a one-tap "Remove it"; nothing is changed for the person. Shared by the Add sheet and an item's Edit.
// Two fields whose names are one name ignoring case and punctuation are flagged: "This item already has API_KEY".
import { useState } from "react";
import { View } from "react-native";
import { Button, Field, IconButton, Switch, Text } from "@vyre/ui";
import { fieldProblems, liveName, valueWarning, withoutEnds, type DField } from "./env-model.js";

/** A secret is masked as it is typed, with an eye to look at it. */
function SecretInput({ label, value, error, onChange, multiline }: { label: string; value: string; error?: string; onChange: (v: string) => void; multiline?: boolean }) {
  const [shown, setShown] = useState(false);
  if (multiline) return <Field label={label} value={value} error={error} onChangeText={onChange} multiline lines={5} />;
  return (
    <View className="flex-row items-end gap-s2">
      <View className="min-w-0 flex-1"><Field label={label} kind={shown ? "text" : "password"} mono={shown} value={value} error={error} onChangeText={onChange} /></View>
      <IconButton icon={shown ? "eye-off" : "eye"} label={shown ? `Hide ${label}` : `Show ${label}`} onPress={() => setShown(!shown)} />
    </View>
  );
}

export function FieldsEditor({ fields, onChange, canRemove, canAdd, onAdd, multiline, valueLabel }: {
  /** A field with a label is the app's own (a module's need, a catalog app, a login): its name is shown, not typed. */ fields: DField[]; onChange: (id: string, change: Partial<DField>) => void;
  canRemove?: boolean; canAdd?: boolean; onAdd?: () => void; multiline?: boolean; /** "New value" on an Edit where a value may be left as it is. */ valueLabel?: string;
}) {
  const problems = fieldProblems(fields, { needValue: false });
  return (
    <View className="gap-s4">
      {fields.filter((f) => f.on).map((f) => {
        const fixedNames = Boolean(f.label);
        const shown = f.label ? f.label : liveName(f.key) || "New field";
        const warn = valueWarning(f.value);
        return (
          <View key={f.id} className="gap-s2">
            {fixedNames ? <View className="gap-s1"><Text strong>{shown}</Text><Text mono size="caption" tone="label">{liveName(f.key)}</Text></View>
              : <Field label="Field name" mono value={liveName(f.key)} onChangeText={(v) => onChange(f.id, { key: v })} placeholder="GHL_API_KEY" error={problems[f.id]} />}
            {f.secret
              ? <SecretInput label={valueLabel ?? (fixedNames ? shown : "Value")} value={f.value} onChange={(v) => onChange(f.id, { value: v })} multiline={multiline} />
              : <Field label={valueLabel ?? (fixedNames ? shown : "Value")} value={f.value} onChangeText={(v) => onChange(f.id, { value: v })} multiline={multiline} lines={multiline ? 5 : undefined} />}
            {warn ? <View className="flex-row flex-wrap items-center gap-s2"><Text size="caption" tone="label">{warn}</Text><Button kind="ghost" size="sm" label="Remove it" onPress={() => onChange(f.id, { value: withoutEnds(f.value) })} /></View> : null}
            {f.help ? <Text size="caption" tone="label">{f.help}</Text> : null}
            <View className="flex-row flex-wrap items-center gap-s3">
              {fixedNames ? null : <View className="flex-row items-center gap-s2"><Switch label={`${liveName(f.key) || "This field"} is plain`} on={!f.secret} onChange={(plain) => onChange(f.id, { secret: !plain })} /><Text size="caption" tone="label">{f.secret ? "Secret: hidden until revealed" : "Plain: an id or address, shown in full"}</Text></View>}
              {canRemove ? <Button kind="ghost" size="sm" icon="trash" label="Remove field" onPress={() => onChange(f.id, { on: false })} /> : null}
            </View>
          </View>
        );
      })}
      {canAdd && onAdd ? <View className="self-start"><Button kind="secondary" size="sm" icon="plus" label="Add another field" onPress={onAdd} /></View> : null}
    </View>
  );
}
