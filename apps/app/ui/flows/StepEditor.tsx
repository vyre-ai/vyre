import { View } from "react-native";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { Row } from "../components/Row";
import { Select } from "../components/Select";
import { Switch } from "../components/Switch";
import { Text } from "../components/Text";
import { ContextBox } from "./ContextBox";
import { ValueField } from "./ValueField";
import { FormulaBox } from "./FormulaBox";
import { OPERATORS, UNIT_CHOICES, approverChoices, condExpr, firstStageTasks, whoChoices, whoWords } from "./logic.js";
import { flat } from "./tree.js";
import type { Draft, DraftStep, Options } from "./logic.js";

const pick = (list: { name: string; label: string }[]): [string, string][] => list.map((x) => [x.name, x.label]);

/** Where a step can read a record from: what started the Flow, or a record an earlier step made. */
export function recordSources(d: Draft, stepId: string, o: Options): [string, string][] {
  const before: DraftStep[] = [];
  for (const x of flat(d.steps)) { if (x.id === stepId) break; before.push(x); }
  const made = before.filter((s) => s.kind === "create" || s.kind === "upsert").map((s): [string, string] => [s.id, `The ${o.types.find((t) => t.name === s.type)?.label ?? "new"} record made in ${s.id}`]);
  return [...(d.trigger.kind === "created" || d.trigger.kind === "stage" ? [["trigger", "The record that started the Flow"] as [string, string]] : []), ...made];
}

/** Rows of field and value, for Create a record, Create or update and Run another flow. */
function Rows({ rows, onChange, draft, stepId, options, fieldLabel = "Field", help }: { rows: { field: string; value: string }[]; onChange: (r: { field: string; value: string }[]) => void; draft: Draft; stepId: string; options: Options; fieldLabel?: string; help?: string }) {
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">{fieldLabel === "Field" ? "Fields" : `${fieldLabel}s`}</Text>
      {rows.map((f, i) => (
        <View key={i} className="gap-s1">
          <View className="flex-row items-end gap-s2">
            <View className="min-w-0 flex-1"><Field label={i ? undefined : fieldLabel} name={fieldLabel} value={f.field} onChangeText={(field) => onChange(rows.map((x, k) => (k === i ? { ...x, field } : x)))} placeholder="For example Amount" /></View>
            <View className="min-w-0 flex-1"><ValueField label={i ? undefined : "Value"} name="Value" value={f.value} onChange={(value) => onChange(rows.map((x, k) => (k === i ? { ...x, value } : x)))} placeholder="Text, or {amount}" draft={draft} stepId={stepId} options={options} /></View>
            <Button kind="ghost" size="sm" icon="x" label="Remove field" onPress={() => onChange(rows.filter((_, k) => k !== i))} />
          </View>
        </View>
      ))}
      <View className="flex-row"><Button kind="ghost" size="sm" icon="plus" label="Add a field" onPress={() => onChange([...rows, { field: "", value: "" }])} /></View>
      <Text size="caption" tone="label">{help ?? "A value in braces, like {email}, is taken from what started the Flow or an earlier step."}</Text>
    </View>
  );
}

/** The condition of an If: a field, how to compare it and a value, or a formula. */
function Condition({ s, setStep, draft, options }: { s: DraftStep; setStep: (patch: Partial<DraftStep>) => void; draft: Draft; options: Options }) {
  const c = s.cond ?? { mode: "build", source: "trigger", op: ">" };
  const set = (patch: Record<string, unknown>) => setStep({ cond: { ...c, ...patch } });
  const earlier: [string, string][] = [["trigger", "What started the Flow"]];
  for (const x of flat(draft.steps)) { if (x.id === s.id) break; if (x.kind === "find" || x.kind === "create" || x.kind === "upsert" || x.kind === "formula") earlier.push([x.id, `Result of ${x.id}`]); }
  if (c.mode === "formula") {
    return (
      <>
        <FormulaBox label="Condition (a formula that is true or false)" value={c.formula ?? ""} onChange={(formula) => set({ formula })} placeholder="For example trigger.amount > 500 and trigger.status == &quot;open&quot;" />
        <View className="flex-row"><Button kind="ghost" size="sm" label="Build it from a field instead" onPress={() => set({ mode: "build" })} /></View>
      </>
    );
  }
  return (
    <>
      <Select label="Check a field of" value={c.source ?? "trigger"} options={earlier} onChange={(source) => set({ source })} />
      <Field label="Field" value={c.field ?? ""} onChangeText={(field) => set({ field })} placeholder="For example amount" />
      <Select label="Is" value={c.op ?? ">"} options={OPERATORS} onChange={(op) => set({ op })} />
      <Field label="Value" value={String(c.value ?? "")} onChangeText={(value) => set({ value })} placeholder="For example 500" />
      <View className="flex-row"><Button kind="ghost" size="sm" label="Edit as a formula" onPress={() => set({ mode: "formula", formula: condExpr(c, draft.trigger) })} /></View>
    </>
  );
}

/** The settings of one step, whatever its kind. */
export function StepEditor({ s, setStep, draft, options }: { s: DraftStep; setStep: (id: string, patch: Partial<DraftStep>) => void; draft: Draft; options: Options }) {
  const links = recordSources(draft, s.id, options);
  const set = (patch: Partial<DraftStep>) => setStep(s.id, patch);
  const sets = (patch: Partial<DraftStep>) => setStep(s.id, patch);
  void sets;
  return (
    <>
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
                  <ContextBox label="Instructions for the agent" value={s.instructions ?? ""} onChange={(instructions) => setStep(s.id, { instructions })} options={options} placeholder="What to do with this case"
                    help="They go into the prompt that wakes the agent for this task, after its own instructions (who to escalate to, which email alias to use outside)." />
                  <Select label="The record to hand over" value={s.record ?? ""} options={links} placeholder="Choose a record" onChange={(record) => setStep(s.id, { record })} />
                  <Text size="caption" tone="label">The agent gets the record and its details.</Text>
                </>
              ) : null}
              {s.kind === "assign" ? (
                <>
                  <Select label="Who gets the task (a person, a team or role, or an agent)" value={s.to ?? ""} options={whoChoices(options)} placeholder="Choose" onChange={(to) => setStep(s.id, { to })} />
                  <Field label="The task" value={s.title ?? ""} onChangeText={(title) => setStep(s.id, { title })} placeholder="For example Call the client back" />
                  <ContextBox label="Brief for them" value={s.brief ?? ""} onChange={(brief) => setStep(s.id, { brief })} options={options} placeholder="What they need to know" />
                  <Text size="caption" tone="label">A team or role is everyone who holds that role. Any of them can pick it up.</Text>
                </>
              ) : null}
              {s.kind === "agent" || s.kind === "assign" ? (
                <View className="gap-s3 border-t border-edge pt-s3">
                  <Text strong>Who checks it and who follows it</Text>
                  <Select label="Approver (optional): a person or a team or role" value={s.checker ?? ""} options={approverChoices(options)} onChange={(checker) => setStep(s.id, { checker: checker || undefined })} />
                  {s.checker ? <ContextBox label="Note for the approver" value={s.approverNote ?? ""} onChange={(approverNote) => setStep(s.id, { approverNote })} options={options} placeholder="What to check" /> : null}
                  <Followers s={s} options={options} onChange={(patch) => setStep(s.id, patch)} />
                  <Text size="caption" tone="label">All of them see it in their Now: to do, to approve, following. An agent can check internal work; anything that goes out still waits for a person.</Text>
                </View>
              ) : null}
              {s.kind === "email" ? (
                <>
                  <ValueField label="To" value={s.to ?? ""} onChange={(to) => setStep(s.id, { to })} placeholder="An address, or {email} from the form" draft={draft} stepId={s.id} options={options} />
                  <ValueField label="Subject" value={s.subject ?? ""} onChange={(subject) => setStep(s.id, { subject })} draft={draft} stepId={s.id} options={options} />
                  <ValueField label="Message" multiline lines={5} value={s.body ?? ""} onChange={(body) => setStep(s.id, { body })} draft={draft} stepId={s.id} options={options} />
                  <SendWith kind="email" s={s} set={set} options={options} />
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

      {s.kind === "decide" ? <Condition s={s} setStep={set} draft={draft} options={options} /> : null}
      {s.kind === "repeat" ? (
        <>
          <Select label="Go through" value={s.over ?? ""} options={[...flat(draft.steps).filter((x) => x.kind === "find").map((x): [string, string] => [`steps.${x.id}.rows`, `The records found by ${x.id}`]), ...(s.over && !flat(draft.steps).some((x) => `steps.${x.id}.rows` === s.over) ? [[s.over, s.over] as [string, string]] : [])]} placeholder="Choose a list (add a Find records step first)" onChange={(over) => set({ over })} />
          <Field label="Call each one" value={s.as ?? "item"} onChangeText={(as) => set({ as })} help="Inside, read it as this name, for example item.id." />
          <Text size="caption" tone="label">Up to 50 items. The steps inside run once for each.</Text>
        </>
      ) : null}
      {s.kind === "parallel" ? <Text tone="muted">Each side runs at the same time. The Flow carries on when every side is done. Add steps to each side below.</Text> : null}
      {s.kind === "find" ? (
        <>
          <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => set({ type })} />
          <FormulaBox label="Only records where (optional, a formula)" value={s.where ?? ""} onChange={(where) => set({ where })} placeholder="For example record.email == trigger.email" />
          <Field label="At most" value={String(s.limit ?? 20)} onChangeText={(limit) => set({ limit: Number(limit) || 20 })} kind="number" />
          <Text size="caption" tone="label">Later steps read the records as the list steps.{s.id}.rows.</Text>
        </>
      ) : null}
      {s.kind === "upsert" ? (
        <>
          <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => set({ type })} />
          <Rows rows={s.matchFields ?? []} onChange={(matchFields) => set({ matchFields })} draft={draft} stepId={s.id} options={options} fieldLabel="Match on" help="The record whose fields equal these is updated. If there is none, one is made." />
          <Rows rows={s.fields ?? []} onChange={(fields) => set({ fields })} draft={draft} stepId={s.id} options={options} />
        </>
      ) : null}
      {s.kind === "remove" ? (
        <>
          <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => set({ type })} />
          <Select label="Which record" value={s.record ?? ""} options={links} placeholder="Choose a record" onChange={(record) => set({ record })} />
          <Text size="caption" tone="label">A removed record can be restored from its history.</Text>
        </>
      ) : null}
      {s.kind === "stage" ? (
        <>
          <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => set({ type })} />
          <Select label="Which record" value={s.record ?? ""} options={links} placeholder="Choose a record" onChange={(record) => set({ record })} />
          <Field label="Move it to the stage" value={s.to ?? ""} onChangeText={(to) => set({ to })} placeholder="For example Drafting" />
        </>
      ) : null}
      {s.kind === "wait" ? (
        <View className="flex-row items-end gap-s2">
          <View className="w-24"><Field label="Wait" value={String(s.amount ?? 1)} onChangeText={(amount) => set({ amount: Number(amount) || 1 })} kind="number" /></View>
          <View className="min-w-0 flex-1"><Select label="For" value={s.unit ?? "hours"} options={UNIT_CHOICES} onChange={(unit) => set({ unit })} /></View>
        </View>
      ) : null}
      {s.kind === "formula" ? (
        <>
          <FormulaBox label="Formula" value={s.formula ?? ""} onChange={(formula) => set({ formula })} placeholder="For example round(trigger.amount * 1.2)" />
          <Text size="caption" tone="label">{`Later steps read the answer as {steps.${s.id}.value}.`}</Text>
        </>
      ) : null}
      {s.kind === "sms" ? (
        <>
          <ValueField label="To" value={s.to ?? ""} onChange={(to) => set({ to })} placeholder="A number, or {phone} from the form" draft={draft} stepId={s.id} options={options} />
          <ValueField label="Message" multiline lines={4} value={s.body ?? ""} onChange={(body) => set({ body })} draft={draft} stepId={s.id} options={options} />
          <SendWith kind="sms" s={s} set={set} options={options} />
        </>
      ) : null}
      {s.kind === "web" ? (
        <>
          <Select label="Send with (a connection from the Vault)" value={s.connector ?? ""} options={pick(options.connections ?? [])} placeholder={(options.connections ?? []).length ? "Choose a connection" : "No connections yet"} onChange={(connector) => set({ connector })} />
          <Select label="What to do" value={s.method ?? "GET"} options={[["GET", "Fetch (GET)"], ["POST", "Post (POST)"], ["PUT", "Replace (PUT)"], ["PATCH", "Change (PATCH)"], ["DELETE", "Delete (DELETE)"]]} onChange={(method) => set({ method })} />
          <ValueField label="Path" value={s.path ?? "/"} onChange={(path) => set({ path })} placeholder="For example /v1/customers" draft={draft} stepId={s.id} options={options} />
          {(s.method ?? "GET") !== "GET" ? <ValueField label="Body" multiline lines={4} value={s.body ?? ""} onChange={(body) => set({ body })} draft={draft} stepId={s.id} options={options} /> : null}
          <Text size="caption" tone="label">The address and the key stay in the Vault connection: a step only names it, and Vyre never shows the key. A post or change is held for your yes.</Text>
        </>
      ) : null}
      {s.kind === "classify" ? (
        <>
          <ValueField label="The text to read" value={s.input ?? ""} onChange={(input) => set({ input })} placeholder="For example {message}" draft={draft} stepId={s.id} options={options} />
          <Field label="Groups, separated by commas" value={s.labels ?? ""} onChangeText={(labels) => set({ labels })} placeholder="For example Urgent, Routine" />
          <Text size="caption" tone="label">An AI step picks one group. Later steps read it as steps.{s.id}.label.</Text>
        </>
      ) : null}
      {s.kind === "extract" ? (
        <>
          <ValueField label="The text to read" value={s.input ?? ""} onChange={(input) => set({ input })} placeholder="For example {message}" draft={draft} stepId={s.id} options={options} />
          {(s.fields ?? []).map((f: { name: string; kind: string }, i: number) => (
            <View key={i} className="flex-row items-end gap-s2">
              <View className="min-w-0 flex-1"><Field label={i ? undefined : "Fact to pull out"} name="Fact" value={f.name} onChangeText={(name) => set({ fields: s.fields.map((x: any, k: number) => (k === i ? { ...x, name } : x)) })} placeholder="For example Amount" /></View>
              <View className="w-32"><Select value={f.kind ?? "text"} options={[["text", "Text"], ["number", "Number"], ["date", "Date"], ["boolean", "Yes or no"]]} onChange={(kind) => set({ fields: s.fields.map((x: any, k: number) => (k === i ? { ...x, kind } : x)) })} /></View>
              <Button kind="ghost" size="sm" icon="x" label="Remove fact" onPress={() => set({ fields: s.fields.filter((_: any, k: number) => k !== i) })} />
            </View>
          ))}
          <View className="flex-row"><Button kind="ghost" size="sm" icon="plus" label="Add a fact" onPress={() => set({ fields: [...(s.fields ?? []), { name: "", kind: "text" }] })} /></View>
        </>
      ) : null}
      {s.kind === "subflow" ? (
        <>
          <Select label="The flow to run" value={s.flow ?? ""} options={pick(options.flows ?? [])} placeholder="Choose a flow" onChange={(flow) => set({ flow })} />
          <Rows rows={s.fields ?? []} onChange={(fields) => set({ fields })} draft={draft} stepId={s.id} options={options} fieldLabel="Hand over" help="What the other flow starts with. It must be switched on in this space." />
        </>
      ) : null}
    </>
  );
}

/** The "Send with" choice of a Send step: only the Vault items that suit it (email: the sending service and mail logins; text: Twilio), by name, never a value. */
function SendWith({ kind, s, set, options }: { kind: "email" | "sms"; s: DraftStep; set: (patch: Partial<DraftStep>) => void; options: Options }) {
  const list = options.credentials ? options.credentials[kind] : null;
  if (!list) return <Text size="caption" tone="label">An owner chooses the sending account. You say yes to each one before it goes.</Text>;
  if (!list.length) return <Text size="caption" tone="label">{`No ${kind === "email" ? "sending service or mail login" : "text-sending account"} is in the Vault yet. An owner adds one there.`}</Text>;
  return (
    <>
      <Select label="Send with" value={s.sendWith ?? ""} options={list.map((c): [string, string] => [c.id, `${c.name} (${c.provider})`])} placeholder="The space's default" onChange={(id) => { const c = list.find((x) => x.id === id); set({ sendWith: id, ...(kind === "email" ? { sendStep: c?.step } : {}) }); }} />
      <Text size="caption" tone="label">Only items that suit this step are listed, by name. The key is never shown, and you say yes to each send.</Text>
    </>
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

/** The followers of a step: each a person, a team or role, or an agent, with one note they all get. */
function Followers({ s, options, onChange }: { s: DraftStep; options: Options; onChange: (patch: Partial<DraftStep>) => void }) {
  const list: string[] = s.followers ?? [];
  const choices = whoChoices(options).filter(([v]) => !list.includes(v));
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">Followers (optional)</Text>
      {list.map((f) => <View key={f} className="flex-row items-center gap-s2"><Chip icon="person">{whoWords(f, options)}</Chip><Button kind="ghost" size="sm" icon="x" label={`Stop following: ${whoWords(f, options)}`} onPress={() => onChange({ followers: list.filter((x) => x !== f) })} /></View>)}
      {choices.length ? <Select value="" options={choices} placeholder="Add a follower" onChange={(v) => onChange({ followers: [...list, v] })} /> : null}
      {list.length ? <ContextBox label="Note for the followers" value={s.followerNote ?? ""} onChange={(followerNote) => onChange({ followerNote })} options={options} placeholder="What they should know" /> : null}
    </View>
  );
}
