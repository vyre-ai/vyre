// The living gallery: every block and a few whole screens, drawn from generated fixtures (apps/app/ui/blocks/fixtures.generated.json) with no box behind them. The picture tests
// load /gallery?f=<id>&form=full|compact|glance and take a picture of #fixture; /gallery?f=all lists everything for a person to read.
import { ScrollView, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { BlockScreen, ChatCard, ThemeProvider, Text, useUiTheme } from "@vyre/ui";
import data from "../ui/blocks/fixtures.generated.json";

type Fx = { title: string; screens: Record<string, any> };
const FX = (data as { fixtures: Record<string, Fx> }).fixtures;

function Page({ children }: { children: React.ReactNode }) {
  const { color } = useUiTheme();
  return <ScrollView style={{ flex: 1, backgroundColor: color["surface-1"] }} contentContainerStyle={{ padding: 16, gap: 24 }}>{children}</ScrollView>;
}

export default function Gallery() {
  const q = useLocalSearchParams<{ f?: string; form?: string }>();
  const form = q.form === "compact" || q.form === "glance" ? q.form : "full";
  const ids = q.f && q.f !== "all" && FX[q.f] ? [q.f] : Object.keys(FX);
  const one = ids.length === 1;
  return (
    <ThemeProvider>
      <Page>
        {ids.map((id) => (
          <View key={id} nativeID={one ? "fixture" : `fixture-${id}`} style={{ gap: 8 }}>
            {!one ? <Text size="caption" tone="label">{`${id} (${form})`}</Text> : null}
            {form === "glance" ? <ChatCard screen={FX[id].screens[form]} onOpen={() => {}} /> : <BlockScreen screen={FX[id].screens[form]} />}
          </View>
        ))}
      </Page>
    </ThemeProvider>
  );
}
