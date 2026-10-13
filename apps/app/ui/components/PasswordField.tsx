import { useState } from "react";
import { View } from "react-native";
import { cn } from "../lib/cn";
import { passwordStrength } from "../lib/strength.js";
import { Button } from "./Button";
import { Field } from "./Field";
import { Text } from "./Text";

const FILL = ["bg-edge", "bg-err", "bg-warn", "bg-primary", "bg-ok"] as const;

/**
 * A password field with Show and Hide, and, with `meter`, a four step strength bar and one line of advice under it ("Use at least 8 characters"). The bar needs a word as well as a colour,
 * so the level is written beside it ("Fair"). `error` replaces the advice; it names what is wrong and what to do.
 */
export function PasswordField({ label, value, onChangeText, meter, error, help, name }: { label: string; value: string; onChangeText: (v: string) => void; meter?: boolean; error?: string; help?: string; name?: string }) {
  const [shown, setShown] = useState(false);
  const s = passwordStrength(value);
  return (
    <View className="gap-s2">
      <Field label={label} name={name} kind={shown ? "text" : "password"} value={value} onChangeText={onChangeText} error={error} help={error ? undefined : meter && value ? s.hint : help} />
      <View className="flex-row items-center justify-between gap-s3">
        {meter ? (
          <View className="min-w-0 flex-1 flex-row items-center gap-s2" accessibilityRole="progressbar" accessibilityLabel={`Password strength: ${s.label || "none yet"}`} accessibilityValue={{ min: 0, max: 4, now: s.score }}>
            {[1, 2, 3, 4].map((i) => <View key={i} className={cn("h-s1 flex-1 rounded-full", i <= s.score ? FILL[s.score] : "bg-edge")} />)}
            <Text size="caption" tone="muted" className="min-w-0">{s.label}</Text>
          </View>
        ) : <View className="flex-1" />}
        <Button kind="ghost" size="sm" icon={shown ? "eye-off" : "eye"} label={shown ? "Hide" : "Show"} onPress={() => setShown(!shown)} />
      </View>
    </View>
  );
}
