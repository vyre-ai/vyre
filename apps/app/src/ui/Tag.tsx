import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";

/** A fact on a row (the chip spec's tag): 20 tall, a `hover` fill, no border, meta text2. Never a touch target. */
export function Tag({ text }: { text: string }) {
  const { color } = useTheme();
  return (
    <View style={[styles.tag, { backgroundColor: color.hover }]}>
      <Text numberOfLines={1} style={[type.meta, { color: color.text2 }]}>
        {text}
      </Text>
    </View>
  );
}

// 20 tall, padding 0 6: the tag's own geometry, from the space steps.
const styles = StyleSheet.create({
  tag: { height: tokens.space[6] - tokens.space[2], justifyContent: "center", paddingHorizontal: tokens.space[2] + tokens.space[1], borderRadius: tokens.radius.chip },
});
