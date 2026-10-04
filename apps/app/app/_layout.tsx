import "../global.css";
import "../src/identity/webcrypto";
import "../src/identity/restore-wire";
import { useEffect } from "react";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { connect } from "../src/api/box";
import { PerfBadge } from "../src/perf/PerfBadge";
import { usePerfOverlay } from "../src/perf/usePerfOverlay";
import { startPwa } from "../src/pwa/pwa";
import { SetupGate } from "../src/shell/SetupGate";
import { listenCommands } from "../src/shell/shell";
import { startGlass } from "../src/state/glass";
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
    startGlass();
  }, []);
  // The installed web app: its service worker, a tapped notification's route, push.seen.
  useEffect(() => startPwa((path) => router.push(path as never)), []);
  // In the Mac app's window the menu bar's places and Back and Forward come in as commands (src/shell).
  useEffect(() => listenCommands((r) => router.push(r as never), () => router.back(), () => window.history.forward()), []);
  return (
    <View style={[styles.fill, { backgroundColor: color.bg }]}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <SetupGate>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />
      </SetupGate>
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
