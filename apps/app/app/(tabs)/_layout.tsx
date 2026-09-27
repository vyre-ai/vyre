import { Tabs } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { useNeedsCount } from "../../src/state/needs";
import { useTheme } from "../../src/theme/theme";
import { tokens } from "../../src/theme/tokens";

function TabLabel({ text, tint, attention }: { text: string; tint: string; attention?: boolean }) {
  const { color } = useTheme();
  return (
    <View style={styles.label}>
      <Text style={[styles.text, { color: tint }]}>{text}</Text>
      {attention ? <View accessibilityLabel="needs you" style={[styles.dot, { backgroundColor: color.beacon }]} /> : null}
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
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Now", tabBarLabel: ({ color: tint }) => <TabLabel text="Now" tint={tint} attention={needs > 0} /> }}
      />
      <Tabs.Screen name="chats" options={{ title: "Chats", tabBarLabel: ({ color: tint }) => <TabLabel text="Chats" tint={tint} /> }} />
      <Tabs.Screen name="agents" options={{ title: "Agents", tabBarLabel: ({ color: tint }) => <TabLabel text="Agents" tint={tint} /> }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  label: { flexDirection: "row", alignItems: "center", gap: tokens.space[2] },
  text: { fontSize: tokens.type.phone.meta[0], lineHeight: tokens.type.phone.meta[1], fontWeight: tokens.font.weight.strong },
  dot: { width: 6, height: 6, borderRadius: tokens.radius.full },
});
