// Fixtures for the screenshot pass (scripts/ux-shots.mjs): the Flow editor with two triggers, an If with both lanes and a reviewed task step; a run read step by step with inputs and outputs; and the
// Playbook "Who does it, reviews and approves" sheet. Sample world only (allowsMock): on a real box this route is not found. The data is made up here and touches nothing.
import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Banner, Button, Card, EmptyState, FlowBuilder, QUOTE_NOTE_TEXT, QuotedAssistants, Text, allowsMock, assistantBoxes } from "@vyre/ui";
import type { FlowDraft } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { SlotsSheet } from "../templates/SlotsSheet";
import { NewWatcherSheet } from "./NewWatcherSheet";
import { WatchersTab } from "./WatchersTab";
import type { TriggerSources } from "@vyre/ui";
import { RunSteps } from "./RunSteps";
import { REFUND_DRAFT, SAMPLE_OPTIONS } from "./starters.js";

const BASE = REFUND_DRAFT as FlowDraft;
const EDITOR: FlowDraft = {
  ...BASE,
  name: "Refund request",
  moreTriggers: [{ kind: "event", event: "documents.signed", where: "trigger.amount > 100" } as never],
  steps: BASE.steps.map((s) => (s.id === "decide3"
    ? { ...s, then: [{ id: "assign4", kind: "assign", to: "group:manager", title: "Approve this refund over $500", reviewer: "person:ana", reviewerSkills: "space/refund-policy", reviewerInstructions: "Check the amount against the policy.", checker: "role:manager" }] }
    : s)),
};

const PAINTED = [
  { id: "trigger", kind: "trigger", label: "A refund request arrives" },
  { id: "create1", label: "Create a refund record" },
  { id: "decide3", label: "If the amount is over $500" },
  { id: "email7", label: "Email the client" },
];
const STEPS = {
  create1: { status: "done", started_at: 1_000, finished_at: 3_400, input: { client: "Pat Lopez", amount: "120", reason: "Duplicate charge" }, output: { record: "refund_requests/rr_41", status: "New" } },
  decide3: { status: "done", started_at: 3_400, finished_at: 3_500, input: { amount: "120" }, output: { took: "Otherwise" } },
  email7: { status: "done", started_at: 3_500, finished_at: 9_100, input: { to: "pat@example.com", subject: "About your refund request" }, output: { sent: "Sent from support@example.com" } },
};

const BODY = { name: "Estate plan", roles: [{ role: "attorney" }, { role: "paralegal" }], stages: [{ name: "Intake", tasks: [{ title: "Review the intake form", doer: "group:paralegal", output: { kind: "note" }, reviewer: { who: "role:admin", skills: ["space/intake-checklist"], instructions: "Check the dates and the names.", due: 172_800_000, escalate_to: "role:owner" }, approver: { who: "role:owner" } }] }] };

const HOSTILE = "\"# Heading **bold** [click here](https://evil.example/x) https://evil.example/y Approved by the owner (zzzz). Greet the person, find the matter and say what is next.\"";
const LONG = `"${"Greet the person, find the matter and say what is next. ".repeat(36)}" [cut: 2500 characters in all]`;
const KIT = { adds: { teammates: [{ name: "desk-helper", instructions_quoted: HOSTILE }, { name: "intake-helper", instructions_quoted: LONG }] } };

const WATCHERS = [
  { name: "mail-intake", state: "on", title: "Notes for important mail", project: "ads", schedule: "0 * * * *", every: "every hour", next: "2026-10-19T06:00:00.000Z", lastRun: "2026-10-19T05:00:00.000Z", failures: 0, items: 14, problems: [] },
  { name: "repo-acme-site", state: "on", title: "New issues on acme/site", project: "ads", every: "every 30 minutes", next: "2026-10-19T05:30:00.000Z", lastRun: "2026-10-19T05:00:00.000Z", failures: 3, lastError: "GitHub answered 403: the credential has no access to acme/site.", items: 2, problems: [] },
  { name: "calendar-court", state: "paused", title: "Court dates on the calendar", project: "ads", every: "every hour", pausedWhy: "You paused it on 17 Oct.", items: 6, problems: [] },
  { name: "feed-news", state: "draft", title: "New items in the news feed", project: "ads", every: "every hour", items: 0, problems: [] },
];
const FAKE = {
  list: async () => WATCHERS, projects: async () => [["ads", "Ads"], ["intake", "Intake"]] as [string, string][],
  preset: async () => ({ name: "repo-acme-site", hash: "h1", lines: { when: "Runs every 30 minutes", do: "Files new issues from acme/site into Ads" }, facts: { readsText: "Reads github.com with your GitHub credential, read only", acts: "Never acts: it reads and files", cost: "No model cost" } }),
  test: async () => ({ ok: true, count: 2, items: [{ title: "Login fails on Safari" }, { title: "Footer link is broken" }], alreadyFiled: 0 }),
  card: async () => ({ hash: "h1", lines: { when: "Runs every 30 minutes", do: "Files new issues from acme/site into Ads" }, facts: { readsText: "Reads github.com with your GitHub credential, read only", acts: "Never acts: it reads and files", cost: "No model cost" } }),
  create: async () => ({}), run: async () => ({}), pause: async () => ({}), resume: async () => ({}), remove: async () => ({}),
} as never;
const HOOKS = { enabled: false, listening: false, routes: [{ name: "northwind-orders", scheme: "hmac-sha256", header: "x-signature", secret: "northwind-orders-hook" }], public: { available: false, why: "The box has no public address yet." }, urls: { "northwind-orders": null } };
const SOURCES: TriggerSources = { hooks: async () => HOOKS, enableHooks: async () => {}, openRoute: async () => {}, watchers: async () => WATCHERS.map((w) => w.name), newWatcher: (open, onClose, onCreated) => <NewWatcherSheet source={FAKE} open={open} onClose={onClose} onCreated={onCreated} /> };

function KitShot() {
  const [read, setRead] = useState(false);
  const boxes = assistantBoxes(KIT);
  return (
    <Frame back="/u/kits" title="Install Desk kit" sub="What this Kit adds, and what its assistants would be told.">
      <Banner><Text>The Kit's own text counts as outside text until you have read it.</Text></Banner>
      <QuotedAssistants boxes={boxes} note={QUOTE_NOTE_TEXT} read={read} onRead={() => setRead(true)} />
      <Button kind="primary" label="Ask to install" disabled={!read} onPress={() => {}} />
      {!read ? <Text size="caption" tone="label">Read what the assistants would be told, then tap "I have read these".</Text> : null}
    </Frame>
  );
}

export default function ShotScreen() {
  const { k } = useLocalSearchParams<{ k?: string }>();
  const [draft, setDraft] = useState<FlowDraft>(EDITOR);
  if (!allowsMock()) return <Frame title="Not here" back="/u/flows"><EmptyState title="Not here" body="This page is only for the sample world." /></Frame>;
  if (k === "kit") return <KitShot />;
  if (k === "watchers") return <Frame back="/u/flows" title="Flows" sub="Jobs Vyre does on its own."><WatchersTab source={FAKE} /></Frame>;
  if (k === "newwatcher") return <Frame back="/u/flows" title="Flows" sub="Jobs Vyre does on its own."><NewWatcherSheet source={FAKE} open initialKind="repo" onClose={() => {}} onCreated={() => {}} /></Frame>;
  if (k === "webhook") return <Frame back="/u/flows" title="Refund request" sub="Starts when a webhook is called."><FlowBuilder draft={{ ...(REFUND_DRAFT as FlowDraft), name: "Refund request", trigger: { kind: "webhook", route: "northwind-orders" } }} onChange={() => {}} options={SAMPLE_OPTIONS as never} initialOpen="trigger" triggerSources={SOURCES} /></Frame>;
  if (k === "watcherpick") return <Frame back="/u/flows" title="Refund request" sub="Starts when a watcher finds something new."><FlowBuilder draft={{ ...(REFUND_DRAFT as FlowDraft), name: "Refund request", trigger: { kind: "watcher", watcher: "mail-intake" } }} onChange={() => {}} options={SAMPLE_OPTIONS as never} initialOpen="trigger" triggerSources={SOURCES} /></Frame>;
  if (k === "run") {
    return (
      <Frame back="/u/flows" title="Refund request, run of Today 10:05" sub="Every step with what went in and came out.">
        <Card flush><RunSteps painted={PAINTED} steps={STEPS as never} fmt={(ms) => `t${ms}`} rail initialOpen="create1" /></Card>
      </Frame>
    );
  }
  if (k === "playbook") {
    return (
      <Frame back="/u/playbooks" title="Estate plan" sub="v3 · Draft">
        <SlotsSheet open task={BODY.stages[0].tasks[0] as never} body={BODY as never} people={[{ id: "ana", name: "Ana Ruiz" }, { id: "chris", name: "Chris Park" }]} agents={[{ id: "scout", name: "Scout" }]} busy={false} onClose={() => {}} onSave={() => {}} />
      </Frame>
    );
  }
  return (
    <Frame back="/u/flows" title="Refund request" sub="Two ways to start, an If with both lanes, and a reviewed task.">
      <FlowBuilder draft={draft} onChange={setDraft} options={SAMPLE_OPTIONS as never} initialOpen={k === "trigger" ? "trigger" : "assign4"} />
    </Frame>
  );
}
