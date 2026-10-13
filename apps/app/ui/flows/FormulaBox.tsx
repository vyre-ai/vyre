import { View } from "react-native";
import { Banner } from "../components/Banner";
import { Field } from "../components/Field";
import { Menu } from "../components/Menu";
import { Button } from "../components/Button";
import { Text } from "../components/Text";
import { FUNCTION_HELP, previewExpr } from "./preview.js";

/** A formula in the engine's own language with a live preview on made-up sample data, and the functions it may call. What the preview says is what the Flow will do. */
export function FormulaBox({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const p = previewExpr(value);
  return (
    <View className="gap-s2">
      <Field label={label} value={value} onChangeText={onChange} placeholder={placeholder ?? "For example round(trigger.amount * 1.2)"} mono />
      <View className="flex-row flex-wrap items-center gap-s2">
        <Menu align="start" trigger={<Button kind="ghost" size="sm" icon="info" label="Functions" />} items={FUNCTION_HELP.map(([f, words]) => ({ label: `${f}: ${words}`, onPress: () => onChange(`${value}${value && !/\s$/.test(value) ? " " : ""}${f}`) }))} />
        <Text size="caption" tone="label">Read a field as trigger.amount or steps.find1.rows. Use + - * / and and, or, not, ==, !=, &lt;, &gt;.</Text>
      </View>
      {value.trim() ? <Banner tone={p.ok ? "plain" : "warn"} icon={p.ok ? "check" : "warning"}><Text>{p.ok ? `On sample data this gives ${p.text}` : p.text}</Text></Banner> : null}
    </View>
  );
}
