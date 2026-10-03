import { Text as RNText, View } from "react-native";
import { facesFor } from "../../src/theme/fonts";
import { useUiTheme } from "../theme";

/**
 * A section's label: 11 mono, uppercase, tracked 0.08em, in the label colour (ui-system.md, the label role). 24 above and 8 below on a phone page;
 * `meta` is a quiet count on the right. Nothing else on a screen is this small.
 */
export function SectionLabel({ children, meta, accessibilityRole = "header" }: { children: string; meta?: string; accessibilityRole?: "header" | "text" }) {
  const { resolved, color } = useUiTheme();
  const mono = facesFor(resolved.font).mono;
  const style = { ...mono, fontSize: 11, lineHeight: 14, letterSpacing: 0.88, textTransform: "uppercase" as const };
  return (
    <View className="flex-row items-baseline gap-s2 pt-s6 pb-s2">
      <RNText accessibilityRole={accessibilityRole} style={[style, { color: color.label }]}>{children}</RNText>
      {meta ? <RNText style={[style, { color: color.faint }]}>{meta}</RNText> : null}
    </View>
  );
}
