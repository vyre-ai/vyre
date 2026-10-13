// The living gallery: every block and a few whole screens, drawn from generated fixtures (apps/app/ui/blocks/fixtures.generated.json) with no box behind them. The picture tests
// load /gallery?f=<id>&form=full|compact|glance and take a picture of #fixture; /gallery?f=all lists everything for a person to read.
import { useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { ShellStates, ShellSample, SpaceTileSheet, BlockScreen, Card, ChatCard, ChoiceList, CodeDisplay, CodeField, FlowCanvas, FlowStep, Markdown, MatchWords, PasswordField, ProviderRow, Stack, ThemeProvider, Text, useAppearance, useUiTheme } from "@vyre/ui";
import type { CanvasEdge, NodeState } from "../ui/canvas/FlowCanvas";
import data from "../ui/blocks/fixtures.generated.json";
import "../screens/records/register";
import fx from "../screens/vault/real-box.fixture.json";
import { setBoxOverride } from "../src/real/box";
import { RealSite, RealSites } from "../screens/sites/RealSites";
import RealVault from "../screens/vault/RealVault";
import { RunHereView } from "../screens/runner/RunHere";
import { PlacementChip, MovedLines } from "../src/chat/placement";
import { StatusLine } from "../src/chat/StatusLine";
import { AwayView } from "../screens/now/AwayCard";
import { ComputersView } from "../screens/spaces/ComputersSection";
import { memberLine } from "../screens/spaces/computers-model.js";
import { AccessView } from "../screens/assistants/AssistantAccess";
import { SignInView } from "../screens/now/SignInAgain";
import { ForkRows } from "../screens/chat-tools/ChatToolsSheet";
import { NoticeAnswered } from "../screens/shell/PhoneApprovals";
import { FlowDraftNote } from "../src/chat/FlowDraftNote";
import { Thumb } from "../src/chat/Thumb";
import { ExplainCard } from "../screens/flows/ExplainCard";
import { TimelineEntries } from "../screens/projects/TimelineList";
import { ChatsList } from "../screens/chats/ChatsList";
import { sampleChats } from "../screens/chats/chats-model.js";
import { PreviewCard } from "../src/chat/PreviewCard";
import { SitesList } from "../screens/sites/SitesList";
import { EmergencyView } from "../screens/vault/RealVaultMore";
import { DesignChangesView } from "../screens/design/DesignChanges";
import { FieldPaneDemo, ModelMapDemo, StarterDemo, TypeSetupDemo } from "../screens/records-setup/SetupDemos";
import { DRAFTS } from "../screens/records-setup/data";
import { DocumentsBar } from "../screens/records/DocumentsBar";
import { GroupedTasksDemo, ImportDemo, RecordFormDemo, RecordPageDemo } from "../screens/records-setup/RecordDemos";
import { ChatComposer } from "../src/chat/ChatComposer";
import { ChatPanel, type PanelPage } from "../src/chat/ChatPanel";

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
  if (name === "documents-bar") {
    // The Documents tools answered from recorded shapes, so the bar is drawn with no box behind it.
    setBoxOverride(async (tool) => {
      if (tool === "documents.template.list") return { templates: [{ name: "Engagement letter" }, { name: "Trust summary" }] };
      if (tool === "documents.template.get") return { name: "Engagement letter", version: 1, placeholders: ["contact.name", "contact.email", "firm.address", "date"], loops: [] };
      if (tool === "documents.signing.waiting") return { requests: [{ submission: 41, signer: "Jane Doe", email: "jane.doe@example.com", template: "Engagement letter", at: Date.now() - 5 * 3600_000 }] };
      return {};
    });
    return <DocumentsBar def={{ name: "contact", label: "Contact" }} rec={{ id: "1", urn: "vyre://s/contact/1" }} related={[{ urn: "vyre://s/project/9", type: "project" }]} email="jane.doe@example.com" canSend />;
  }
  if (name === "grouped-list") return <GroupedTasksDemo />;
  if (name === "record-form") return <RecordFormDemo />;
  if (name === "record-form-errors") return <RecordFormDemo tried values={{ title: "", kind: "Real estate" }} />;
  if (name === "record-page") return <RecordPageDemo />;
  if (name === "import-1") return <ImportDemo start={0} />;
  if (name === "import-2") return <ImportDemo start={1} />;
  if (name === "import-3") return <ImportDemo start={2} />;
  if (name === "import-4") return <ImportDemo start={3} />;
  if (name === "setup-model") return <ModelMapDemo />;
  if (name === "setup-starter") return <StarterDemo />;
  if (name === "setup-type") return <TypeSetupDemo />;
  if (name === "setup-type-editing") return <TypeSetupDemo open="kind" />;
  if (name === "setup-field-new") return <FieldPaneDemo draft={DRAFTS.blank} />;
  if (name === "setup-field-choice") return <FieldPaneDemo draft={DRAFTS.kind} />;
  if (name === "setup-field-link") return <FieldPaneDemo draft={DRAFTS.client} />;
  if (name === "setup-field-access") return <FieldPaneDemo draft={DRAFTS.value} rules={{ visible: null, required: { field: "kind", op: "is_not", value: "Other" } }} />;
  if (name === "setup-field-seal") return <FieldPaneDemo draft={DRAFTS.sealed} />;
  if (name === "setup-field-errors") return <FieldPaneDemo draft={DRAFTS.broken} tried />;
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
  if (name === "shell") return <ShellStates />;
  if (name.startsWith("shell-")) return <ShellSample state={name.slice(6) as "main"} />;
  if (name === "space-tiles") return <SpaceTileSheet />;
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
    const P = { a: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAACFUlEQVR42sXUa08TURAG4PcHFwoUCpS20DvVCPESMEqAqPESNUpQe9tewIKAgMB22227Lb0BBQr6D+DAJo1uhbPGPTmT9/uTmcwM7KZfDtNPp+l8tOvM1dVyd7c83ac+84nffBwwN4M9zTs9R3d7D+/1Hkz0NSb7Gvct9QeW2kNL9VF/Zaq/Mj2w/3ig/MRaempVZqzK7GBxbrAwP5R/NiQ/H5ZfDOde2rKvbNJrW+bNSObtiPjOvvfevvvBsQMu6kcCc1EXHD/ARV10boOL+sm5BS7q59FNcFFDBDZWvfizblLDY9/BTlXrr2pkbANMVbU61ZhrHaxVtTSq4FqDIdtEhTVqnMCG7DAV1qgJ9zcYcjlUWKOm3Ksw5F6psEZd8qzAqC/xT+qyJw0Df5N+Ne1Nw9iPqFNd8X4Fiz/cucMaddW7DC7qmm8JXNR1Xwpc1A1/ClzUTX8SXNStQAJc1O1AHFzUnXEBXNRdAnNR98Zj4KKKwSj0qOKXeiZUl0K1W1QlWlaipVK0dIvaEPIHgnwYl6VgBHp6VVWSbKiWC1dJOntV1fJVlEqMpNjZq6oexXMk0DNhjSqHK/nrFCL77Qlr1GqsWCMRCnUh355wW20S+H/UYqTcnvBNauM6v/dK1ONEFtRtYqFewdQdZqGeJCRQL4eFepqUQL1XFmqLwNQvwUJtJTOg/iYW6llSBPUjslDPU+Il3WE3rUUO8aoAAAAASUVORK5CYII=", b: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAB4UlEQVR42sXU6VIaQRQF4H4h9n3Nc0WzuEWdYSBxyR61F8C4BQUFsif+Hp7JnGYCVQPRnpTT1V3n/1d9695DHgxpdUCrfVq9opVLWunRSpdWLmj5nJY7tPyJlc9YCTllpRNWOmbFI1b8yIqHrNhmhRYvNHlB8DzCeZ7xPOW5A57b57k9nvsgsu9F9p3IvhXZNyKDvBaZVyLzUqR3BTGipneaxIia3gZsQk1tNYkRNfUCsAk19RywCTXVAByqeuN/t6lJwPpU7/1TTdYB61S9N68mHcCa1b+2X03WAIexTWrYrybsFgllh5XwjJqwAIdxOWrYryY2AYdxr2rYryY2AIfUEv+lxtdbJMRuCq7GnwEOtREDqvE1wBp6eH6HZ9T4KmATagywETW2AtiEGltuEyNqdKlNjKjRp4BNqNEngE2o0ceATaiRR21iRI0sAjahRhYAB1Ab127jt8wdqvPNdb7K3KHa/ZF9JRN5CDjAXz218Uumjvx05//qqc4XmRry2Z3/q6falzIkyIRnVJkfrvNdZjrhGbU2HMkMZKYTnqpj+B6qHO9kwrepNYx3MuGpavcAq7ZJh2p3Aat2WIdqAVZejg7VugCsulcd6hhWtYQO1ToHrOomHaqElY2oQ7U6oz/sMkViifXP7QAAAABJRU5ErkJggg==", c: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAACGUlEQVR42sXU+U8TURAH8PkDaSndbvciKl5B8IoXahDPKB4QVFDTvdoi4IGi/BUKCBUQBNxttzdF0P8AX7uhSXctb4378ibf3z+ZyczA79H2XwlpJy7t6NK2Jm2r4k9F3JLFrZhYeSFUngubz4TNEaE8LJSe8qUnfPExXxziC4NcYYDLP+JyD7ncAy57P5rtj1r3otbdaOYOm77Npm+x5k3WvMEa1yNGX+THtchGb2TjKrN+hVm/zKz1MEBFXbvEABX1+8UwUFFXL4SBirp6HsE01JVzYaCirpxtA3/V3cZqpn47g2Biql1/VZdPtwFR1S63unwKwYRVuxzq0skQ+LJNeLhRXepGsB87jIUd6mJXCHy5HCzsUBdPhMCXe8XDjerXTgT79CX+SU0dbwUff5N3NXUMwb5+RI/qwtFWIPGH3TvsUBeOIJiGOn84CFTU+Y4gUFG/HEIwDXXuYBCoqHMHEExDnW0PABV1VkIwDXVGDAAVdUYIABX1M98CXtTytF7+WM0+av6tln+j5l+r+6jWqGIllUxS/sS1gJdebbX0QS9NaSjF95q7V1vNobxScxMKirtXW80kqgEvE3aoxXe1TGqFSa0+YYeaHa9lTLFeKvUJ19V0XIb/UQtovHsTbqZWszfhulqDcdtEQjV1GbA7TEI1NRmwl0NCrcG4eyWhGqoM2C9BQjWUGGB/Ewm1CmM/IgnVkGN/APded9/JzrEcAAAAAElFTkSuQmCC" };
    return (
      <View style={{ gap: 16 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Thumb uri={P.a} name="lease-photo.png" onRemove={() => {}} />
          <Thumb uri={P.b} name="signature.png" state="uploading" onRemove={() => {}} />
          <Thumb uri={P.c} name="scan.jpg" state="failed" onRemove={() => {}} />
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}><Thumb uri={P.a} name="lease-photo.png" size={120} /><Thumb uri={P.b} name="signature.png" size={120} /></View>
      </View>
    );
  }
  if (name === "away-card") return <AwayView lines={["3 new things need you", "1 Flow run did not finish", "2 Flow runs finished", "1 document was signed", "1 new member joined"]} onSeen={() => {}} />;
  if (name === "notice-answered") {
    return <View style={{ gap: 8 }}><NoticeAnswered kind="approved" say="Approved: An assistant (kit) wants to send an email: Northwind" onClose={() => {}} /><NoticeAnswered kind="denied" say="Denied: An assistant (kit) wants to send an email: Oakline" onClose={() => {}} /><NoticeAnswered kind="gone" say="That request ended before you answered." onClose={() => {}} /><NoticeAnswered kind="failed" say="Face ID or Touch ID did not work. Nothing was approved." onClose={() => {}} /></View>;
  }
  if (name === "chat-tools-fork") return <View style={{ gap: 12 }}><Card><ForkRows otherPlace="server" onFork={() => {}} onForkTo={() => {}} /></Card><Card><ForkRows otherPlace="mac" onFork={() => {}} onForkTo={() => {}} /></Card><Card><ForkRows otherPlace={null} onFork={() => {}} onForkTo={() => {}} /></Card></View>;
  if (name === "signin-card") {
    const site = { id: "connectors:li", title: "Sign in to app.example.com again", detail: "HTTP 401: the login ran out. Sign in on the site, then check again.", at: 1, buttons: [{ label: "Check it now", tool: "connectors.connection.check", input: { id: "li" } }] };
    const screen = { ...site, id: "connectors:cp", title: "Sign in to portal.example.com again", buttons: [{ label: "Check it now", tool: "connectors.connection.check", input: { id: "cp" } }, { label: "Open the computer's screen", open: "/u/glass/kit" }] };
    const key = { id: "connectors:k", title: "The key for api.example.com stopped working", detail: "The service refused the key. Fix it in the Vault, then check it.", at: 1, buttons: [{ label: "Check it now", tool: "connectors.connection.check", input: { id: "k" } }] };
    return <View style={{ gap: 12 }}><SignInView card={site} busy={false} hint="Still waiting. Sign in on the site, then check again." onPress={() => {}} /><SignInView card={screen} busy={false} hint="" onPress={() => {}} /><SignInView card={key} busy hint="" onPress={() => {}} /></View>;
  }
  if (name === "space-computers") return <View style={{ gap: 12 }}><ComputersView space="Northwind's Cloud" allowed={false} busy={false} problem="" onChange={() => {}} /><ComputersView space="Northwind's Cloud" allowed busy={false} problem="Only an owner or an admin of this Space can change that." onChange={() => {}} /><Card><Text tone="label">{memberLine("Northwind's Cloud", true)}</Text><Text tone="label">{memberLine("Harlow Legal's Cloud", false)}</Text></Card></View>;
  if (name === "assistant-access") return <AccessView s={{ assistant: "assistant", tools: [{ name: "records.delete", at: 1 }, { name: "mail.*", at: 2 }], screens: [{ id: "vault", label: "Vault", off: true }, { id: "mail", label: "Mail and messages", off: false }, { id: "records", label: "Records and contacts", off: false }, { id: "files", label: "Files and Drive", off: false }, { id: "publish", label: "Publishing", off: true }] }} busy={false} problem="" typed="" setTyped={() => {}} onSwitch={() => {}} onTurnOffTool={() => {}} onTurnOnTool={() => {}} />;
  if (name === "flow-draft") {
    return <View style={{ gap: 8 }}><FlowDraftNote s={{ kind: "making" }} onClear={() => {}} /><FlowDraftNote s={{ kind: "ready", id: "fl_1", title: "Open a matter" }} onClear={() => {}} /><FlowDraftNote s={{ kind: "none" }} onClear={() => {}} /></View>;
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

/** The guided-flow kit (FlowStep, Stack, CodeField, CodeDisplay, MatchWords, PasswordField, ChoiceList, ProviderRow) in one page: /gallery?f=flow-kit. */
function FlowKit() {
  const [code, setCode] = useState("WINK-7QMK");
  const [pw, setPw] = useState("river amber");
  const [pick, setPick] = useState<"a" | "b">("a");
  return (
    <FlowStep steps={{ labels: ["Identity", "Master password", "Inference", "Space", "Ready"], current: 1 }} onBack={() => {}} title="Flow step" lead="Back, the step strip, a title and one line, the body, a failure, one primary." failure="What went wrong, in words, and what to do next." primary={{ label: "Primary action", onPress: () => {} }} secondary={{ label: "Quiet alternative", onPress: () => {} }}>
      <CodeField label="Code field" prefix="WINK" value={code} onChangeText={setCode} />
      <CodeDisplay label="Code display" code="WINK-7QMK-4P2X" note="Good for 10 min." />
      <MatchWords label="Match words" words={["river", "amber", "stone", "quiet"]} note="Check them against your server." />
      <PasswordField label="Password field" meter value={pw} onChangeText={setPw} />
      <ChoiceList label="Choice list" value={pick} onChange={setPick} options={[{ value: "a", title: "Create a space", sub: "You need a server.", icon: "space" }, { value: "b", title: "Join a space", sub: "Someone invited you.", icon: "users" }]} />
      <Card flush>
        <ProviderRow provider="claude" title="Claude" sub="Sign in with your Claude subscription." state="idle" onConnect={() => {}} />
        <ProviderRow provider="codex" title="Codex" sub="Sign in with your ChatGPT account." state="connected" onConnect={() => {}} onTest={() => {}} />
        <ProviderRow provider="grok" title="Grok" sub="Sign in with your Grok account." state="failed" problem="Sign-in did not finish." onConnect={() => {}} />
      </Card>
      <Stack row gap={2}><Text tone="label">Stack, row, gap 2</Text><Text tone="muted">Stack</Text></Stack>
    </FlowStep>
  );
}

const CMP_PEOPLE = [
  { name: "Dana Wine", family: "person" as const }, { name: "Anna Reyes", family: "person" as const },
  { name: "Claude", family: "assistant" as const, doing: "Drafting the estate letter" }, { name: "Codex", family: "assistant" as const }, { name: "Grok", family: "assistant" as const },
];
const CMP_RECORDS = [
  { name: "Wine estate plan", type: "Matter", sealed: 2, urn: "urn:rec:1", kind: "record" }, { name: "Q3 intake", type: "Project", sealed: 0, urn: "urn:rec:2", kind: "project" },
  { name: "Trust certificate.pdf", type: "File", sealed: 0, urn: "urn:rec:3", kind: "file" }, { name: "Quarterly review", type: "Tag", sealed: 0, urn: "urn:rec:4", kind: "tag" },
];
const CMP_SLOTS = [{ id: "s1", label: "kit on Claude", provider: "claude" }, { id: "s2", label: "kit on Codex", provider: "codex" }, { id: "s3", label: "Grok", provider: "grok" }];
const CMP_MODELS = [{ id: "opus", label: "Opus", fit: 94 }, { id: "sonnet", label: "Sonnet", fit: 88 }, { id: "haiku", label: "Haiku", fit: 71 }];

/** The composer, before and after, side by side: /gallery?f=composer. The "after" is live: try / @ # and Cmd+/ with the keyboard only. */
function ComposerCompare() {
  const [model, setModel] = useState("opus");
  const [where, setWhere] = useState<"mac" | "server">("server");
  const common = { state: "idle", people: CMP_PEOPLE, records: CMP_RECORDS, models: CMP_MODELS, model, onModel: (id: string) => setModel(id), slots: CMP_SLOTS, runsOn: where, onRunsOn: () => setWhere((w) => (w === "mac" ? "server" : "mac")), onSend: () => {}, onAttachFile: () => {}, vyreFiles: [{ id: "f1", name: "Trust certificate.pdf", path: "Projects/Wine estate/Received" }, { id: "f2", name: "Site visit.mp4", path: "Projects/Wine estate/Made" }, { id: "f3", name: "Deed scan.png", path: "Projects/Wine estate/Received" }], onAttachVyreFile: () => {} };
  return (
    <View style={{ gap: 24 }}>
      <View style={{ gap: 6 }}><Text size="caption" tone="label">After (live)</Text><ChatComposer {...common} phone={false} /></View>
      <View style={{ gap: 6 }}><Text size="caption" tone="label">Chat panel (live, keyboard: arrows, letters, Enter, Esc)</Text><PanelSample phone={false} /></View>
      <View style={{ gap: 6, maxWidth: 390 }}><Text size="caption" tone="label">After, phone width</Text><ChatComposer {...common} phone autoFocus={false} /></View>
    </View>
  );
}

/** The one chat panel, open on a page: /gallery?f=composer shows it beside the composer; ?f=chat-panel&page=project|effort|... one page. */
function PanelSample({ phone, page: first = "root" }: { phone: boolean; page?: PanelPage }) {
  const { color } = useUiTheme();
  const [page, setPage] = useState<PanelPage>(first);
  const [cur, setCur] = useState<{ slug: string; name: string } | null>(null);
  const projects = [{ slug: "northwind", name: "Northwind Bakery" }, { slug: "juniper", name: "Juniper Studio intake" }, { slug: "okafor", name: "Okafor estate" }];
  const part = [{ id: "person:alex", name: "alex", family: "person" as const, role: "" }, { id: "assistant:juno", name: "juno", family: "assistant" as const, role: "" }];
  return (
    <View style={{ height: 780, position: "relative", overflow: "hidden", borderWidth: 1, borderColor: color.edge, borderRadius: 12, width: phone ? 390 : undefined }}>
      <ChatPanel open phone={false} page={page} onPage={setPage} onClose={() => setPage("root")} participants={part} viewer="person:alex" info={{ record: null, sealed: 0, runsOn: "server" }}
        muted={false} pinned={false} onMute={() => {}} onPin={() => {}} onMove={() => {}} onLinkRecord={() => {}}
        project={{ current: cur, projects, move: async (to) => { setCur(projects.find((x) => x.slug === to) ?? null); return null; } }}
        thread="demo" chat="demo" shared replyMode="every" otherPlace="mac" />
    </View>
  );
}

export default function Gallery() {
  const q = useLocalSearchParams<{ f?: string; form?: string; screen?: string; theme?: string; page?: string; id?: string }>();
  // ?theme=dark|paper sets the person's theme for this view (the Design MCP's render); without it the picture follows the system, as the picture tests expect.
  if ((q.theme === "dark" || q.theme === "paper") && useAppearance.getState().person.theme !== q.theme) useAppearance.getState().setPerson({ theme: q.theme });
  if (q.f === "composer") return <ThemeProvider><Page><View nativeID="fixture"><ComposerCompare /></View></Page></ThemeProvider>;
  if (q.f === "sites-real" || q.f === "sites-real-site") {
    // Sites on a stand-in box: canned publish.* answers, so the real screens can be looked at with no server.
    const dep = (id: string, name: string, version: number, stage: string, url: string | null, domains: { host: string; status: string }[] = []) => ({ id, name, version, stage, url, domains });
    const deps = [dep("d1", "client-intake", 3, "Preview", "https://preview-3.client-intake.example.vyre.run"), dep("d2", "client-intake", 2, "Production", "https://client-intake.example.vyre.run", [{ host: "intake.firm.example", status: "verified" }]), dep("d3", "fee-calculator", 1, "Approved", "https://preview-1.fee-calculator.example.vyre.run"), dep("d4", "menu-site", 4, "Production", null, [{ host: "menu.example.com", status: "waiting" }])];
    setBoxOverride(async (tool) => {
      if (tool === "publish.list") return { deployments: deps };
      if (tool === "publish.status") return { ...deps[0], previous: "d2", build_digest: "sha256:3f9a", secrets: [{ name: "STRIPE_KEY", class: "secret", use: ["runtime"] }], ungranted_env: ["MAILER_KEY"], approved_by: null, published_at: null, sealed_check: "no sealed values found" };
      if (tool === "publish.job.attention") return { jobs: [{ deployment: "d4", name: "menu-site", at: Date.now() - 600000, message: "the nightly sync exited 1" }] };
      if (tool === "publish.job.runs") return { runs: [{ at: Date.now() - 3600000, ok: true, seconds: 4 }, { at: Date.now() - 90000000, ok: false, code: 1, message: "the nightly sync exited 1" }] };
      if (tool === "vault.list") return { items: [{ name: "Stripe", kind: "api", fields: ["key"] }] };
      return {};
    });
    return <ThemeProvider><Page><View nativeID="fixture">{q.f === "sites-real" ? <RealSites /> : <RealSite />}</View></Page></ThemeProvider>;
  }
  if (q.f === "chat-panel") return <ThemeProvider><Page><View nativeID="fixture"><PanelSample phone={false} page={(q.page as PanelPage) || "root"} /></View></Page></ThemeProvider>;
  if (q.f === "flow-kit") return <ThemeProvider><FlowKit /></ThemeProvider>;
  // The shell looks and the space tiles are components, not block fixtures: /gallery?f=shell shows every state of the sidebar, ?f=shell-main|shell-folded|shell-projects|shell-projects-folded|shell-records one, ?f=space-tiles the tiles.
  if (typeof q.f === "string" && (q.f === "space-tiles" || q.f === "shell" || q.f.startsWith("shell-"))) return <ThemeProvider><Page><View nativeID="fixture"><Sample name={q.f} /></View></Page></ThemeProvider>;
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
