import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { boxName } from "../api/box";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";
import { Avatar } from "./Avatar";
import { BackButton } from "./BackButton";
import { Button, focusData } from "./Button";

/**
 * A page: the phone header and a body. Layout branches on width only, never the platform. A tab
 * page carries the person's avatar that opens the Places sheet (Vault, Devices, Settings); a
 * pushed place carries Back instead, named for `backTo` (the page it came from) when the caller
 * knows it, else for the page under it in the stack.
 */
export function Screen({ title, back, backTo, children }: { title: string; back?: boolean; backTo?: string; children?: ReactNode }) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = boxName() || "v";
  return (
    <View style={[styles.page, { backgroundColor: color.bg, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: color.rule }]}>
        {back ? <BackButton to={backTo} /> : null}
        <Text accessibilityRole="header" numberOfLines={1} style={[type.title, styles.title, { color: color.text }]}>
          {title}
        </Text>
        {back ? null : <PlacesButton name={me} onPress={() => router.push("/places")} />}
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

/** The person's avatar as the button to Places: 34 visible in a 44 target, `rule` fill on hover and press (avatar spec). */
function PlacesButton({ name, onPress }: { name: string; onPress: () => void }) {
  const { scheme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Places, ${name}`}
      testID="open-places"
      onPress={onPress}
      style={styles.avatarHit}
      {...focusData(scheme)}
    >
      {(st) => <Avatar name={name} size={34} person hot={st.pressed || !!(st as { hovered?: boolean }).hovered} />}
    </Pressable>
  );
}

/** The quiet empty state: one plain line in the label colour and, where there is a next step, one action under it. */
export function Empty({ text, action }: { text: string; action?: { label: string; onPress: () => void } }) {
  const { color } = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[type.read, { color: color.label }]}>{text}</Text>
      {action ? <Button kind="primary" label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: {
    height: tokens.layout.phoneHeader,
    paddingHorizontal: tokens.layout.gutterPhone,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1 },
  avatarHit: { width: tokens.control.touch, height: tokens.control.touch, alignItems: "flex-end", justifyContent: "center" },
  body: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: tokens.space[4], padding: tokens.layout.gutterPhone },
});
