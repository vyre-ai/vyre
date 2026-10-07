// A route that drives the Terminal against a fake term socket, for screenshots and for looking at it without a box:
//   node scripts/fake-term.mjs 7391   then   /terminal-demo?ws=ws://127.0.0.1:7391
// 390 wide shows the phone screen (full screen, accessory row); wider shows the desktop pane beside a stand-in chat.
import { useLocalSearchParams } from "expo-router";
import { useWindowDimensions, View } from "react-native";
import { PHONE_MAX, Text, ThemeProvider } from "@vyre/ui";
import { TerminalPane } from "../src/terminal/TerminalPane";
import { TerminalScreen } from "../src/terminal/TerminalScreen";

export default function TerminalDemoRoute() {
  return <ThemeProvider><TerminalDemo /></ThemeProvider>;
}

function TerminalDemo() {
  const { ws = "ws://127.0.0.1:7391" } = useLocalSearchParams<{ ws?: string }>();
  const { width } = useWindowDimensions();
  const getTicket = async (from: number) => ({ url: `${ws}/pty?from=${from}` });
  const common = { getTicket, title: "Fix the sitemap", subtitle: "~/juniper-site" };
  if (width < PHONE_MAX) return <TerminalScreen {...common} onBack={() => {}} />;
  return (
    <View className="flex-1 flex-row bg-bg">
      <View className="flex-1 p-s6 gap-s3">
        <Text size="title" strong>Fix the sitemap</Text>
        <Text tone="muted">The chat sits here; the terminal is a pane beside it. Drag its left edge to resize.</Text>
      </View>
      <TerminalPane {...common} width={560} onClose={() => {}} />
    </View>
  );
}
