import { View } from "react-native";
import { Button, Field, Select, Switch, Text } from "@vyre/ui";
import type { Body } from "./model";
import * as E from "./edit";

type Who = { id: string; name: string };

/** One task's settings: what it is, who does it, who approves and follows, when it is due, and what it ends with. Used by the template editor and by the board's task panel, so there is one place for them. */
export function TaskForm({ body, si, ti, onChange, people, agents }: { body: Body; si: number; ti: number; onChange: (b: Body) => void; people: Who[]; agents: Who[] }) {
  const s = body.stages[si], t = (s.tasks || [])[ti];
  const doers = E.assigneeChoices(body, people, agents);
  if (!t) return null;
  return (
    <View className="gap-s2">
  <Field label={`Task ${ti + 1}`} value={t.title} onChangeText={(v: string) => onChange(E.setTask(body, si, ti, { title: v }))} placeholder="Gather documents" />
  <Field label="Details (optional)" value={t.brief || ""} onChangeText={(v: string) => onChange(E.setTask(body, si, ti, { brief: v }))} multiline lines={3} />
  {E.groupsOf(s).length ? <Select label="Group" value={t.group || ""} options={[["", "No group"], ...E.groupsOf(s).map((g): [string, string] => [g.name, g.name])]} onChange={(v: string) => onChange(E.setTask(body, si, ti, { group: v }))} /> : null}
  <Select label="Assigned to (a person, a team or role such as Paralegals or Intake, the project lead, or an assistant)" value={t.doer} options={doers.some(([v]) => v === t.doer) ? doers : [...doers, [t.doer, E.assigneeWords(t.doer, people, agents)]]} onChange={(v: string) => onChange(E.setTask(body, si, ti, { doer: v }))} />
  <Field label="Due after (days, optional)" value={E.dueDays(t)} onChangeText={(v: string) => onChange(E.setDueDays(body, si, ti, v))} placeholder="3" />
  {E.kindOfDoer(t.doer) === "agent" ? <Field label="Needs a person's yes before it (optional)" value={E.approvalOf(t)} onChangeText={(v: string) => onChange(E.setApproval(body, si, ti, v))} placeholder="sending anything to the client" /> : null}
  <Select label="Approver (optional)" value={t.checker || ""} options={[["", "No approver"], ...doers.filter(([v]) => v.startsWith("role:") || v.startsWith("person:"))]} onChange={(v: string) => onChange(E.setTask(body, si, ti, { checker: v }))} />
  {t.checker ? <Field label="What the approver is told" value={E.noteOf(t, "approver")} onChangeText={(v: string) => onChange(E.setNote(body, si, ti, "approver", v))} multiline lines={2} /> : null}
  <View className="gap-s1">
    <Text size="caption" strong tone="label">Followers (optional)</Text>
      <Text size="caption" tone="muted">A follower is told this task's title and what you write for followers; she gets no access to the task or the project from it.</Text>
    <View className="flex-row flex-wrap gap-s2">{(t.followers || []).map((f) => <Button key={f} kind="ghost" size="sm" icon="x" label={E.assigneeWords(f, people, agents)} onPress={() => onChange(E.removeFollower(body, si, ti, f))} />)}</View>
    <Select label="Add a follower" value="" options={doers.filter(([v]) => v !== "lead" && !(t.followers || []).includes(v))} placeholder="Choose someone" onChange={(v: string) => v && onChange(E.addFollower(body, si, ti, v))} />
  </View>
  {(t.followers || []).length ? <Field label="What followers are told" value={E.noteOf(t, "followers")} onChangeText={(v: string) => onChange(E.setNote(body, si, ti, "followers", v))} multiline lines={2} /> : null}
  <Select label="It ends with" value={t.output.kind} options={E.OUTPUTS} onChange={(v: string) => onChange(E.setTask(body, si, ti, { output_kind: v }))} />
  {E.stageModeOf(body) !== "none" && E.doneWhenOf(s) === "needed" ? <View className="flex-row items-center gap-s3"><Switch on={t.required !== false} onChange={(v: boolean) => onChange(E.setTask(body, si, ti, { required: v ? undefined : false }))} label="Needed to finish" /><Text>Needed to finish</Text></View> : null}
  <View className="flex-row gap-s2">
    <Button kind="ghost" size="sm" label="Up" disabled={ti === 0} onPress={() => onChange(E.moveTask(body, si, ti, -1))} />
    <Button kind="ghost" size="sm" label="Down" disabled={ti === (s.tasks || []).length - 1} onPress={() => onChange(E.moveTask(body, si, ti, 1))} />
    <Button kind="ghost" size="sm" label="Remove task" onPress={() => onChange(E.removeTask(body, si, ti))} />

      </View>
    </View>
  );
}
