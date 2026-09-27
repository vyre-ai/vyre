import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { connect } from "../src/api/box";
import { usePerfOverlay } from "../src/perf/usePerfOverlay";
import { ThemeProvider, useTheme } from "../src/theme/theme";

function Shell() {
  const { scheme, color } = useTheme();
  usePerfOverlay();
  // Follow the box once for the whole app. On the web the box is this page's origin by default;
  // the phone connects once configure({ base }) has its address.
  useEffect(() => {
    connect().catch(() => {});
  }, []);
  return (
    <View style={[styles.fill, { backgroundColor: color.bg }]}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />
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
