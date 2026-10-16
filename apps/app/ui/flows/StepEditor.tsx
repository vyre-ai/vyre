import { useState } from "react";
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
import { ComposeField } from "./ComposeField";
import { AddressField } from "./AddressField";
import { FormulaBox } from "./FormulaBox";
import { DocumentFields } from "./DocumentFields";
import { FailurePanel } from "./FailurePanel";
import { FORM_KINDS, HOWS, OUTPUTS, TARGETED, dateChoices, fieldChoices, fieldValue, stageChoices, stagesOf, OPERATORS, UNIT_CHOICES, WAIT_MODES, WHEN_CHOICES, approverChoices, askChoices, condExpr, firstStageTasks, isRecordTrigger, whoChoices, whoWords, actionChoices, actionPick } from "./logic.js";
import { flat } from "./tree.js";
import type { Draft, DraftStep, Options } from "./logic.js";

const pick = (list: { name: string; label: string }[]): [string, string][] => list.map((x) => [x.name, x.label]);

/** Where a step can read a record from: what started the Flow, or a record an earlier step made. */
export function recordSources(d: Draft, stepId: string, o: Options): [string, string][] {
  const before: DraftStep[] = [];
  for (const x of flat(d.steps)) { if (x.id === stepId) break; before.push(x); }
  const made = before.filter((s) => s.kind === "create" || s.kind === "upsert" || s.kind === "pick").map((s): [string, string] => [s.id, `The ${o.types.find((t) => t.name === s.type)?.label ?? "new"} record made in ${s.id}`]);
  return [...(isRecordTrigger(d.trigger) ? [["trigger", "The record that started the Flow"] as [string, string]] : []), ...made];
}

/** Rows of field and value, for Create a record, Create or update and Run another Flow. */
function Rows({ rows, onChange, draft, stepId, options, fieldLabel = "Field", help, title }: { rows: { field: string; value: string }[]; onChange: (r: { field: string; value: string }[]) => void; draft: Draft; stepId: string; options: Options; fieldLabel?: string; help?: string; title?: string }) {
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">{title ?? (fieldLabel === "Field" ? "Fields" : `${fieldLabel}s`)}</Text>
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
  for (const x of flat(draft.steps)) { if (x.id === s.id) break; if (x.kind === "find" || x.kind === "pick" || x.kind === "filter" || x.kind === "create" || x.kind === "upsert" || x.kind === "formula") earlier.push([x.id, `Result of ${x.id}`]); }
  if (c.mode === "formula") {
    return (
      <>
        <FormulaBox label="Condition (a formula that is true or false)" value={c.formula ?? ""} onChange={(formula) => set({ formula })} placeholder="For example trigger.amount > 500 and trigger.status == &quot;open&quot;" />
        <View className="flex-row"><Button kind="ghost" size="sm" label="Build it from a field instead" onPress={() => set({ mode: "build" })} /></View>
      </>
    );
  }
  const more: any[] = c.more ?? [];
  const setClause = (i: number, patch: Record<string, unknown>) => (i === 0 ? set(patch) : set({ more: more.map((x, k) => (k === i - 1 ? { ...x, ...patch } : x)) }));
  return (
    <>
      {[c, ...more].map((x, i) => (
        <View key={i} className="gap-s2">
          {i ? <Select label="Joined to the one above with" value={c.join === "or" ? "or" : "and"} options={[["and", "and: both must hold"], ["or", "or: either can hold"]]} onChange={(join) => set({ join })} /> : null}
          <Select label="Check a field of" value={x.source ?? "trigger"} options={earlier} onChange={(source) => setClause(i, { source })} />
          <Field label="Field" value={x.field ?? ""} onChangeText={(field) => setClause(i, { field })} placeholder="For example amount" />
          <Select label="Is" value={x.op ?? ">"} options={OPERATORS} onChange={(op) => setClause(i, { op })} />
          <Field label="Value" value={String(x.value ?? "")} onChangeText={(value) => setClause(i, { value })} placeholder="For example 500" />
          {i ? <View className="flex-row"><Button kind="ghost" size="sm" icon="x" label="Remove this check" onPress={() => set({ more: more.filter((_, k) => k !== i - 1) })} /></View> : null}
        </View>
      ))}
      <View className="flex-row gap-s2">
        <Button kind="ghost" size="sm" icon="plus" label="Add another check" onPress={() => set({ more: [...more, { source: "trigger", field: "", op: "==", value: "" }] })} />
        <Button kind="ghost" size="sm" label="Edit as a formula" onPress={() => set({ mode: "formula", formula: condExpr(c, draft.trigger) })} />
      </View>
    </>
  );
}

/** The settings of one step, whatever its kind. */
export function StepEditor({ s, setStep, draft, options, inHandler }: { s: DraftStep; setStep: (id: string, patch: Partial<DraftStep>) => void; draft: Draft; options: Options; /** The step runs only when something failed, so it has no failure steps of its own. */ inHandler?: boolean }) {
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
                        <View className="min-w-0 flex-1">{fieldChoices(options, s.type).length ? <Select label={fi ? undefined : "Field"} value={fieldValue(options, s.type, f.field)} options={fieldChoices(options, s.type, f.field)} placeholder="Choose a field" onChange={(field) => setStep(s.id, { fields: s.fields.map((x: any, k: number) => (k === fi ? { ...x, field } : x)) })} /> : <Field label={fi ? undefined : "Field"} name="Field" value={f.field} onChangeText={(field) => setStep(s.id, { fields: s.fields.map((x: any, k: number) => (k === fi ? { ...x, field } : x)) })} placeholder="For example Amount" />}</View>
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
                  <Select label="Project playbook" value={s.template ?? ""} options={options.templates.map((x) => [x.id, x.name] as [string, string])} placeholder="Choose a playbook" onChange={(template) => setStep(s.id, { template })} />
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
                  <Switch label="The Flow waits for the agent to finish" on={s.await !== false} onChange={(on) => setStep(s.id, { await: on ? undefined : false })} />
                  <Field label="Skills it needs (optional)" value={s.skills ?? ""} onChangeText={(skills) => setStep(s.id, { skills })} placeholder="For example intake, billing" help="Words separated by commas, up to 20." />
                  <Text size="caption" tone="label">{`Runs as ${s.agent || "the agent"}, with its own access. A Connection the approved Kit names for the task is lent for that task only, and only from someone who holds it.`}</Text>
                </>
              ) : null}
              {s.kind === "assign" ? (
                <>
                  <Select label="Who gets the task (a person, a team or role, or an agent)" value={s.to ?? ""} options={whoChoices(options)} placeholder="Choose" onChange={(to) => setStep(s.id, { to })} />
                  <Field label="The task" value={s.title ?? ""} onChangeText={(title) => setStep(s.id, { title })} placeholder="For example Call the client back" />
                  <ContextBox label="Brief for them" value={s.brief ?? ""} onChange={(brief) => setStep(s.id, { brief })} options={options} placeholder="What they need to know" />
                  <Select label="The record to attach (optional)" value={s.record ?? ""} options={[["", "Nothing"], ...links]} onChange={(record) => setStep(s.id, { record: record || undefined })} />
                  <Select label="How they do it (optional)" value={s.how ?? ""} options={[["", "The usual way"], ...HOWS]} onChange={(how) => setStep(s.id, { how: how || undefined })} />
                  {s.how === "template" || s.how === "tailor" ? <ContextBox label="Template" value={s.template ?? ""} onChange={(template) => setStep(s.id, { template })} options={options} placeholder="The text they start from" /> : null}
                  <Switch label="The Flow waits until the task is done" on={s.await === true} onChange={(on) => setStep(s.id, { await: on ? true : undefined })} />
                  <Field label="Skills it needs (optional)" value={s.skills ?? ""} onChangeText={(skills) => setStep(s.id, { skills })} placeholder="For example intake, billing" help="Words separated by commas, up to 20." />
                  <Text size="caption" tone="label">A team or role is everyone who holds that role. Any of them can pick it up.</Text>
                </>
              ) : null}
              {s.kind === "agent" || s.kind === "assign" ? (
                <View className="gap-s3 border-t border-edge pt-s3">
                  <Select label="What comes back" value={s.output ?? "note"} options={OUTPUTS} onChange={(output) => setStep(s.id, { output })} />
                  {TARGETED.has(s.output) ? <Field label={s.output === "fields" ? "Fields to fill in on the record" : s.output === "file" ? "Folder for the file (optional)" : "Name of the draft (optional)"} value={s.outputTarget ?? ""} onChangeText={(outputTarget) => setStep(s.id, { outputTarget })} placeholder={s.output === "fields" ? "For example status, owner" : s.output === "file" ? "For example contracts/signed" : "For example welcome"} help={s.output === "fields" ? "Separated by commas. The task is done when they are filled in." : undefined} /> : null}
                  <Text strong>Who checks it and who follows it</Text>
                  <Select label="Approver (optional): a person or a team or role" value={s.checker ?? ""} options={approverChoices(options)} onChange={(checker) => setStep(s.id, { checker: checker || undefined })} />
                  {s.checker ? <ContextBox label="Note for the approver" value={s.approverNote ?? ""} onChange={(approverNote) => setStep(s.id, { approverNote })} options={options} placeholder="What to check" /> : null}
                  <Followers s={s} options={options} onChange={(patch) => setStep(s.id, patch)} />
                  <Text size="caption" tone="label">All of them see it in their Now: to do, to approve, following. An agent can check internal work; anything that goes out still waits for a person.</Text>
                </View>
              ) : null}
              {s.kind === "email" ? (
                <>
                  <SendWith kind="email" s={s} set={set} options={options} />
                  <AddressField label="From (optional)" value={s.from ?? ""} onChange={(from) => setStep(s.id, { from: from || undefined })} placeholder="The sending account's own address" draft={draft} stepId={s.id} options={options} note="Sends only if this address is on the sending account's domain. If it is not, the run stops and tells you." />
                  <AddressField label="To" many value={s.to ?? ""} onChange={(to) => setStep(s.id, { to })} placeholder="An address, or a value from an earlier step" draft={draft} stepId={s.id} options={options} />
                  <ComposeField label="Subject" multiline={false} value={s.subject ?? ""} onChange={(subject) => setStep(s.id, { subject })} draft={draft} stepId={s.id} options={options} />
                  <AddressField label="Reply-To (optional)" value={s.replyTo ?? ""} onChange={(replyTo) => setStep(s.id, { replyTo: replyTo || undefined })} placeholder="An address, or a value from an earlier step" draft={draft} stepId={s.id} options={options} />
                  <ComposeField label="Message" value={s.body ?? ""} onChange={(body) => setStep(s.id, { body })} draft={draft} stepId={s.id} options={options} />
                  <ComingNext />
                </>
              ) : null}
              {s.kind === "ask" ? (
                <>
                  <Select label="Who is asked" value={s.to ?? ""} options={askChoices(options)} placeholder="Choose" onChange={(to) => setStep(s.id, { to })} />
                  <Field label="The question" value={s.title ?? ""} onChangeText={(title) => setStep(s.id, { title })} placeholder="For example Approve this refund" />
                  <Select label="The record to show them (optional)" value={s.record ?? ""} options={[["", "Nothing"], ...links]} onChange={(record) => setStep(s.id, { record: record || undefined })} />
                  <View className="gap-s2">
                    <Text size="caption" strong tone="label">Questions to fill in (optional)</Text>
                    {(s.form ?? []).map((f: { name?: string; label: string; kind: string; required: boolean; choices: string }, i: number) => (
                      <View key={i} className="gap-s2">
                        <View className="flex-row items-end gap-s2">
                          <View className="min-w-0 flex-1"><Field label={i ? undefined : "Question"} name="Question" value={f.label} onChangeText={(label) => setStep(s.id, { form: s.form.map((x: any, k: number) => (k === i ? { ...x, label } : x)) })} placeholder="For example Refund amount" /></View>
                          <View className="w-36"><Select value={f.kind ?? "text"} options={FORM_KINDS} onChange={(kind) => setStep(s.id, { form: s.form.map((x: any, k: number) => (k === i ? { ...x, kind } : x)) })} /></View>
                          <Button kind="ghost" size="sm" icon="x" label="Remove question" onPress={() => setStep(s.id, { form: s.form.filter((_: any, k: number) => k !== i) })} />
                        </View>
                        {f.kind === "choice" ? <Field label="The choices, separated by commas" value={f.choices ?? ""} onChangeText={(choices) => setStep(s.id, { form: s.form.map((x: any, k: number) => (k === i ? { ...x, choices } : x)) })} placeholder="For example Card, Cash" /> : null}
                        <Switch label="They must answer this" on={f.required === true} onChange={(required) => setStep(s.id, { form: s.form.map((x: any, k: number) => (k === i ? { ...x, required } : x)) })} />
                      </View>
                    ))}
                    <View className="flex-row"><Button kind="ghost" size="sm" icon="plus" label="Add a question" onPress={() => setStep(s.id, { form: [...(s.form ?? []), { label: "", kind: "text", required: false, choices: "" }] })} /></View>
                  </View>
                  <Text size="caption" tone="label">The Flow stops here until they answer.</Text>
                </>
              ) : null}
              {s.kind === "update" ? (
                <>
                  <Select label="Which record" value={s.record ?? ""} options={links} placeholder="Choose a record" onChange={(record) => setStep(s.id, { record })} />
                  <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => setStep(s.id, { type })} />
                  {fieldChoices(options, s.type).length ? <Select label="Field" value={fieldValue(options, s.type, s.field)} options={fieldChoices(options, s.type, s.field)} placeholder="Choose a field" onChange={(field) => setStep(s.id, { field })} /> : <Field label="Field" value={s.field ?? ""} onChangeText={(field) => setStep(s.id, { field })} placeholder="For example Status" />}
                  <Field label="New value" value={s.value ?? ""} onChangeText={(value) => setStep(s.id, { value })} placeholder="For example Refunded" />
                  <Rows rows={s.more ?? []} onChange={(more) => setStep(s.id, { more })} draft={draft} stepId={s.id} options={options} title="Also set" help="More fields changed on the same record in the same step." />
                </>
              ) : null}

      {s.kind === "decide" ? <Condition s={s} setStep={set} draft={draft} options={options} /> : null}
      {s.kind === "repeat" ? (
        <>
          <Select label="Go through" value={s.over ?? ""} options={[...flat(draft.steps).filter((x) => x.kind === "find" || x.kind === "filter").map((x): [string, string] => [`steps.${x.id}.rows`, `The records found by ${x.id}`]), ...(s.over && !flat(draft.steps).some((x) => `steps.${x.id}.rows` === s.over) ? [[s.over, s.over] as [string, string]] : [])]} placeholder="Choose a list (add a Find records step first)" onChange={(over) => set({ over })} />
          <FormulaBox label="Or any list, as a formula (optional)" value={s.over ?? ""} onChange={(over) => set({ over })} placeholder="For example trigger.items or steps.read.fields.names" />
          <Field label="Call each one" value={s.as ?? "item"} onChangeText={(as) => set({ as })} help="Inside, read it as this name, for example item.id." />
          <Field label="Go through at most" kind="number" value={String(s.max ?? 50)} onChangeText={(max) => set({ max: max === "" ? "" : Number(max) })} help="The most items to handle: 50 unless you say, 1000 at the most. When the list is longer, the run page says it was cut." />
          <Text size="caption" tone="label">The steps inside run once for each.</Text>
        </>
      ) : null}
      {s.kind === "parallel" ? <Text tone="muted">Each side runs at the same time. The Flow carries on when every side is done. Add steps to each side below.</Text> : null}
      {s.kind === "pick" ? (
        <>
          <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => set({ type })} />
          <FormulaBox label="Which one (optional, a formula)" value={s.where ?? ""} onChange={(where) => set({ where })} placeholder="For example record.email == trigger.email" />
          <Text size="caption" tone="label">{`Later steps read it as {steps.${s.id}.record.id}, and whether one was found as {steps.${s.id}.found}. It is the first record that matches.`}</Text>
        </>
      ) : null}
      {s.kind === "filter" ? (
        <>
          <Select label="Narrow this list" value={s.from ?? ""} options={[...flat(draft.steps).filter((x) => (x.kind === "find" || x.kind === "filter") && x.id !== s.id).map((x): [string, string] => [`steps.${x.id}.rows`, `The records from ${x.id}`]), ...(s.from && !flat(draft.steps).some((x) => `steps.${x.id}.rows` === s.from) ? [[s.from, s.from] as [string, string]] : [])]} placeholder="Choose a list (add a Find records step first)" onChange={(from) => set({ from })} />
          <FormulaBox label="Keep the ones where (a formula)" value={s.where ?? ""} onChange={(where) => set({ where })} placeholder="For example record.status == &quot;Open&quot;" />
          <Text size="caption" tone="label">{`Later steps read what is kept as {steps.${s.id}.rows}.`}</Text>
        </>
      ) : null}
      {s.kind === "find" ? (
        <>
          <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => set({ type })} />
          <FormulaBox label="Only records where (optional, a formula)" value={s.where ?? ""} onChange={(where) => set({ where })} placeholder="For example record.email == trigger.email" />
          <Field label="At most" value={String(s.limit ?? 20)} onChangeText={(limit) => set({ limit: Number(limit) || 20 })} kind="number" />
          <Field label="Sort by (optional)" value={s.sortField ?? ""} onChangeText={(sortField) => set({ sortField })} placeholder="For example created_at" />
          {s.sortField ? <Select label="Order" value={s.sortDir ?? "asc"} options={[["asc", "Smallest or oldest first"], ["desc", "Largest or newest first"]]} onChange={(sortDir) => set({ sortDir })} /> : null}
          <Text size="caption" tone="label">Later steps read the records as the list steps.{s.id}.rows.</Text>
        </>
      ) : null}
      {s.kind === "upsert" ? (
        <>
          <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => set({ type })} />
          <Rows rows={s.matchFields ?? []} onChange={(matchFields) => set({ matchFields })} draft={draft} stepId={s.id} options={options} title="Match on" help="The first record whose fields equal these is used. If there is none, one is made with these fields too." />
          <Rows rows={s.fields ?? []} onChange={(fields) => set({ fields })} draft={draft} stepId={s.id} options={options} title="Set when it is created" help="Only used when no record matches. A record that is found keeps what it has." />
          {s.updateFields ? (
            <Rows rows={s.updateFields} onChange={(updateFields) => set({ updateFields })} draft={draft} stepId={s.id} options={options} title="Also update if found" help="Optional. Changed only when a record is found. Leave empty to use the found record as it is." />
          ) : (
            <View className="gap-s2">
              <Text size="caption" tone="label">This older step also changes the fields above on a record it finds.</Text>
              <View className="flex-row"><Button kind="ghost" size="sm" label="Only set them when creating" onPress={() => set({ updateFields: [] })} /></View>
            </View>
          )}
          <Text size="caption" tone="label">{`Later steps read the record as {steps.${s.id}.record.id} and whether it was new as {steps.${s.id}.created}.`}</Text>
        </>
      ) : null}
      {s.kind === "remove" ? (
        <>
          <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => set({ type })} />
          <Select label="Which record" value={s.record ?? ""} options={links} placeholder="Choose a record" onChange={(record) => set({ record })} />
          <Text size="caption" tone="label">A removed record can be restored from its history.</Text>
        </>
      ) : null}
      {s.kind === "document" ? <DocumentFields s={s} set={set} draft={draft} options={options} links={links} /> : null}
      {s.kind === "stage" ? (
        <>
          <Select label="Object" value={s.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => set({ type })} />
          <Select label="Which record" value={s.record ?? ""} options={links} placeholder="Choose a record" onChange={(record) => set({ record })} />
          {stagesOf(options, s.type).length ? <Select label="Move it to the stage" value={s.to ?? ""} options={stageChoices(options, s.type, s.to)} placeholder="Choose a stage" onChange={(to) => set({ to })} /> : <Field label="Move it to the stage" value={s.to ?? ""} onChangeText={(to) => set({ to })} placeholder="For example Drafting" />}
        </>
      ) : null}
      {s.kind === "wait" ? (
        <>
          <Select label="Wait" value={s.mode === "until" ? "until" : "for"} options={WAIT_MODES} onChange={(mode) => set({ mode, ...(mode === "until" ? { when: s.when ?? "before", unit: s.unit === "days" || s.unit === "hours" || s.unit === "minutes" ? s.unit : "hours" } : {}) })} />
          {s.mode === "until" ? (
            <>
              <Select label="Date to wait for" value={s.field ?? ""} options={dateChoices(draft, s.id, options)} placeholder="Choose the date, such as the appointment" onChange={(field) => set({ field })} />
              {s.when === "at" ? null : (
                <>
                  <Field label="Amount" value={String(s.amount ?? 1)} onChangeText={(amount) => set({ amount: Number(amount) || 1 })} kind="number" />
                  <Select label="Unit" value={s.unit ?? "hours"} options={UNIT_CHOICES} onChange={(unit) => set({ unit })} />
                </>
              )}
              <Select label="When" value={s.when ?? "before"} options={WHEN_CHOICES} onChange={(when) => set({ when })} />
              <Text size="caption" tone="label">If that time has already passed, the Flow carries on at once.</Text>
            </>
          ) : (
            <View className="flex-row items-end gap-s2">
              <View className="w-24"><Field label="Wait" value={String(s.amount ?? 1)} onChangeText={(amount) => set({ amount: Number(amount) || 1 })} kind="number" /></View>
              <View className="min-w-0 flex-1"><Select label="For" value={s.unit ?? "hours"} options={UNIT_CHOICES} onChange={(unit) => set({ unit })} /></View>
            </View>
          )}
        </>
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
          <ComposeField label="Message" count value={s.body ?? ""} onChange={(body) => set({ body })} draft={draft} stepId={s.id} options={options} />
          <SendWith kind="sms" s={s} set={set} options={options} />
        </>
      ) : null}
      {s.kind === "web" ? (
        <>
          <Select label="Send with (a connection)" value={s.connector ?? ""} options={pick(options.connections ?? [])} placeholder={(options.connections ?? []).length ? "Choose a connection" : "No connections yet"} onChange={(connector) => set({ connector })} />
          <Select label="What to do" value={s.method ?? "GET"} options={[["GET", "Fetch (GET)"], ["HEAD", "Check it is there (HEAD)"], ["POST", "Post (POST)"], ["PUT", "Replace (PUT)"], ["PATCH", "Change (PATCH)"], ["DELETE", "Delete (DELETE)"]]} onChange={(method) => set({ method })} />
          <ValueField label="Path" value={s.path ?? "/"} onChange={(path) => set({ path })} placeholder="For example /v1/customers" draft={draft} stepId={s.id} options={options} />
          <Rows rows={s.query ?? []} onChange={(query) => set({ query })} draft={draft} stepId={s.id} options={options} fieldLabel="Name" title="Query (optional)" help="Added to the address as ?name=value." />
          <Rows rows={s.headers ?? []} onChange={(headers) => set({ headers })} draft={draft} stepId={s.id} options={options} fieldLabel="Header" title="Headers (optional)" help="Keep keys in the Vault: use a connection above, and Vyre adds the key when the call is made. A key typed here is refused." />
          {(s.method ?? "GET") !== "GET" && (s.method ?? "GET") !== "HEAD" ? <ValueField label="Body" multiline lines={4} value={s.body ?? ""} onChange={(body) => set({ body })} draft={draft} stepId={s.id} options={options} /> : null}
          <Select label="A file from Drive (optional)" value={s.driveMode ?? ""} options={[["", "None"], ["upload", "Send a file from Drive"], ["save", "Save the answer to Drive"]]} onChange={(driveMode) => set({ driveMode: driveMode || undefined })} />
          {s.driveMode ? <Field label="Drive path" value={s.drivePath ?? ""} onChangeText={(drivePath) => set({ drivePath })} placeholder="For example contracts/signed.pdf" help="A path in the Space's Drive." /> : null}
          {s.driveMode === "upload" ? <Field label="File type (optional)" value={s.driveType ?? ""} onChangeText={(driveType) => set({ driveType })} placeholder="For example application/pdf" /> : null}
          <NewConnection options={options} onAdded={(connector) => set({ connector })} />
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
          {(s.fields ?? []).map((f: { name: string; kind: string; description?: string }, i: number) => (
            <View key={i} className="gap-s2">
            <View className="flex-row items-end gap-s2">
              <View className="min-w-0 flex-1"><Field label={i ? undefined : "Fact to pull out"} name="Fact" value={f.name} onChangeText={(name) => set({ fields: s.fields.map((x: any, k: number) => (k === i ? { ...x, name } : x)) })} placeholder="For example Amount" /></View>
              <View className="w-32"><Select value={f.kind ?? "text"} options={[["text", "Text"], ["number", "Number"], ["date", "Date"], ["boolean", "Yes or no"]]} onChange={(kind) => set({ fields: s.fields.map((x: any, k: number) => (k === i ? { ...x, kind } : x)) })} /></View>
              <Button kind="ghost" size="sm" icon="x" label="Remove fact" onPress={() => set({ fields: s.fields.filter((_: any, k: number) => k !== i) })} />
            </View>
            <Field label={undefined} name="What to look for" value={f.description ?? ""} onChangeText={(description) => set({ fields: s.fields.map((x: any, k: number) => (k === i ? { ...x, description } : x)) })} placeholder="What to look for (optional), for example the total in dollars" />
            </View>
          ))}
          <View className="flex-row"><Button kind="ghost" size="sm" icon="plus" label="Add a fact" onPress={() => set({ fields: [...(s.fields ?? []), { name: "", kind: "text" }] })} /></View>
        </>
      ) : null}
      {s.kind === "connection" ? (
        <>
          <Select label="Connection" value={s.connection ?? ""} options={pick(options.connections ?? [])} placeholder={(options.connections ?? []).length ? "Choose a connection" : "No connections yet"} onChange={(connection) => set({ connection })} />
          <Field label="Operation" value={s.operation ?? ""} onChangeText={(operation) => set({ operation })} placeholder="For example contacts.list, or request" help="The name the connection gives the operation." />
          <Rows rows={s.fields ?? []} onChange={(fields) => set({ fields })} draft={draft} stepId={s.id} options={options} fieldLabel="Input" title="What to give it" help="The key stays in the Vault. A change a connection makes is held for your yes." />
          <NewConnection options={options} onAdded={(connection) => set({ connection })} />
        </>
      ) : null}
      {s.kind === "action" ? (
        <>
          <Field label="Search the actions" value={s.actionSearch ?? ""} onChangeText={(actionSearch) => set({ actionSearch })} placeholder="For example document, task, mail" />
          <Select label="Action" value={s.action ?? ""} options={[...(s.action && !(options.actions ?? []).some((a) => a.action === s.action) ? [[s.action, s.action] as [string, string]] : []), ...actionChoices(options, s.actionSearch ?? "")]} placeholder={(options.actions ?? []).length ? "Choose an action" : "No actions to choose from"} onChange={(action) => { const p = actionPick(options, action); set({ action, resource: p.resource, fields: p.fields }); }} />
          {s.action ? <Text size="caption" tone="label">{`Acts on ${s.resource ?? ""}. It runs with the access of the person who approved the Flow.`}</Text> : null}
          {s.action ? <Rows rows={s.fields ?? []} onChange={(fields) => set({ fields })} draft={draft} stepId={s.id} options={options} fieldLabel="Input" title="What to give it" help="The name the action expects, and the value to hand over." /> : null}
        </>
      ) : null}
      {s.kind === "subflow" ? (
        <>
          <Select label="The flow to run" value={s.flow ?? ""} options={pick(options.flows ?? [])} placeholder="Choose a flow" onChange={(flow) => set({ flow })} />
          <Rows rows={s.fields ?? []} onChange={(fields) => set({ fields })} draft={draft} stepId={s.id} options={options} fieldLabel="Hand over" title="Hand over" help="What the other flow starts with. It must be switched on in this space." />
        </>
      ) : null}
      {["email", "sms", "web", "action", "connection", "document", "project"].includes(s.kind) ? <View className="gap-s1"><Switch label="Always ask a person before this goes out" on={s.approve === true} onChange={(on) => set({ approve: on ? true : undefined })} /><Text size="caption" tone="label">Off unless you turn it on: once the Flow is switched on, this step runs without asking.</Text></View> : null}
      <FailurePanel s={s} setStep={set} inHandler={inHandler} />
    </>
  );
}

/** What the sending service cannot do yet: shown, switched off, never faked. */
function ComingNext() {
  return (
    <View className="gap-s2">
      {["CC", "BCC", "Attachments"].map((x) => <Field key={x} label={x} name={x} value="" disabled placeholder="Coming next" />)}
      <Text size="caption" tone="label">CC, BCC and attachments (a file from Files, or one an earlier step made) need the sending service to carry them. They are next.</Text>
    </View>
  );
}

/** A new connection, inline: a name, one https address, how the key is sent and which Vault item holds it. It is saved as a Connection in the Vault (connectors.connection.create); the key itself is never typed here. */
function NewConnection({ options, onAdded }: { options: Options; onAdded: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ label: "", base_url: "https://", how: "bearer", header: "", item: "", check: "/" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!options.addConnection) return null;
  if (!open) return <View className="flex-row"><Button kind="ghost" size="sm" icon="plus" label="New connection" onPress={() => setOpen(true)} /></View>;
  const ok = f.label.trim() && /^https:\/\/[^/\s]+$/.test(f.base_url.trim()) && f.item;
  const save = async () => {
    setBusy(true); setErr("");
    try { const c = await options.addConnection!({ ...f, label: f.label.trim(), base_url: f.base_url.trim() }); onAdded(c.name); setOpen(false); }
    catch (e) { setErr(e instanceof Error ? e.message : "That did not save."); } finally { setBusy(false); }
  };
  return (
    <Card>
      <View className="gap-s2">
        <Text strong>New connection</Text>
        <Field label="Name" value={f.label} onChangeText={(label) => setF({ ...f, label })} placeholder="For example CRM" />
        <Field label="Address (one https host)" value={f.base_url} onChangeText={(base_url) => setF({ ...f, base_url })} placeholder="https://api.example.com" kind="url" />
        <Select label="How the key is sent" value={f.how} options={[["bearer", "As a bearer token"], ["header", "In a header"], ["basic", "As a basic login"], ["query", "In the address"]]} onChange={(how) => setF({ ...f, how })} />
        {f.how === "header" || f.how === "query" ? <Field label={f.how === "header" ? "Header name" : "Parameter name"} value={f.header} onChangeText={(header) => setF({ ...f, header })} placeholder="For example X-Api-Key" /> : null}
        <Select label="The key (an item in the Vault)" value={f.item} options={pick(options.vaultItems ?? [])} placeholder={(options.vaultItems ?? []).length ? "Choose a Vault item" : "No items in the Vault yet"} onChange={(item) => setF({ ...f, item })} />
        <Field label="A path to check it works" value={f.check} onChangeText={(check) => setF({ ...f, check })} placeholder="/" />
        <Text size="caption" tone="label">Add the key to the Vault first (Settings, Vault). It is never typed or shown here.</Text>
        {err ? <Text size="caption" tone="err">{err}</Text> : null}
        <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Save the connection" disabled={!ok} loading={busy} onPress={save} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setOpen(false)} /></View>
      </View>
    </Card>
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

/** What a started project hands out, from the playbook's own first stage: it shows that the playbook, not the Flow, assigns the tasks. */
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
