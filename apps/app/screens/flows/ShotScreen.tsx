// Fixtures for the screenshot pass (scripts/ux-shots.mjs): the Flow editor with two triggers, an If with both lanes and a reviewed task step; a run read step by step with inputs and outputs; and the
// Playbook "Who does it, reviews and approves" sheet. Sample world only (allowsMock): on a real box this route is not found. The data is made up here and touches nothing.
import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Banner, Button, Card, EmptyState, FlowBuilder, QUOTE_NOTE_TEXT, QuotedAssistants, Text, allowsMock, assistantBoxes } from "@vyre/ui";
import type { FlowDraft } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { SlotsSheet } from "../templates/SlotsSheet";
import type { TriggerSources } from "@vyre/ui";
import type { FlowHookState } from "./watchers-source";
import { RunSteps } from "./RunSteps";
import { REFUND_DRAFT, SAMPLE_OPTIONS } from "./starters.js";
import { stageLine } from "./real-model.js";
import { fromDefinition as flowFromDefinition } from "../../ui/flows/logic.js";

// A Playbook stage opened in the Flow builder (kernel/flows/stage-flow.js): its stage trigger, its to-dos as task steps with their slots, and the move on.
const STAGE_FLOW = {
  format: 1, name: "stage-sample", label: "Ticket: Open", authorship: "kit",
  playbook: { key: "type:ticket::Open", type: "ticket", stage: "Open", from: "sample" },
  trigger: { on: "stage", type: "ticket", stage: "Open" },
  steps: [
    { id: "task_1", kind: "assign", label: "Draft the reply", title: "Draft the reply", to: "teammate:research", output: { kind: "note" }, reviewer: { who: "person:ana" }, await: true },
    { id: "task_2", kind: "assign", label: "Check the details", title: "Check the details", to: "person:chris", output: { kind: "note" }, checker: "person:ana", await: true },
    { id: "move", kind: "stage", label: "Move on to Review", type: "ticket", record: { expr: "trigger.id" }, to: "Review" },
  ],
};
const STAGE_OPTIONS = { ...SAMPLE_OPTIONS, types: [...SAMPLE_OPTIONS.types, { name: "ticket", label: "Ticket", fields: [{ name: "title", label: "Title" }, { name: "stage", label: "Stage", kind: "stage", options: ["Open", "Review", "Closed"] }], stages: [{ name: "Open" }, { name: "Review" }, { name: "Closed" }] }] };

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

const HOOK: FlowHookState = { open: true, address: { path: "/hooks/refund-request-4f9c", url: "https://team.example/hooks/refund-request-4f9c0b7e1d2a" }, why: null, last: { when: "Today 10:05", ok: true, bytes: 412 }, check: null };
const HOOK_WAIT: FlowHookState = { ...HOOK, address: { path: "/hooks/refund-request-4f9c", url: null }, why: "The public address is not up yet: the server's name does not point at it. Senders on the internet reach it once the server has its public address.", last: null };
const hookSources = (h: FlowHookState): TriggerSources => ({ flowHook: async () => h, renewHook: async () => {}, testHook: async () => ({ ok: true, line: "The test reached the address and its token checked. A test does not start the Flow." }), signHook: async () => {} });
const SOURCES = hookSources(HOOK);

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
  if (k === "webhook") return <Frame back="/u/flows" title="Refund request" sub="Starts when a webhook is called."><FlowBuilder draft={{ ...(REFUND_DRAFT as FlowDraft), name: "Refund request", trigger: { kind: "webhook" } }} onChange={() => {}} options={SAMPLE_OPTIONS as never} initialOpen="trigger" triggerSources={SOURCES} /></Frame>;
  if (k === "webhookwait") return <Frame back="/u/flows" title="Refund request" sub="Starts when a webhook is called."><FlowBuilder draft={{ ...(REFUND_DRAFT as FlowDraft), name: "Refund request", trigger: { kind: "webhook" } }} onChange={() => {}} options={SAMPLE_OPTIONS as never} initialOpen="trigger" triggerSources={hookSources(HOOK_WAIT)} /></Frame>;
  if (k === "formhook") return <Frame back="/u/flows" title="Contact form" sub="Starts when a form is submitted."><FlowBuilder draft={{ ...(REFUND_DRAFT as FlowDraft), name: "Contact form", trigger: { kind: "form", path: "contact" } }} onChange={() => {}} options={SAMPLE_OPTIONS as never} initialOpen="trigger" triggerSources={SOURCES} /></Frame>;
  if (k === "run") {
    return (
      <Frame back="/u/flows" title="Refund request, run of Today 10:05" sub="Every step with what went in and came out.">
        <Card flush><RunSteps painted={PAINTED} steps={STEPS as never} fmt={(ms) => `t${ms}`} rail initialOpen="create1" /></Card>
      </Frame>
    );
  }
  if (k === "stage") {
    return (
      <Frame back="/u/flows" title="Ticket: Open" sub="A Playbook stage">
        <Text tone="muted">{stageLine(STAGE_FLOW) || ""}</Text>
        <FlowBuilder draft={flowFromDefinition(STAGE_FLOW) as FlowDraft} onChange={() => {}} options={STAGE_OPTIONS as never} initialOpen="task_1" />
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
