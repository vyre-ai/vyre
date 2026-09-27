import { Platform, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { boxName, signOut } from "../src/api/box";
import { deviceName } from "../src/api/relay";
import { perfOn } from "../src/perf";
import { tokens } from "../src/theme/tokens";
import { Button } from "../src/ui/Button";
import { ListRow } from "../src/ui/Row";
import { Screen } from "../src/ui/Screen";

/**
 * Settings: this device and the box it follows. On the phone Devices is also a pushed Settings
 * screen (the Devices board, "Settings, Devices"), so it sits here as well as in Places.
 */
export default function Settings() {
  const router = useRouter();
  return (
    <Screen title="Settings" back>
      <View>
        <ListRow title={deviceName()} meta={boxName() ? `Follows ${boxName()}` : "Not paired with a box yet"} />
        <ListRow testID="settings-devices" title="Devices" meta="How each device reaches the box, and its trust" onPress={() => router.push("/devices")} />
        {Platform.OS === "android" ? (
          <ListRow testID="settings-autofill" title="Autofill" meta="Fill logins in apps and browsers from your vault" onPress={() => router.push("/settings/autofill")} />
        ) : null}
        {Platform.OS === "web" ? (
          // The installed web app opens with no query, so ?perf=1 cannot reach it from a link: this
          // reloads the page with the flag, which the page then remembers (src/perf/flag.js).
          <ListRow
            testID="settings-perf"
            title="Performance meter"
            meta={perfOn ? "On: tap the badge to copy a report" : "Off"}
            onPress={() => {
              globalThis.location.search = perfOn ? "?perf=0" : "?perf=1";
            }}
          />
        ) : null}
        <View style={styles.pad}>
          <Button kind="ghost" label="Sign out of the box" onPress={() => void signOut()} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  pad: { padding: tokens.layout.gutterPhone, alignItems: "flex-start" },
});
