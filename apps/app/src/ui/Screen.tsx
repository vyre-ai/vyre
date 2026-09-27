import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { boxName } from "../api/box";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";

/**
 * A page: the phone header and a body. Layout branches on width only, never the platform. A tab
 * page carries the avatar that opens the Places sheet (Vault, Devices, Settings); a pushed place
 * carries Back instead.
 */
export function Screen({ title, back, children }: { title: string; back?: boolean; children?: ReactNode }) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View style={[styles.page, { backgroundColor: color.bg, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: color.rule }]}>
        {back ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} style={styles.back}>
            <Text style={[styles.backText, { color: color.text2 }]}>Back</Text>
          </Pressable>
        ) : null}
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: color.text }]}>{title}</Text>
        {back ? null : (
          <Pressable accessibilityRole="button" accessibilityLabel="Places" testID="open-places" onPress={() => router.push("/places")} style={styles.avatarHit}>
            <View style={[styles.avatar, { backgroundColor: color.hover }]}>
              <Text style={[styles.avatarText, { color: color.text2 }]}>{(boxName() || "v").slice(0, 1).toLowerCase()}</Text>
            </View>
          </Pressable>
        )}
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

/** The quiet empty state: one line, the label colour. */
export function Empty({ text }: { text: string }) {
  const { color } = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyText, { color: color.label }]}>{text}</Text>
    </View>
  );
}

const phone = tokens.type.phone;
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
  title: { flex: 1, fontSize: phone.title[0], lineHeight: phone.title[1], fontWeight: tokens.font.weight.strong },
  back: { height: tokens.control.touch, justifyContent: "center", paddingRight: tokens.space[2] },
  backText: { fontSize: phone.read[0], lineHeight: phone.read[1], fontWeight: tokens.font.weight.strong },
  avatarHit: { width: tokens.control.touch, height: tokens.control.touch, alignItems: "flex-end", justifyContent: "center" },
  avatar: { width: 32, height: 32, borderRadius: tokens.radius.full, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: phone.base[0], lineHeight: phone.base[1], fontWeight: tokens.font.weight.strong },
  body: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.layout.gutterPhone },
  emptyText: { fontSize: phone.read[0], lineHeight: phone.read[1] },
});
