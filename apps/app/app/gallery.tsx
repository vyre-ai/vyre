// The living gallery: every block and a few whole screens, drawn from generated fixtures (apps/app/ui/blocks/fixtures.generated.json) with no box behind them. The picture tests
// load /gallery?f=<id>&form=full|compact|glance and take a picture of #fixture; /gallery?f=all lists everything for a person to read.
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { BlockScreen, ChatCard, ThemeProvider, Text, useAppearance, useUiTheme } from "@vyre/ui";
import data from "../ui/blocks/fixtures.generated.json";
import { DesignChangesView } from "../screens/design/DesignChanges";

type Fx = { title: string; screens: Record<string, any> };
const FX = (data as { fixtures: Record<string, Fx> }).fixtures;

function Page({ children }: { children: React.ReactNode }) {
  const { color } = useUiTheme();
  // A plain View, not a ScrollView: the page scrolls, so a picture of #fixture is the whole of it however tall it is.
  return <View style={{ backgroundColor: color["surface-1"], padding: 16, gap: 24 }}>{children}</View>;
}

/** A screen handed in the query as base64url JSON (the Design MCP's render): drawn as given, already reduced for its surface. Anything that is not a v2 screen is ignored. */
function fromQuery(raw?: string): Record<string, any> | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/")));
    return s && s.v === 2 && s.layout && s.blocks && typeof s.blocks === "object" ? s : null;
  } catch { return null; }
}

/** Whole screens that are components, not block screens: drawn from sample data so a picture of them needs no box. */
function Sample({ name }: { name: string }) {
  const { phone } = useUiTheme();
  if (name === "design-changes") {
    const desk = (FX.desk?.screens.full ?? null) as any, list = (FX["block-list"]?.screens.full ?? null) as any;
    const items = [
      { id: 1, kind: "screen" as const, screenId: "desk", title: "Intake desk", why: "A single page for what is waiting.", by: "mcp:agent:engineer", status: "pending", before: {}, after: {}, uses: { reads: ["intake.queue"], runs: ["intake.close"] } },
      { id: 2, kind: "css" as const, screenId: "space", title: "Styling: space", why: "Softer cards, in the firm's colour.", by: "mcp:agent:engineer", status: "pending", before: null, after: '[data-block="kpis"] { border-radius: var(--r-card); }', uses: { reads: [], runs: [] }, appliesTo: "web" },
    ];
    return <DesignChangesView items={items} shots={{ 1: { before: list, after: desk } }} phone={phone} busy={null} error="" onAnswer={() => {}} onRetry={() => {}} />;
  }
  return null;
}

export default function Gallery() {
  const q = useLocalSearchParams<{ f?: string; form?: string; screen?: string; theme?: string }>();
  // ?theme=dark|paper sets the person's theme for this view (the Design MCP's render); without it the picture follows the system, as the picture tests expect.
  if ((q.theme === "dark" || q.theme === "paper") && useAppearance.getState().person.theme !== q.theme) useAppearance.getState().setPerson({ theme: q.theme });
  const form = q.form === "compact" || q.form === "glance" ? q.form : "full";
  const given = fromQuery(q.screen);
  if (given) FX.given = { title: String(given.title ?? "Screen"), screens: { [form]: given } };
  const ids = given ? ["given"] : q.f && q.f !== "all" && FX[q.f] ? [q.f] : Object.keys(FX);
  const one = ids.length === 1;
  return (
    <ThemeProvider>
      <Page>
        {ids.map((id) => (
          <View key={id} nativeID={one ? "fixture" : `fixture-${id}`} style={{ gap: 8 }}>
            {!one ? <Text size="caption" tone="label">{`${id} (${form})`}</Text> : null}
            {FX[id].screens[form]?.component ? <Sample name={String(FX[id].screens[form].component)} /> : form === "glance" ? <ChatCard screen={FX[id].screens[form]} onOpen={() => {}} /> : <BlockScreen screen={FX[id].screens[form]} />}
          </View>
        ))}
      </Page>
    </ThemeProvider>
  );
}
