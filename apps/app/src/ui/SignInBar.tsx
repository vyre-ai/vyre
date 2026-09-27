import { Pressable, StyleSheet, Text, View } from "react-native";
import { signIn } from "../api/box";
import { useSignInNeeded } from "../state/connection";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";

/**
 * The box answered 401 person_session_required: writes wait in the outbox (none is lost or run
 * twice) until the person signs in. One line, one button, which starts the box's sign-in.
 */
export function SignInBar() {
  const needed = useSignInNeeded();
  const { color } = useTheme();
  if (!needed) return null;
  return (
    <View style={[styles.bar, { backgroundColor: color.panel, borderBottomColor: color.rule }]}>
      <Text style={[styles.text, { color: color.text }]}>Sign in to your box to send what waits</Text>
      <Pressable accessibilityRole="button" onPress={() => void signIn()} style={[styles.btn, { backgroundColor: color.primaryBg }]}>
        <Text style={[styles.btnText, { color: color.primaryInk }]}>Sign in</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[4],
    paddingHorizontal: tokens.layout.gutterPhone,
    paddingVertical: tokens.space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { flex: 1, fontSize: tokens.type.phone.base[0], lineHeight: tokens.type.phone.base[1] },
  btn: { height: tokens.control.sm, paddingHorizontal: tokens.space[5], borderRadius: tokens.radius.button, justifyContent: "center" },
  btnText: { fontSize: tokens.type.phone.base[0], lineHeight: tokens.type.phone.base[1], fontWeight: tokens.font.weight.strong },
});
