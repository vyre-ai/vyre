import { View } from "react-native";
import { Button } from "../components/Button";
import { DateTimeField } from "../components/DateTimeField";
import { Field } from "../components/Field";

/**
 * The value of a date or date-time field of a Create or Update step: the date picked by hand (the one DateTimeField), or, when the value is a `{token}` (a date from the Flow), the plain box, with a way back
 * to picking. A picked day is stored as 2026-10-28 and a picked moment as an ISO instant.
 */
export function DateValue({ label, name, value, onChange, kind, zone }: { label?: string; name: string; value: string; onChange: (v: string) => void; kind: "date" | "datetime"; zone?: string }) {
  const token = /\{.*\}/.test(value);
  if (token) {
    return (
      <View className="gap-s1">
        <Field label={label} name={name} value={value} onChangeText={onChange} placeholder="A date from the Flow, like {today} or {after.starts_at}" />
        <View className="flex-row"><Button kind="ghost" size="sm" label="Pick a date instead" onPress={() => onChange("")} /></View>
      </View>
    );
  }
  return (
    <View className="gap-s1">
      <DateTimeField label={label} name={name} dateOnly={kind === "date"} zone={zone} value={value} onChange={(v) => onChange(v ?? "")} />
      <View className="flex-row"><Button kind="ghost" size="sm" label="Use a date from the Flow instead" onPress={() => onChange(kind === "date" ? "{today}" : "{now}")} /></View>
    </View>
  );
}
