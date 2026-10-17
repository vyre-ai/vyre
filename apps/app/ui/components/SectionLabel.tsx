import { Text as RNText, View } from "react-native";
import { facesFor } from "../../src/theme/fonts";
import { useUiTheme } from "../theme";

/**
 * A section's label: 12, sentence case, in the label colour (the owner's ruling: no all-caps labels anywhere). 24 above and 8 below on a phone page;
 * `meta` is a quiet count on the right. Nothing else on a screen is this small.
 */
export function SectionLabel({ children, meta, first, accessibilityRole = "header" }: { children: string; meta?: string; /** The first block of a stack: no space above. */ first?: boolean; accessibilityRole?: "header" | "text" }) {
  const { resolved, color } = useUiTheme();
  const regular = facesFor(resolved.font).regular;
  const style = { ...regular, fontSize: 12, lineHeight: 16 };
  return (
    <View className={first ? "flex-row items-baseline gap-s2 pb-s2" : "flex-row items-baseline gap-s2 pt-s6 pb-s2"}>
      <RNText accessibilityRole={accessibilityRole} style={[style, { color: color.label }]}>{children}</RNText>
      {meta ? <RNText style={[style, { color: color.faint }]}>{meta}</RNText> : null}
    </View>
  );
}
