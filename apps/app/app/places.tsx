import { Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter, type Href } from "expo-router";
import { useTrust } from "../src/state/devices";
import { useTheme } from "../src/theme/theme";
import { tokens } from "../src/theme/tokens";
import { Screen } from "../src/ui/Screen";

/**
 * The Places sheet, opened from the avatar on Now, Chats and Agents (README layout, under 720):
 * the places you go to. Projects, Planner and Memory join it as they are built.
 */
const PLACES: { title: string; detail: string; href: Href; testID: string }[] = [
  { title: "Vault", detail: "Logins, codes and keys", href: "/vault", testID: "place-vault" },
  { title: "Devices", detail: "How each device reaches the box, and its trust", href: "/devices", testID: "place-devices" },
  { title: "Settings", detail: "This device and the box", href: "/settings", testID: "place-settings" },
];

export default function Places() {
  const router = useRouter();
  const { color } = useTheme();
  const trust = useTrust();
  return (
    <Screen title="Places" back>
      <Stack.Screen options={{ presentation: "modal" }} />
      <View>
        {PLACES.map((p) => (
          <Pressable
            key={p.testID}
            accessibilityRole="button"
            testID={p.testID}
            onPress={() => router.push(p.href)}
            style={[styles.row, { borderBottomColor: color.rule }]}
          >
            <Text style={[styles.title, { color: color.text }]}>{p.title}</Text>
            <Text numberOfLines={1} style={[styles.detail, { color: color.label }]}>
              {p.title === "Vault" && trust === "untrusted" ? "Names only on this browser" : p.detail}
            </Text>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const phone = tokens.type.phone;
const styles = StyleSheet.create({
  row: {
    minHeight: tokens.control.touchLg,
    justifyContent: "center",
    gap: tokens.space[1],
    paddingHorizontal: tokens.layout.gutterPhone,
    paddingVertical: tokens.space[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: phone.read[0], lineHeight: phone.read[1], fontWeight: tokens.font.weight.strong },
  detail: { fontSize: phone.meta[0], lineHeight: phone.meta[1] },
});
