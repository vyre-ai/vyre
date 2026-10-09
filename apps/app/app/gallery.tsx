// The living gallery: every block and a few whole screens, drawn from generated fixtures (apps/app/ui/blocks/fixtures.generated.json) with no box behind them. The picture tests
// load /gallery?f=<id>&form=full|compact|glance and take a picture of #fixture; /gallery?f=all lists everything for a person to read.
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { BlockScreen, ChatCard, ThemeProvider, Text, useAppearance, useUiTheme } from "@vyre/ui";
import data from "../ui/blocks/fixtures.generated.json";
import "../screens/records/register";
import fx from "../screens/vault/real-box.fixture.json";
import { setBoxOverride } from "../src/real/box";
import RealVault from "../screens/vault/RealVault";
import { RunHereView } from "../screens/runner/RunHere";
import { PlacementChip, MovedLines } from "../src/chat/placement";
import { EmergencyView } from "../screens/vault/RealVaultMore";
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
  if (name.startsWith("vault-real")) {
    // The Vault as it reads a real box: answers recorded from a real vyred (scripts/capture-vault-fixtures.mjs). `vault-real-health` opens on the Health page.
    const answers = fx as Record<string, { data?: unknown; error?: { code: string; message: string } }>;
    setBoxOverride(async (tool) => { const a = answers[tool]; if (!a) return {}; if (a.error) throw Object.assign(new Error(a.error.message), { code: a.error.code }); return a.data; });
    return <RealVault />;
  }
  if (name === "vault-emergency") {
    const day = 86_400_000, t0 = Date.parse("2026-10-04T00:00:00Z");
    const list = [
      { person: "Dana Smith", waitDays: 7, state: "standby" as const, requested: null, opens: null, denied: null, released: null, items: "every item except ssh keys and passkeys" },
      { person: "Theo Park", waitDays: 3, state: "waiting" as const, requested: t0, opens: t0 + 3 * day, denied: null, released: null, items: "Gmail, Bank" },
      { person: "Kit Lee", waitDays: 1, state: "denied" as const, requested: null, opens: null, denied: t0 - 3 * day, released: null, items: "x" },
    ];
    return <View style={{ padding: 0 }}><EmergencyView list={list} problem="" onDeny={() => {}} onRemove={() => {}} onRefresh={() => {}} onAdd={() => {}} /></View>;
  }
  if (name === "runner-settings") {
    const s = { enabled: true, pluggedInOnly: true, cpuPercent: 50, memoryMb: 4096 };
    const here = [{ thread: "t1", title: "Intake call notes", state: "running" as const, cpuPercent: 14, memoryMb: 900 }, { thread: "t2", title: "Smith engagement letter", state: "waiting" as const, cpuPercent: 0, memoryMb: 512 }];
    return <RunHereView s={s} here={here} cpu="50" mem="4096" problem="" setCpu={() => {}} setMem={() => {}} onSave={() => {}} onSaveLimits={() => {}} onPause={() => {}} onResume={() => {}} />;
  }
  if (name === "runner-chip") {
    return (
      <View style={{ gap: 12, alignItems: "flex-start" }}>
        <PlacementChip placement={{ where: "mac" }} onMove={() => {}} />
        <PlacementChip placement={{ where: "server", reason: "lid-closed" }} onMove={() => {}} />
        <MovedLines lines={[{ at: 1, text: "Moved to the server: lid closed." }, { at: 2, text: "Moved to this Mac: you moved it." }]} />
      </View>
    );
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
