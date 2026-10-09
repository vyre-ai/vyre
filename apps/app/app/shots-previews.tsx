// Sample world only: the preview card in each of its states, for the screenshot pass. Nothing is opened. ?state=live|supervised|crashed|stopped shows one; with none, all four.
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { ThemeProvider, Text } from "@vyre/ui";
import { PreviewCard } from "../src/chat/PreviewCard";

const card = (id: string, title: string, state: string, mode: string, access: string) => ({ block: "preview" as const, id, title, state: state as never, source: "port", thumb: 0, mode: mode as never, access: access as never });
const ALL = {
  live: card("0a1b2c3d", "Intake form", "live", "session", "me"),
  supervised: card("1b2c3d4e", "Northwind portal", "live", "supervised", "project"),
  crashed: card("2c3d4e5f", "Invoice dashboard", "crashed", "supervised", "team"),
  stopped: card("3d4e5f60", "Docs site", "stopped", "session", "me"),
};

export default function ShotsPreviews() {
  const q = useLocalSearchParams<{ state?: string }>();
  const one = q.state && (ALL as Record<string, ReturnType<typeof card>>)[q.state];
  return (
    <ThemeProvider>
      <View style={{ padding: 20, gap: 14, maxWidth: 620 }}>
        {one ? <PreviewCard block={one} /> : Object.values(ALL).map((b) => <PreviewCard key={b.id} block={b} />)}
        <Text tone="label" size="caption">Sample world</Text>
      </View>
    </ThemeProvider>
  );
}
