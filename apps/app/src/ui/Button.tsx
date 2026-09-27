import { Pressable, StyleSheet, Text } from "react-native";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";

export type ButtonStyle = "primary" | "secondary" | "ghost" | "outline";

/**
 * The app's buttons (the boards' four): primary (lime ink on the signal), secondary (a quiet
 * fill), ghost (text only) and outline (a rule, for an action that should not look like the way on).
 */
export function Button({ label, kind = "secondary", onPress, disabled, small, testID }: {
  label: string;
  kind?: ButtonStyle;
  onPress?: () => void;
  disabled?: boolean;
  small?: boolean;
  testID?: string;
}) {
  const { color } = useTheme();
  const bg = kind === "primary" ? color.primaryBg : kind === "secondary" ? color.hover : "transparent";
  const ink = disabled ? color.label : kind === "primary" ? color.primaryInk : kind === "ghost" ? color.text2 : color.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={[
        small ? styles.small : styles.touch,
        { backgroundColor: disabled && kind === "primary" ? color.hover : bg },
        kind === "outline" && { borderWidth: 1, borderColor: color.ruleStrong },
        kind === "ghost" && styles.ghost,
      ]}
    >
      <Text style={[small ? styles.textSmall : styles.text, { color: ink }]}>{label}</Text>
    </Pressable>
  );
}

const phone = tokens.type.phone;
const styles = StyleSheet.create({
  touch: { height: tokens.control.touch, paddingHorizontal: tokens.space[5], borderRadius: tokens.radius.buttonTouch, justifyContent: "center", alignItems: "center" },
  small: { height: tokens.control.sm, paddingHorizontal: tokens.space[4], borderRadius: tokens.radius.button, justifyContent: "center", alignItems: "center" },
  ghost: { paddingHorizontal: tokens.space[3] },
  text: { fontSize: phone.read[0], lineHeight: phone.read[1], fontWeight: tokens.font.weight.strong },
  textSmall: { fontSize: phone.base[0], lineHeight: phone.base[1], fontWeight: tokens.font.weight.strong },
});
