import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { boxName, signOut } from "../src/api/box";
import { deviceName } from "../src/api/relay";
import { useTheme } from "../src/theme/theme";
import { tokens } from "../src/theme/tokens";
import { Button } from "../src/ui/Button";
import { Screen } from "../src/ui/Screen";

/**
 * Settings: this device and the box it follows. On the phone Devices is also a pushed Settings
 * screen (the Devices board, "Settings, Devices"), so it sits here as well as in Places.
 */
export default function Settings() {
  const router = useRouter();
  const { color } = useTheme();
  return (
    <Screen title="Settings" back>
      <View>
        <View style={[styles.row, { borderBottomColor: color.rule }]}>
          <Text style={[styles.title, { color: color.text }]}>{deviceName()}</Text>
          <Text style={[styles.detail, { color: color.label }]}>{boxName() ? `Follows ${boxName()}` : "Not paired with a box yet"}</Text>
        </View>
        <Pressable accessibilityRole="button" testID="settings-devices" onPress={() => router.push("/devices")} style={[styles.row, { borderBottomColor: color.rule }]}>
          <Text style={[styles.title, { color: color.text }]}>Devices</Text>
          <Text style={[styles.detail, { color: color.label }]}>How each device reaches the box, and its trust</Text>
        </Pressable>
        {Platform.OS === "android" ? (
          <Pressable accessibilityRole="button" testID="settings-autofill" onPress={() => router.push("/settings/autofill")} style={[styles.row, { borderBottomColor: color.rule }]}>
            <Text style={[styles.title, { color: color.text }]}>Autofill</Text>
            <Text style={[styles.detail, { color: color.label }]}>Fill logins in apps and browsers from your vault</Text>
          </Pressable>
        ) : null}
        <View style={styles.pad}>
          <Button kind="ghost" label="Sign out of the box" onPress={() => void signOut()} />
        </View>
      </View>
    </Screen>
  );
}

const phone = tokens.type.phone;
const styles = StyleSheet.create({
  row: { gap: tokens.space[1], paddingHorizontal: tokens.layout.gutterPhone, paddingVertical: tokens.space[4], borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: phone.read[0], lineHeight: phone.read[1], fontWeight: tokens.font.weight.strong },
  detail: { fontSize: phone.meta[0], lineHeight: phone.meta[1] },
  pad: { padding: tokens.layout.gutterPhone, alignItems: "flex-start" },
});
