import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SAY } from "../src/api/wink-code";
import { Screen } from "../src/ui/Screen";
import { useTheme } from "../src/theme/theme";
import { tokens } from "../src/theme/tokens";
import { type } from "../src/theme/type";
import { Button } from "../src/ui/Button";

/**
 * `vyre://pair?offer=...` on the phone, `/app/pair?offer=...` on the web: the old bearer pairing link.
 * It no longer pairs anything. The screen says so and names the next step.
 */
export default function Pair() {
  const router = useRouter();
  const { color } = useTheme();
  return (
    <Screen title="Pair">
      <View style={styles.body}>
        <Text accessibilityRole="alert" style={[type.read, { color: color.text }]}>
          {SAY.old_offer}
        </Text>
        <View style={styles.action}>
          <Button kind="primary" label="Open Devices" onPress={() => router.replace("/u/settings/devices" as never)} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: tokens.layout.gutterPhone, gap: tokens.space[4] },
  action: { alignSelf: "flex-start" },
});
