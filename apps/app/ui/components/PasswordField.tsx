import { useState } from "react";
import { View } from "react-native";
import { passwordStrength } from "../lib/strength.js";
import { Button } from "./Button";
import { Field } from "./Field";
import { PasswordStrength } from "./PasswordStrength";

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
        {meter ? <PasswordStrength value={value} /> : <View className="flex-1" />}
        <Button kind="ghost" size="sm" icon={shown ? "eye-off" : "eye"} label={shown ? "Hide" : "Show"} onPress={() => setShown(!shown)} />
      </View>
    </View>
  );
}
