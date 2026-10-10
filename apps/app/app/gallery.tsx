// The living gallery: every block and a few whole screens, drawn from generated fixtures (apps/app/ui/blocks/fixtures.generated.json) with no box behind them. The picture tests
// load /gallery?f=<id>&form=full|compact|glance and take a picture of #fixture; /gallery?f=all lists everything for a person to read.
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { BlockScreen, Card, ChatCard, FlowCanvas, Markdown, ThemeProvider, Text, useAppearance, useUiTheme } from "@vyre/ui";
import type { CanvasEdge, NodeState } from "../ui/canvas/FlowCanvas";
import data from "../ui/blocks/fixtures.generated.json";
import "../screens/records/register";
import fx from "../screens/vault/real-box.fixture.json";
import { setBoxOverride } from "../src/real/box";
import RealVault from "../screens/vault/RealVault";
import { RunHereView } from "../screens/runner/RunHere";
import { PlacementChip, MovedLines } from "../src/chat/placement";
import { StatusLine } from "../src/chat/StatusLine";
import { Thumb } from "../src/chat/Thumb";
import { ExplainCard } from "../screens/flows/ExplainCard";
import { TimelineEntries } from "../screens/projects/TimelineList";
import { ChatsList } from "../screens/chats/ChatsList";
import { sampleChats } from "../screens/chats/chats-model.js";
import { PreviewCard } from "../src/chat/PreviewCard";
import { SitesList } from "../screens/sites/SitesList";
import { EmergencyView } from "../screens/vault/RealVaultMore";
import { DesignChangesView } from "../screens/design/DesignChanges";

const MD_SAMPLE = [
  "## The short answer", "",
  "The check compares the day against a **fixed month table**, so it rejects 29 February in a *leap year*. Use the real month length instead:", "",
  "```ts", "function validDay(year: number, month: number, day: number): boolean {", "  const days = new Date(year, month + 1, 0).getDate(); // 29 in Feb 2028", "  return Number.isInteger(day) && day >= 1 && day <= days;", "}", "```", "",
  "Three things change:", "", "1. the month table is deleted", "2. the leap-year rule comes from `Date`", "3. the test adds two cases:", "   - 29 February 2028 passes", "   - 29 February 2027 fails", "",
  "> A date check should never carry its own calendar.", "",
  "| File | Change |", "|:--|--:|", "| `src/intake/date.ts` | 6 lines |", "| `src/intake/date.test.ts` | 12 lines |", "",
  "The full history is in the [intake notes](https://example.com/intake). A tag such as <script>alert(1)</script> is only words, and [this](javascript:alert(1)) is not a link.",
].join("\n");

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
    // The app is a native window: stand in for the Mac shell so the screen is the one a person has (Add, Share and Reveal are there, not "on your phone").
    (window as unknown as { __vyreShell?: unknown }).__vyreShell = { kind: "mac", identity: { has: async () => false, public: async () => "", sign: async () => "" }, presence: async () => "x", notify: async () => {}, open: async () => {}, onCommand: () => () => {} };
    setBoxOverride(async (tool) => { const a = answers[tool]; if (!a) return {}; if (a.error) throw Object.assign(new Error(a.error.message), { code: a.error.code }); return a.data; });
    return <RealVault />;
  }
  if (name === "flow-parallel") {
    // A flow with a parallel (two lanes) and the step that follows it, in the shape kernel/flows/canvas.js graph() hands over.
    const n = (id: string, kind: string, label: string, lane: number, y: number, state?: NodeState) => ({ id, kind, label, lane, y, ...(state ? { state } : {}) });
    const nodes = [n("t", "trigger", "When someone runs it", 0, 0, "done"), n("p", "parallel", "Do 2 things at the same time, then carry on", 0, 1, "done"), n("a1", "branch", "review", 1, 2, "done"), n("a2", "assign", "Give a task to a person", 1, 3, "waiting"),
      n("b1", "branch", "draft", 2, 4, "done"), n("b2", "subflow", "Run the Flow inner_note", 2, 5, "running"), n("j", "create", "Create a filing note", 0, 6)];
    const edges: CanvasEdge[] = [{ from: "t", to: "p", kind: "next" }, { from: "p", to: "a1", kind: "lane" }, { from: "a1", to: "a2", kind: "next" }, { from: "p", to: "b1", kind: "lane" }, { from: "b1", to: "b2", kind: "next" }, { from: "p", to: "j", kind: "next" }];
    return <Card flush><FlowCanvas nodes={nodes} edges={edges} /></Card>;
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
    return <RunHereView s={s} here={here} shared={["Juniper Studio", "Northwind Bakery"]} cpu="50" mem="4096" problem="" setCpu={() => {}} setMem={() => {}} onSave={() => {}} onSaveLimits={() => {}} onPause={() => {}} onResume={() => {}} />;
  }
  if (name === "runner-settings-off") {
    return <RunHereView s={{ enabled: false, pluggedInOnly: true, cpuPercent: 50, memoryMb: 4096 }} here={[]} cpu="50" mem="4096" problem="Not turned on: it needs your approval. Approve on this computer, then try again." setCpu={() => {}} setMem={() => {}} onSave={() => {}} onSaveLimits={() => {}} onPause={() => {}} onResume={() => {}} />;
  }
  if (name === "sites-list") {
    const dep = (id: string, version: number, stage: string, host?: string) => ({ id, name: "", version, stage, url: null, domains: host ? [{ host, status: "verified" }] : [] });
    const site = (name: string, versions: ReturnType<typeof dep>[], tone: "ok" | "accent" | "plain", label: string) => { const live = versions.find((v) => v.stage === "Production") ?? null; return { name, versions, live, current: versions[0], status: { label, tone } }; };
    const rows = [
      site("client-intake", [dep("a", 3, "Production", "intake.juniper.example")], "ok", "Live"),
      site("fee-calculator", [dep("b", 2, "Approved"), dep("c", 1, "Production")], "accent", "Waiting on you"),
      site("referral-form", [dep("d", 1, "Preview")], "plain", "In preview"),
      site("menu", [dep("e", 1, "Draft")], "plain", "Draft"),
    ];
    return <SitesList rows={rows} onOpen={() => {}} />;
  }
  if (name === "chats-list") {
    const now = 1_700_000_000_000;
    const rows = [
      { id: "a", pinned: "assistant" as const, title: "Assistant", project: "", people: ["alex"], agents: ["kit"], models: [], providers: ["claude"], status: "idle", last: now - 2 * 60_000, line: "", asks: 0, unread: 0, open: true },
      ...sampleChats(now).map((c, i) => (i === 1 ? { ...c, asks: 1 } : i === 2 ? { ...c, status: "failed" } : c)),
      { id: "x", pinned: "" as const, title: "Intake hand-off (not yours)", project: "General", people: ["sam"], agents: [], models: [], providers: [], status: "idle", last: now - 86_400_000, line: "", asks: 0, unread: 0, open: false },
    ];
    return <ChatsList rows={rows} now={now} places={{ places: [{ chat: "demo", computer: "Dana's MacBook", online: true }] }} onOpen={() => {}} />;
  }
  if (name === "preview-card") {
    return <View style={{ gap: 12 }}><PreviewCard block={{ block: "preview", id: "0a1b2c3d", title: "Intake form", state: "live", source: "files", mode: "supervised", access: "me", thumb: 0 }} /><PreviewCard block={{ block: "preview", id: "1a1b2c3d", title: "Dev server", state: "live", source: "port", mode: "session", access: "me", thumb: 0 }} /></View>;
  }
  if (name === "markdown") return <Markdown text={MD_SAMPLE} onCopy={() => {}} />;
  if (name === "explain-card") return <ExplainCard text="It ran because the stage moved to Engagement. It made Welcome note and handed Send the welcome email to an assistant. It is waiting for a person (step Approve the email)." />;
  if (name === "record-timeline") {
    const now = 1_700_000_000_000, h = 3_600_000;
    return <TimelineEntries rows={[
      { type: "flow-run", kind: "flow", id: "r1", urn: "u", title: "Welcome the client", line: "Welcome the client ran and finished", at: now - 2 * h },
      { type: "stage", kind: "stage", id: "s1", urn: "u", title: "Engagement", line: "Moved to Engagement", at: now - 3 * h },
      { type: "email", kind: "email", id: "e1", urn: "u", title: "Re: lease", line: "Alex sent the welcome email", at: now - 26 * h },
      { type: "task", kind: "task", id: "t1", urn: "u", title: "Collect ID", line: "Collect ID was done by Sam", at: now - 27 * h },
      { type: "call", kind: "call", id: "c1", urn: "u", title: "Call", line: "Call with the client, 18 minutes", at: now - 50 * h },
    ]} />;
  }
  if (name === "attach-thumbs") {
    const art = (a: string, b: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="120" height="120" fill="url(#g)"/><circle cx="84" cy="36" r="14" fill="white" opacity=".8"/><path d="M0 120 L46 62 L78 96 L96 78 L120 108 V120Z" fill="white" opacity=".55"/></svg>`)}`;
    return (
      <View style={{ gap: 16 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Thumb uri={art("#7c6cf0", "#e58fb0")} name="lease-photo.png" onRemove={() => {}} />
          <Thumb uri={art("#3fb8a0", "#2a6fa8")} name="signature.png" state="uploading" onRemove={() => {}} />
          <Thumb uri={art("#f0a35c", "#c24a4a")} name="scan.jpg" state="failed" onRemove={() => {}} />
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}><Thumb uri={art("#7c6cf0", "#e58fb0")} name="lease-photo.png" size={120} /><Thumb uri={art("#3fb8a0", "#2a6fa8")} name="signature.png" size={120} /></View>
      </View>
    );
  }
  if (name === "runner-chip") {
    return (
      <View style={{ gap: 12, alignItems: "flex-start" }}>
        <PlacementChip placement={{ where: "mac" }} onMove={() => {}} />
        <PlacementChip placement={{ where: "server", reason: "lid-closed" }} onMove={() => {}} />
        <View style={{ alignSelf: "stretch" }}><StartingSample /></View>
        <MovedLines lines={[{ at: 1, text: "Moved to the server: lid closed." }, { at: 2, text: "Moved to this Mac: you moved it." }, { at: 3, text: "Dana's MacBook did not answer. Running on the server instead." }, { at: 4, text: "This chat borrowed Dana's MacBook. It can reach the AI provider and nothing else." }]} />
      </View>
    );
  }
  return null;
}

/** The chat's status line while its process starts on a computer: the words, then Stop, and no chip yet (the chip comes when it is up). */
function StartingSample() {
  const { phone } = useUiTheme();
  return <StatusLine starting="Starting on Dana's MacBook..." presence="" state="working" busy canStop stopping={false} offline={false} phone={phone} onStop={() => {}} place={<PlacementChip placement={{ where: "mac", computer: "Dana's MacBook" }} onMove={() => {}} />} />;
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
