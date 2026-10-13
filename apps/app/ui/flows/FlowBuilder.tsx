import { useState } from "react";
import { View } from "react-native";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { IconTile } from "../components/IconTile";
import { Row } from "../components/Row";
import { Select } from "../components/Select";
import { Switch } from "../components/Switch";
import { Text } from "../components/Text";
import { StepCard } from "./StepCard";
import { EVERY_CHOICES, isRecordTrigger, STEP_CHOICES, TRIGGERS, choiceOf, firstStageTasks, flowSentence, moveStep, newStep, removeStep, stepProblem, stepSummary, triggerOf, triggerPhrase, whoChoices } from "./logic.js";
import type { Draft, DraftStep, Options } from "./logic.js";

export type { Draft, DraftStep, Options };

const pick = (list: { name: string; label: string }[]): [string, string][] => list.map((x) => [x.name, x.label]);

/** Where a step can read a record from: what started the Flow, or a record an earlier step made. */
function sources(d: Draft, before: number, o: Options): [string, string][] {
  const made = d.steps.slice(0, before).filter((s) => s.kind === "create").map((s): [string, string] => [s.id, `The ${o.types.find((t) => t.name === s.type)?.label ?? "new"} record made in step ${d.steps.indexOf(s) + 1}`]);
  return [...(isRecordTrigger(d.trigger) ? [["trigger", "The record that started the Flow"] as [string, string]] : []), ...made];
}

/**
 * The Flow builder: a Flow read as a sentence. Across the top the whole Flow in one line ("When a record is created in RefundRequests, create a RefundRequests record, then hand it to the
 * Refunds agent."), under it the trigger ("When") and the steps in order ("Then"), each a closed card that says what it does and opens to its settings, and "Add a step" with the palette of
 * what a Flow can do. It edits a draft; `toDefinition` writes the stored Flow. A step the engine cannot do yet is shown and marked Coming. See docs/design/system/components/flow-builder.md.
 */
export function FlowBuilder({ draft, onChange, options, readOnly, accessNote }: { draft: Draft; onChange: (d: Draft) => void; options: Options; readOnly?: boolean; /** What is true about access on this box; the default is the approver rule. */ accessNote?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setStep = (id: string, patch: Partial<DraftStep>) => set({ steps: draft.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const t = draft.trigger;
  const setTrig = (patch: Record<string, unknown>) => set({ trigger: { ...t, ...patch } });
  const toggle = (id: string) => setOpen(open === id ? null : id);

  return (
    <View className="gap-s4">
      <Card hero>
        <View className="gap-s2">
          <Text size="caption" tone="label" strong>This Flow, in one sentence</Text>
          <Text size="page" strong>{flowSentence(draft, options)}</Text>
        </View>
      </Card>

      <Text size="caption" tone="label">{accessNote ?? "When it runs, it uses the access of the person who approved it, and pauses if that access is lost."}</Text>
      <View>
        <StepCard lead="When" icon={(triggerOf(t.kind)?.icon ?? "bolt") as any} title={t.kind === "advanced" ? "Another way to start" : triggerOf(t.kind)?.label ?? "Choose what starts it"} summary={`When ${triggerPhrase(t, options)}`} open={open === "trigger"} onToggle={() => toggle("trigger")}
          last={!draft.steps.length && readOnly}>
          {t.kind === "advanced" ? <Text tone="muted">This Flow starts in a way the builder cannot show yet. It is kept as it is.</Text> : null}
          {t.kind === "advanced" ? null : <Select label="What starts the Flow" value={t.kind} options={TRIGGERS.map((x) => [x.id, x.label] as [string, string])} onChange={(kind) => setTrig({ kind })} />}
          {t.kind === "created" || t.kind === "stage" ? <Select label="Object" value={t.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => setTrig({ type })} /> : null}
          {t.kind === "stage" ? <Field label="Stage" value={t.stage ?? ""} onChangeText={(stage) => setTrig({ stage })} placeholder="For example Drafting" /> : null}
          {t.kind === "form" ? <Field label="Form name" value={t.path ?? ""} onChangeText={(path) => setTrig({ path })} placeholder="For example contact" help="Your site's form posts to this name." /> : null}
          {t.kind === "schedule" ? <Select label="How often" value={t.every ?? ""} options={EVERY_CHOICES.map((x) => [x, x] as [string, string])} placeholder="Choose" onChange={(every) => setTrig({ every })} /> : null}
          {t.kind === "signup" ? <Text tone="muted">Runs when someone signs up through your sign-up form. The person's name and email are what the steps start with.</Text> : null}
        </StepCard>

        {draft.steps.map((s, i) => {
          const c = choiceOf(s.kind);
          const problem = stepProblem(s, options);
          const links = sources(draft, i, options);
                  const last = i === draft.steps.length - 1 && !adding && !!readOnly;
          return (
            <StepCard key={s.id} lead={i === 0 ? "Then" : `Step ${i + 1}`} icon={(c?.icon ?? "flows") as any} title={c?.label ?? "Advanced step"} summary={stepSummary(s, options, draft)} problem={problem} open={open === s.id} onToggle={() => toggle(s.id)} last={last}
              onUp={!readOnly && i > 0 ? () => set({ steps: moveStep(draft.steps, i, -1) }) : undefined} onDown={!readOnly && i < draft.steps.length - 1 ? () => set({ steps: moveStep(draft.steps, i, 1) }) : undefined}
              onRemove={readOnly ? undefined : () => { set({ steps: removeStep(draft.steps, s.id) }); setOpen(null); }}>
              {s.kind === "advanced" ? <Text tone="muted">This step does something the builder cannot show yet. It is kept exactly as it is. Move it or remove it here, or change it as code on the Flow's page.</Text> : null}
              {s.kind === "create" ? (
                <>
                  <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => setStep(s.id, { type })} />
                  <View className="gap-s2">
                    <Text size="caption" strong tone="label">Fields</Text>
                    {(s.fields ?? []).map((f: { field: string; value: string }, fi: number) => (
                      <View key={fi} className="flex-row items-end gap-s2">
                        <View className="min-w-0 flex-1"><Field label={fi ? undefined : "Field"} name="Field" value={f.field} onChangeText={(field) => setStep(s.id, { fields: s.fields.map((x: any, k: number) => (k === fi ? { ...x, field } : x)) })} placeholder="For example Amount" /></View>
                        <View className="min-w-0 flex-1"><Field label={fi ? undefined : "Value"} name="Value" value={f.value} onChangeText={(value) => setStep(s.id, { fields: s.fields.map((x: any, k: number) => (k === fi ? { ...x, value } : x)) })} placeholder="Text, or {amount}" /></View>
                        <Button kind="ghost" size="sm" icon="x" label="Remove field" onPress={() => setStep(s.id, { fields: s.fields.filter((_: any, k: number) => k !== fi) })} />
                      </View>
                    ))}
                    <View className="flex-row"><Button kind="ghost" size="sm" icon="plus" label="Add a field" onPress={() => setStep(s.id, { fields: [...(s.fields ?? []), { field: "", value: "" }] })} /></View>
                    <Text size="caption" tone="label">A value in braces, like {"{email}"}, is taken from what started the Flow: the form's field or the record's.</Text>
                  </View>
                </>
              ) : null}
              {s.kind === "project" ? (
                <>
                  <Select label="Project template" value={s.template ?? ""} options={options.templates.map((x) => [x.id, x.name] as [string, string])} placeholder="Choose a template" onChange={(template) => setStep(s.id, { template })} />
                  <Field label="Project name" value={s.name ?? ""} onChangeText={(name) => setStep(s.id, { name })} placeholder="Named after the record" help="Leave blank to name it after the record." />
                  <Select label="Link the project to" value={s.link ?? ""} options={[["", "Nothing"], ...links]} onChange={(link) => setStep(s.id, { link })} />
                  <Tasks tpl={options.templates.find((x) => x.id === s.template)} o={options} />
                </>
              ) : null}
              {s.kind === "agent" ? (
                <>
                  <Select label="Agent" value={s.agent ?? ""} options={pick(options.agents)} placeholder="Choose an agent" onChange={(agent) => setStep(s.id, { agent })} />
                  <Field label="Task title" value={s.title ?? ""} onChangeText={(title) => setStep(s.id, { title })} placeholder="For example Handle this refund request" />
                  <Field label="Your instructions" multiline lines={5} value={s.instructions ?? ""} onChangeText={(instructions) => setStep(s.id, { instructions })} placeholder="What to do with this case"
                    help="They add to the agent's own instructions, which say who to escalate to and which email alias to use outside." />
                  <Select label="The record to hand over" value={s.record ?? ""} options={links} placeholder="Choose a record" onChange={(record) => setStep(s.id, { record })} />
                  <Text size="caption" tone="label">The agent gets the record and its details.</Text>
                </>
              ) : null}
              {s.kind === "assign" ? (
                <>
                  <Select label="Who gets the task (a person, a team or role, or an agent)" value={s.to ?? ""} options={whoChoices(options)} placeholder="Choose" onChange={(to) => setStep(s.id, { to })} />
                  <Field label="The task" value={s.title ?? ""} onChangeText={(title) => setStep(s.id, { title })} placeholder="For example Call the client back" />
                  <Text size="caption" tone="label">A team or role is everyone who holds that role. Any of them can pick it up.</Text>
                </>
              ) : null}
              {s.kind === "email" ? (
                <>
                  <Field label="To" value={s.to ?? ""} onChangeText={(to) => setStep(s.id, { to })} placeholder="An address, or {email} from the form" />
                  <Field label="Subject" value={s.subject ?? ""} onChangeText={(subject) => setStep(s.id, { subject })} />
                  <Field label="Message" multiline lines={5} value={s.body ?? ""} onChangeText={(body) => setStep(s.id, { body })} />
                  <Text size="caption" tone="label">Sent through your space's sending service. You say yes to each one before it goes.</Text>
                </>
              ) : null}
              {s.kind === "ask" ? (
                <>
                  <Select label="Who is asked" value={s.to ?? ""} options={whoChoices(options)} placeholder="Choose" onChange={(to) => setStep(s.id, { to })} />
                  <Field label="The question" value={s.title ?? ""} onChangeText={(title) => setStep(s.id, { title })} placeholder="For example Approve this refund" />
                  <Text size="caption" tone="label">The Flow stops here until they answer.</Text>
                </>
              ) : null}
              {s.kind === "update" ? (
                <>
                  <Select label="Which record" value={s.record ?? ""} options={links} placeholder="Choose a record" onChange={(record) => setStep(s.id, { record })} />
                  <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => setStep(s.id, { type })} />
                  <Field label="Field" value={s.field ?? ""} onChangeText={(field) => setStep(s.id, { field })} placeholder="For example Status" />
                  <Field label="New value" value={s.value ?? ""} onChangeText={(value) => setStep(s.id, { value })} placeholder="For example Refunded" />
                </>
              ) : null}
            </StepCard>
          );
        })}

        {readOnly ? null : (
          <View className="flex-row gap-s3">
            <View className="items-center"><IconTile size={40} name="plus" /></View>
            <View className="min-w-0 flex-1 gap-s3">
              {adding ? (
                <Card flush>
                  <View className="px-s4 pt-s3 pb-s1"><Text strong>What should happen next?</Text></View>
                  {STEP_CHOICES.map((c) => (
                    <Row key={c.kind} dense lead={<IconTile name={c.icon as any} />} title={c.label} sub={c.hint}
                      end={"soon" in c && c.soon ? <Chip tone="accent">Coming</Chip> : undefined}
                      onPress={"soon" in c && c.soon ? undefined : () => { const st = newStep(c.kind, draft, options); set({ steps: [...draft.steps, st] }); setOpen(st.id); setAdding(false); }} />
                  ))}
                  <View className="px-s4 py-s2"><Button kind="ghost" size="sm" label="Cancel" onPress={() => setAdding(false)} /></View>
                </Card>
              ) : <View className="flex-row"><Button kind="secondary" icon="plus" label={draft.steps.length ? "Add a step" : "Add the first step"} onPress={() => setAdding(true)} /></View>}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

/** What a started project hands out, from the template's own first stage: it shows that the template, not the Flow, assigns the tasks. */
function Tasks({ tpl, o }: { tpl: Options["templates"][number] | undefined; o: Options }) {
  const t = firstStageTasks(tpl, o);
  if (!t) return null;
  return (
    <Card flush>
      <View className="px-s4 pt-s3 pb-s1"><Text size="caption" tone="label" strong>{`When it starts, ${t.stage} hands out`}</Text></View>
      {t.tasks.length ? t.tasks.map((k) => <Row key={k.title} dense title={k.title} sub={`Goes to ${k.who}`} />) : <View className="px-s4 pb-s3"><Text tone="muted">No tasks in this stage yet.</Text></View>}
    </Card>
  );
}
