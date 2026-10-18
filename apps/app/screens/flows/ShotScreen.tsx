// Fixtures for the screenshot pass (scripts/ux-shots.mjs): the Flow editor with two triggers, an If with both lanes and a reviewed task step; a run read step by step with inputs and outputs; and the
// Playbook "Who does it, reviews and approves" sheet. Sample world only (allowsMock): on a real box this route is not found. The data is made up here and touches nothing.
import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Card, EmptyState, FlowBuilder, allowsMock } from "@vyre/ui";
import type { FlowDraft } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { SlotsSheet } from "../templates/SlotsSheet";
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

export default function ShotScreen() {
  const { k } = useLocalSearchParams<{ k?: string }>();
  const [draft, setDraft] = useState<FlowDraft>(EDITOR);
  if (!allowsMock()) return <Frame title="Not here" back="/u/flows"><EmptyState title="Not here" body="This page is only for the sample world." /></Frame>;
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
