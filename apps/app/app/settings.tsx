import { useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { boxName, signOut } from "../src/api/box";
import { deviceName } from "../src/api/relay";
import { noticeRow, tapNotices } from "../src/native/keepalive";
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
  const [notices, setNotices] = useState<{ value: string; line: string } | null>(null);
  useEffect(() => { if (Platform.OS === "android") void noticeRow().then(setNotices); }, []);
  return (
    <Screen title="Settings" back>
      <View>
        <ListRow title={deviceName()} meta={boxName() ? `Follows ${boxName()}` : "Not paired with a home yet"} />
        {/* The 44 single-line rows (list-row spec): the title, a chevron where a screen opens. */}
        <ListRow testID="settings-devices" title="Devices" push onPress={() => router.push("/devices")} />
        {Platform.OS === "android" && notices && notices.value ? <ListRow testID="settings-notices" title="Notices" meta={notices.line} trailing={notices.value} onPress={() => void tapNotices().then(setNotices)} /> : null}
        {Platform.OS === "android" ? <ListRow testID="settings-autofill" title="Autofill" push onPress={() => router.push("/settings/autofill")} /> : null}
        {Platform.OS === "web" ? (
          // The installed web app opens with no query, so ?perf=1 cannot reach it from a link: this
          // reloads the page with the flag, which the page then remembers (src/perf/flag.js).
          <ListRow
            testID="settings-perf"
            title="Performance meter"
            trailing={perfOn ? "On" : "Off"}
            onPress={() => {
              globalThis.location.search = perfOn ? "?perf=0" : "?perf=1";
            }}
          />
        ) : null}
        <View style={styles.pad}>
          <Button kind="ghost" label="Sign out of your home" onPress={() => void signOut()} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  pad: { padding: tokens.layout.gutterPhone, alignItems: "flex-start" },
});
