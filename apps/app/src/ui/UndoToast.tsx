import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { answers } from "../state/live";
import { useToast } from "../state/needs";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";

/**
 * The Undo toast for an answer given by a swipe: it lasts tokens.motion.undo (4 s), the time the
 * answer is held before it goes to the outbox. It leaves when the answer is sent, so Undo is only
 * ever offered while it can still work.
 */
export function UndoToast() {
  const toast = useToast();
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  if (!toast) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + tokens.control.touchLg + tokens.space[4] }]}>
      <View accessibilityRole="alert" style={[styles.toast, { backgroundColor: color.panel, borderColor: color.ruleStrong }]}>
        <Text numberOfLines={1} style={[styles.text, { color: color.text }]}>{toast.label}</Text>
        <Pressable accessibilityRole="button" onPress={() => answers.undo(toast.id)} style={styles.undo} hitSlop={8}>
          <Text style={[styles.undoText, { color: color.focus }]}>Undo</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: tokens.layout.gutterPhone, right: tokens.layout.gutterPhone, alignItems: "center" },
  toast: {
    maxWidth: 520,
    width: "100%",
    minHeight: tokens.control.touch,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[4],
    paddingLeft: tokens.space[5],
    paddingRight: tokens.space[3],
    borderRadius: tokens.radius.buttonTouch,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: { flex: 1, fontSize: tokens.type.phone.base[0], lineHeight: tokens.type.phone.base[1] },
  undo: { height: tokens.control.touch, justifyContent: "center", paddingHorizontal: tokens.space[3] },
  undoText: { fontSize: tokens.type.phone.base[0], lineHeight: tokens.type.phone.base[1], fontWeight: tokens.font.weight.strong },
});
