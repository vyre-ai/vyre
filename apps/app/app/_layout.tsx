import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { connect } from "../src/api/box";
import { PerfBadge } from "../src/perf/PerfBadge";
import { usePerfOverlay } from "../src/perf/usePerfOverlay";
import { startLive } from "../src/state/live";
import { ThemeProvider, useTheme } from "../src/theme/theme";
import { UndoToast } from "../src/ui/UndoToast";

function Shell() {
  const { scheme, color } = useTheme();
  usePerfOverlay();
  // Follow the box once for the whole app, and paint Needs you and Chats from this device's cache
  // before the box answers. On the web the box is this page's origin by default; the phone
  // connects once configure({ base }) has its address.
  useEffect(() => {
    connect().catch(() => {});
    startLive();
  }, []);
  return (
    <View style={[styles.fill, { backgroundColor: color.bg }]}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />
      <UndoToast />
      <PerfBadge />
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaProvider>
        <ThemeProvider>
          <Shell />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
