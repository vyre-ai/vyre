import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Divider, Field, GroupedList, Segmented, Select, Switch, Text } from "@vyre/ui";
import { Sec } from "../places/Frame";
import type { Body } from "./model";
import * as E from "./edit";
import { templates } from "./templates";
import { useMembers } from "../spaces/state";

/**
 * The template studio's visual editor: the name, the page projects open on, the roles, and the stages with their tasks, each a field or a choice, no JSON. Every change goes through edit.ts (pure, tested);
 * Save makes a new DRAFT version, and nothing changes for a running project until someone puts it live.
 */
export function TemplateEditor({ body, onChange, onSave, onCancel, saving }: { body: Body; onChange: (b: Body) => void; onSave: () => void; onCancel: () => void; saving: boolean }) {
  const [role, setRole] = useState("");
  const [flows, setFlows] = useState<{ id: string; name: string; active: boolean }[]>([]);
  useEffect(() => { templates.flows().then(setFlows).catch(() => setFlows([])); }, []);
  const [pick, setPick] = useState("");
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { templates.agents().then(setAgents).catch(() => setAgents([])); }, []);
  const { members } = useMembers();
  const people = members.map((m) => ({ id: m.id, name: m.name }));
  const todo = E.missing(body);
  const open = (body as Body & { opens_on?: string }).opens_on || "";
  const doers = E.assigneeChoices(body, people, agents), owners = E.ownerChoices(body);
  return (
    <View className="gap-s4">
      <Sec title="The template">
        <Field label="Template name" value={body.name} onChangeText={(v: string) => onChange(E.setName(body, v))} placeholder="Estate plan" />
        <Field label="What one project of it is called" value={body.noun?.one || ""} onChangeText={(v: string) => onChange(E.setNoun(body, v))} placeholder="Campaign" />
        {body.noun ? <Field label="What several are called" value={body.noun.many} onChangeText={(v: string) => onChange(E.setNoun(body, body.noun!.one, v))} placeholder="Campaigns" /> : null}
        <Text size="caption" tone="muted">{body.noun ? `The app says "New ${body.noun.one.toLowerCase()}" and "${body.noun.many}" wherever it names these. Leave it empty to call them projects.` : "An agency might say Campaign, a studio Job. Leave it empty to call them projects."}</Text>
        <Field label="What it is for" value={body.description || ""} onChangeText={(v: string) => onChange(E.setDescription(body, v))} multiline lines={2} />
        <Select label="A project of this template opens on" value={open} options={E.PAGES} onChange={(v: string) => onChange(E.setOpensOn(body, v))} />
      </Sec>
      <Sec title="Roles">
        <Text tone="muted">A role is who a kind of work is for. Give it to an assistant to have it done for you, or leave it to a person with that role. One role can be the project lead.</Text>
        <Card flush>
          {(body.roles || []).map((r, i) => (
            <View key={r.role}>{i ? <Divider /> : null}
              <View className="gap-s2 p-s3">
                <Text strong>{r.role}</Text>
                <Field label="Assistant that fills it (leave empty for a person)" value={r.agent || ""} onChangeText={(v: string) => onChange(E.setRoleAgent(body, r.role, v))} placeholder="research" />
                <View className="flex-row items-center gap-s3"><Switch on={Boolean(r.lead)} onChange={(v: boolean) => onChange(E.setRoleLead(body, r.role, v))} label={`${r.role} is the project lead`} /><Text>The project lead</Text></View>
                <View className="self-start"><Button kind="ghost" size="sm" label="Remove this role" onPress={() => onChange(E.removeRole(body, r.role))} /></View>
              </View>
            </View>
          ))}
        </Card>
        <View className="flex-row items-end gap-s2">
          <View className="min-w-0 flex-1"><Field label="Add a role" value={role} onChangeText={setRole} placeholder="attorney" /></View>
          <Button kind="ghost" size="sm" label="Add" disabled={!role.trim()} onPress={() => { onChange(E.addRole(body, role.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-"))); setRole(""); }} />
        </View>
      </Sec>
      <Sec title="How do projects move?">
        <Segmented label="How do projects move?" value={E.stageModeOf(body)} onChange={(v: string) => onChange(E.setStageMode(body, v))} options={E.STAGE_MODES} />
        <Text tone="muted">{E.stageModeOf(body) === "ordered" ? "A project goes through the stages one after another." : E.stageModeOf(body) === "any" ? "A person moves a project to any stage; finishing the tasks does not move it." : "No stages: a project is just its tasks."}</Text>
      </Sec>
      {(E.stageModeOf(body) === "none" ? body.stages.slice(0, 1) : body.stages).map((s, si) => (
        <Sec key={si} title={E.stageModeOf(body) === "none" ? "Tasks" : `Stage ${si + 1}`}>
          <Card><View className="gap-s3 p-s3">
            {E.stageModeOf(body) === "none" ? null : <Field label="Name" value={s.name} onChangeText={(v: string) => onChange(E.renameStage(body, si, v))} />}
            {E.stageModeOf(body) === "none" ? null : <View className="gap-s2">
              <Select label="Done when" value={E.doneWhenOf(s)} options={E.DONE_WHEN} onChange={(v: string) => onChange(E.setDoneWhen(body, si, v))} />
              {E.doneWhenOf(s) === "sign_off" ? <Select label="Who signs it off" value={s.sign_off || ""} options={[["", "Choose someone"], ...E.assigneeChoices(body, people, []).filter(([v]) => v.startsWith("role:") || v.startsWith("person:"))]} onChange={(v: string) => onChange(E.setSignOff(body, si, v))} /> : null}
              <Text size="caption" tone="muted">{E.nextLine(body, si)}</Text>
            </View>}
            <Select label="Who may move a project on early" value={s.owner || ""} options={owners} onChange={(v: string) => onChange(E.setStageOwner(body, si, v))} />
            <Field label="It moves on when (optional)" value={s.moves_on_when || ""} onChangeText={(v: string) => onChange(E.setMovesOn(body, si, v))} placeholder="the tasks are done" />
            <Text tone="muted">{(s.tasks || []).length ? "These tasks are made, and given to who is named, the moment a project enters this stage." : "No tasks yet. Add the work of this stage; each is given to a role, the project lead, a person or an assistant when a project enters it."}</Text>
            <GroupedList groups={E.groupsOf(s)} items={s.tasks || []} itemNoun="tasks" onChange={(n) => onChange(E.setStageGroups(body, si, n))} renderItems={(list) => (<View className="gap-s2">{list.map((t) => { const ti = (s.tasks || []).indexOf(t); return (
              <View key={ti} className="gap-s2 rounded-field border border-edge p-s3">
                <Field label={`Task ${ti + 1}`} value={t.title} onChangeText={(v: string) => onChange(E.setTask(body, si, ti, { title: v }))} placeholder="Gather documents" />
                <Field label="Details (optional)" value={t.brief || ""} onChangeText={(v: string) => onChange(E.setTask(body, si, ti, { brief: v }))} multiline lines={3} />
                {E.groupsOf(s).length ? <Select label="Group" value={t.group || ""} options={[["", "No group"], ...E.groupsOf(s).map((g): [string, string] => [g.name, g.name])]} onChange={(v: string) => onChange(E.setTask(body, si, ti, { group: v }))} /> : null}
                <Select label="Assigned to (a person, a team or role such as Paralegals or Intake, the project lead, or an assistant)" value={t.doer} options={doers.some(([v]) => v === t.doer) ? doers : [...doers, [t.doer, E.assigneeWords(t.doer, people, agents)]]} onChange={(v: string) => onChange(E.setTask(body, si, ti, { doer: v }))} />
                <Field label="Due after (days, optional)" value={E.dueDays(t)} onChangeText={(v: string) => onChange(E.setDueDays(body, si, ti, v))} placeholder="3" />
                {E.kindOfDoer(t.doer) === "agent" ? <Field label="Needs a person's yes before it (optional)" value={E.approvalOf(t)} onChangeText={(v: string) => onChange(E.setApproval(body, si, ti, v))} placeholder="sending anything to the client" /> : null}
                <Select label="Checked by" value={t.checker || ""} options={[["", "No one"], ...doers.filter(([v]) => v.startsWith("role:") || v.startsWith("person:"))]} onChange={(v: string) => onChange(E.setTask(body, si, ti, { checker: v }))} />
                <Select label="It ends with" value={t.output.kind} options={E.OUTPUTS} onChange={(v: string) => onChange(E.setTask(body, si, ti, { output_kind: v }))} />
                {E.stageModeOf(body) !== "none" && E.doneWhenOf(s) === "needed" ? <View className="flex-row items-center gap-s3"><Switch on={t.required !== false} onChange={(v: boolean) => onChange(E.setTask(body, si, ti, { required: v ? undefined : false }))} label="Needed to finish" /><Text>Needed to finish</Text></View> : null}
                <View className="flex-row gap-s2">
                  <Button kind="ghost" size="sm" label="Up" disabled={ti === 0} onPress={() => onChange(E.moveTask(body, si, ti, -1))} />
                  <Button kind="ghost" size="sm" label="Down" disabled={ti === (s.tasks || []).length - 1} onPress={() => onChange(E.moveTask(body, si, ti, 1))} />
                  <Button kind="ghost" size="sm" label="Remove task" onPress={() => onChange(E.removeTask(body, si, ti))} />
                </View>
              </View>
            ); })}</View>)} />
            <View className="flex-row flex-wrap gap-s2">
              <Button kind="ghost" size="sm" label="Add a task" onPress={() => onChange(E.addTask(body, si))} />
              <Button kind="ghost" size="sm" label="Move stage up" disabled={si === 0} onPress={() => onChange(E.moveStage(body, si, -1))} />
              <Button kind="ghost" size="sm" label="Move stage down" disabled={si === body.stages.length - 1} onPress={() => onChange(E.moveStage(body, si, 1))} />
              <Button kind="ghost" size="sm" label="Remove stage" disabled={body.stages.length <= 2} onPress={() => onChange(E.removeStage(body, si))} />
            </View>
          </View></Card>
        </Sec>
      ))}
      {E.stageModeOf(body) === "none" ? null : <View className="self-start"><Button kind="ghost" size="sm" label="Add a stage" onPress={() => onChange(E.addStage(body))} /></View>}
      <Sec title="Automations">
        <Text tone="muted">A Flow of this Space the template runs for each project: when it starts, or when it enters a stage. The Flow keeps its own approval and limits; only a running Flow runs.</Text>
        <Card flush>
          {(body.automations || []).map((a, i) => (
            <View key={`${a.when}|${a.flow}`}>{i ? <Divider /> : null}
              <View className="gap-s2 p-s3">
                <Text strong>{flows.find((f) => f.id === a.flow)?.name || a.flow}{flows.length && !flows.find((f) => f.id === a.flow)?.active ? " (not running)" : ""}</Text>
                <Select label="Runs" value={a.when} options={E.whenChoices(body)} onChange={(v: string) => onChange(E.setAutomationWhen(body, i, v))} />
                <View className="self-start"><Button kind="ghost" size="sm" label="Remove" onPress={() => onChange(E.removeAutomation(body, i))} /></View>
              </View>
            </View>
          ))}
        </Card>
        <View className="flex-row items-end gap-s2">
          <View className="min-w-0 flex-1"><Select label="Attach a Flow" value={pick} options={flows.map((f): [string, string] => [f.id, f.name + (f.active ? "" : " (not running)")])} onChange={setPick} placeholder={flows.length ? "Choose a Flow" : "No Flows yet"} /></View>
          <Button kind="ghost" size="sm" label="Attach" disabled={!pick} onPress={() => { onChange(E.addAutomation(body, pick)); setPick(""); }} />
        </View>
      </Sec>
      {todo.length ? <View className="gap-s1">{todo.map((m) => <Text key={m} size="caption" tone="label">{m}</Text>)}</View> : null}
      <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Save as a draft version" loading={saving} disabled={todo.length > 0} onPress={onSave} /><Button kind="ghost" size="sm" label="Cancel" onPress={onCancel} /></View>
    </View>
  );
}
