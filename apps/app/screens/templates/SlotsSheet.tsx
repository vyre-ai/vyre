import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Field, Select, Sheet, SkillsPicker, Switch, Text } from "@vyre/ui";
import { approverOf, assigneeChoices, slotProblems } from "./edit";
import type { Body, Slot, Task } from "./model";

const DUE: [string, string][] = [["", "No time limit"], ["3600000", "1 hour"], ["14400000", "4 hours"], ["86400000", "1 day"], ["172800000", "2 days"], ["259200000", "3 days"], ["604800000", "1 week"], ["1209600000", "2 weeks"]];

/** One slot's fields: who, the Space skills it checks against, what to look for, a time limit with the role it passes to, and (approver) whether everyone must answer. */
function SlotFields({ label, slot, onChange, body, people, agents, approver }: { label: string; slot: Slot | null; onChange: (s: Slot | null) => void; body: Body; people: { id: string; name: string }[]; agents: { id: string; name: string }[]; approver?: boolean }) {
  const who = assigneeChoices(body, people, agents).filter(([v]) => v !== "lead");
  const roles = (body.roles || []).map((r): [string, string] => [`role:${r.role}`, `The ${r.role}`]);
  const set = (patch: Partial<Slot>) => slot && onChange({ ...slot, ...patch });
  return (
    <View className="gap-s3">
      <Select label={label} value={slot?.who ?? ""} options={[["", approver ? "No approval" : "No review"], ...who]} onChange={(v) => onChange(v ? { ...(slot ?? {}), who: v } : null)} />
      {slot ? (
        <>
          <SkillsPicker label="Skills it checks against (optional)" value={slot.skills ?? []} onChange={(skills) => set({ skills })} />
          <Field label="Instructions (optional)" value={slot.instructions ?? ""} onChangeText={(t) => set({ instructions: t.slice(0, 2000) })} multiline placeholder="What to look for" />
          <Select label="Time limit" value={String(slot.due ?? "")} options={DUE} onChange={(v) => set({ due: v ? Number(v) : undefined })} />
          <Select label="If it runs late, pass it to" value={slot.escalate_to ?? ""} options={[["", "No one"], ...roles]} onChange={(v) => set({ escalate_to: v || undefined })} />
          {slot.escalate_to ? <Text size="caption" tone="label">That team needs at least one member, or the stage holds when a project reaches it.</Text> : null}
          {approver ? <Switch label="Everyone on the team must approve" on={slot.quorum === "all"} onChange={(on) => set({ quorum: on ? "all" : "any" })} /> : null}
        </>
      ) : null}
    </View>
  );
}

/** Edit who reviews and who approves one to-do of a playbook. Saving makes a new draft version; nothing running changes. */
export function SlotsSheet({ open, task, body, people, agents, busy, onClose, onSave }: { open: boolean; task: Task | null; body: Body; people: { id: string; name: string }[]; agents: { id: string; name: string }[]; busy: boolean; onClose: () => void; onSave: (reviewer: Slot | null, approver: Slot | null) => void }) {
  const [reviewer, setReviewer] = useState<Slot | null>(null);
  const [approver, setApprover] = useState<Slot | null>(null);
  useEffect(() => { if (open && task) { setReviewer(task.reviewer ?? null); setApprover(approverOf(task)); } }, [open, task]);
  const problems = [...slotProblems(reviewer, "reviewer", task?.doer), ...slotProblems(approver, "approver", task?.doer)];
  return (
    <Sheet open={open} onClose={onClose} title={task ? `Review and approval: ${task.title || "this to-do"}` : "Review and approval"}>
      <View className="gap-s4">
        <SlotFields label="Reviewer (optional): checks the work against the skills" slot={reviewer} onChange={setReviewer} body={body} people={people} agents={agents} />
        <SlotFields label="Approver (optional): the yes that lets it go out" slot={approver} onChange={setApprover} body={body} people={people} agents={agents} approver />
        {problems.map((p) => <Text key={p} tone="warn" size="caption">{p}</Text>)}
        <Text size="caption" tone="label">Saving makes a new draft version. Projects already running keep their own version.</Text>
        <View className="flex-row flex-wrap justify-end gap-s2"><Button kind="ghost" label="Cancel" onPress={onClose} /><Button kind="primary" label="Save as a draft" loading={busy} disabled={problems.length > 0} onPress={() => onSave(reviewer, approver)} /></View>
      </View>
    </Sheet>
  );
}
