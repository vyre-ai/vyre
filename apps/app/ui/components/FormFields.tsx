import { View } from "react-native";
import { DateTimePicker } from "../DateTimePicker";
import { Field } from "./Field";
import { Select } from "./Select";
import { Switch } from "./Switch";
import { Text } from "./Text";
import { labelOf, type FormField } from "./form-fields-model.js";

/**
 * The questions of a card's form, one control each: text, a number, a day, one of a list, a yes or no, a file in Vyre Files. A required question says so in its label. `showMissing` marks the required
 * ones with no answer yet (set once the person tries to answer). The answers are held by the caller (`values`, `onChange`); form-fields-model.js says what is missing and what is handed in.
 */
export function FormFields({ fields, values, onChange, showMissing, now, disabled }: { fields: FormField[]; values: Record<string, string | boolean>; onChange: (values: Record<string, string | boolean>) => void; showMissing?: boolean; now: number; disabled?: boolean }) {
  const set = (name: string, v: string | boolean) => onChange({ ...values, [name]: v });
  return (
    <View className="gap-s3">
      {fields.map((f) => {
        const label = `${labelOf(f)}${f.required ? " (required)" : ""}`;
        const v = values[f.name];
        const error = showMissing && f.required && f.kind !== "boolean" && String(v ?? "").trim() === "" ? "Answer this to go on." : undefined;
        switch (f.kind) {
          case "boolean": return <Switch key={f.name} label={labelOf(f)} on={v === true} onChange={(on) => set(f.name, on)} />;
          case "choice": return <Select key={f.name} label={label} value={String(v ?? "")} options={(f.choices ?? []).map((c) => [c, c] as [string, string])} placeholder="Choose" onChange={(c) => set(f.name, c)} />;
          case "date": return (
            <View key={f.name} className="gap-s1">
              <DateTimePicker label={label} value={String(v ?? "")} onChange={(d) => set(f.name, d)} now={now} />
              {error ? <Text size="caption" tone="warn">{error}</Text> : null}
            </View>
          );
          case "number": return <Field key={f.name} label={label} kind="number" value={String(v ?? "")} onChangeText={(t) => set(f.name, t)} error={error} disabled={disabled} />;
          case "file": return <Field key={f.name} label={label} value={String(v ?? "")} onChangeText={(t) => set(f.name, t)} placeholder="For example contracts/signed.pdf" help="A file already in Vyre Files." error={error} disabled={disabled} />;
          default: return <Field key={f.name} label={label} value={String(v ?? "")} onChangeText={(t) => set(f.name, t)} error={error} disabled={disabled} />;
        }
      })}
    </View>
  );
}
