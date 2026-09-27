import { Tabs } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { tabPressed } from "../../src/perf/tabs";
import { useNeedsCount } from "../../src/state/needs";
import { useTheme } from "../../src/theme/theme";
import { tokens } from "../../src/theme/tokens";
import { type } from "../../src/theme/type";
import { StatusMark } from "../../src/ui/StatusMark";

/** A tab's label, with the needs-you dot before it while something waits (status-mark spec: tabs). */
function TabLabel({ text, tint, attention }: { text: string; tint: string; attention?: boolean }) {
  return (
    <View style={styles.label}>
      {attention ? <StatusMark status="needsYou" /> : null}
      <Text style={[type.metaStrong, { color: tint }]}>{text}</Text>
    </View>
  );
}

// Now, Chats and Agents stay mounted once opened: bottom tabs never unmount a visited screen,
// and detachInactiveScreens={false} keeps them attached, so a switch is a paint, not a mount.
export default function TabsLayout() {
  const { color } = useTheme();
  const needs = useNeedsCount();
  return (
    <Tabs
      detachInactiveScreens={false}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: color.bg },
        tabBarStyle: { backgroundColor: color.bg, borderTopColor: color.rule },
        tabBarActiveTintColor: color.text,
        tabBarInactiveTintColor: color.label,
        tabBarIconStyle: { display: "none" },
      }}
      screenListeners={{ tabPress: tabPressed }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Now", tabBarButtonTestID: "tab-now", tabBarLabel: ({ color: tint }) => <TabLabel text="Now" tint={tint} attention={needs > 0} /> }}
      />
      <Tabs.Screen name="chats" options={{ title: "Chats", tabBarButtonTestID: "tab-chats", tabBarLabel: ({ color: tint }) => <TabLabel text="Chats" tint={tint} /> }} />
      <Tabs.Screen name="agents" options={{ title: "Agents", tabBarButtonTestID: "tab-agents", tabBarLabel: ({ color: tint }) => <TabLabel text="Agents" tint={tint} /> }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  label: { flexDirection: "row", alignItems: "center", gap: tokens.space[2] },
});
