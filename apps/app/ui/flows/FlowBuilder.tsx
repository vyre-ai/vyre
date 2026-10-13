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
import { StepEditor } from "./StepEditor";
import { StepPalette } from "./StepPalette";
import { ContextBox } from "./ContextBox";
import { EVENT_CHOICES, EVERY_CHOICES, TIMED, TRIGGERS, choiceOf, flowSentence, isRecordTrigger, newStep, stepProblem, stepSummary, triggerOf, triggerPhrase } from "./logic.js";
import { addTo, canMove, flat, laneSteps, lanesOf, mapStep, moveDeep, removeDeep } from "./tree.js";
import type { Draft, DraftStep, Options } from "./logic.js";
import type { LaneRef } from "./tree.js";

export type { Draft, DraftStep, Options };

const pick = (list: { name: string; label: string }[]): [string, string][] => list.map((x) => [x.name, x.label]);

/**
 * The Flow builder: a Flow read as a sentence. Across the top the whole Flow in one line ("When a record is created in RefundRequests, create a RefundRequests record, then hand it to the
 * Refunds agent."), under it the trigger ("When") and the steps in order ("Then"), each a closed card that says what it does and opens to its settings, and "Add a step" with the palette of
 * what a Flow can do. It edits a draft; `toDefinition` writes the stored Flow. A step the engine cannot do yet is shown and marked Coming. See docs/design/system/components/flow-builder.md.
 */
export function FlowBuilder({ draft, onChange, options, readOnly, accessNote }: { draft: Draft; onChange: (d: Draft) => void; options: Options; readOnly?: boolean; /** What is true about access on this box; the default is the approver rule. */ accessNote?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setStep = (id: string, patch: Partial<DraftStep>) => set({ steps: mapStep(draft.steps, id, (s) => ({ ...s, ...patch })) });
  const ctx: Ctx = { draft, options, readOnly, open, toggle: (id) => setOpen(open === id ? null : id), adding, setAdding, change: (steps) => set({ steps }), setStep, setOpen };
  const t = draft.trigger;
  const setTrig = (patch: Record<string, unknown>) => set({ trigger: { ...t, ...patch } });

  return (
    <View className="gap-s4">
      <Card hero>
        <View className="gap-s2">
          <Text size="caption" tone="label" strong>This Flow, in one sentence</Text>
          <Text size="page" strong>{flowSentence(draft, options)}</Text>
        </View>
      </Card>

      <Text size="caption" tone="label">{accessNote ?? "Each step can only read and write what the person who added it can reach. It runs with the access of the person who approved it, and pauses if that is lost."}</Text>
      <View>
        <StepCard lead="When" icon={(triggerOf(t.kind)?.icon ?? "bolt") as any} title={t.kind === "advanced" ? "Another way to start" : triggerOf(t.kind)?.label ?? "Choose what starts it"} summary={`When ${triggerPhrase(t, options)}`} open={open === "trigger"} onToggle={() => ctx.toggle("trigger")}
          last={false}>
          {t.kind === "advanced" ? <Text tone="muted">This Flow starts in a way the builder cannot show yet. It is kept as it is.</Text> : null}
          {t.kind === "advanced" ? null : <Select label="What starts the Flow" value={t.kind} options={TRIGGERS.map((x) => [x.id, x.label] as [string, string])} onChange={(kind) => setTrig({ kind })} />}
          {isRecordTrigger(t) || t.kind === "removed" ? <Select label="Object" value={t.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => setTrig({ type })} /> : null}
          {t.kind === "changed" && t.type ? <Select label="Only when this field changes" value={t.field ?? ""} options={[["", "Any field"], ...((options.types.find((x) => x.name === t.type)?.fields ?? []).map((f) => [f.name, f.label] as [string, string]))]} onChange={(field) => setTrig({ field })} /> : null}
          {t.kind === "changed" ? <Select label="If the record changes again" value={t.again ?? "replace"} options={[["replace", "Start over"], ["keep", "Keep both"]]} onChange={(again) => setTrig({ again })} /> : null}
          {t.kind === "stage" ? <Field label="Stage" value={t.stage ?? ""} onChangeText={(stage) => setTrig({ stage })} placeholder="For example Drafting" /> : null}
          {t.kind === "form" ? <Field label="Form name" value={t.path ?? ""} onChangeText={(path) => setTrig({ path })} placeholder="For example contact" help="Your site's form posts to this name." /> : null}
          {t.kind === "schedule" ? <Select label="How often" value={t.every ?? ""} options={EVERY_CHOICES.map((x) => [x, x] as [string, string])} placeholder="Choose" onChange={(every) => setTrig({ every })} /> : null}
          {t.kind === "schedule" && TIMED.has(t.every ?? "") ? <Field label="At what time" value={t.at ?? "09:00"} onChangeText={(at) => setTrig({ at })} placeholder="09:00" help="24-hour time in your space's time zone, such as 09:00 or 17:30." /> : null}
          {t.kind === "event" ? <Select label="What happens" value={t.event ?? ""} options={EVENT_CHOICES} placeholder="Choose" onChange={(event) => setTrig({ event })} /> : null}
          {t.kind === "watcher" ? <Field label="Watcher name" value={t.watcher ?? ""} onChangeText={(watcher) => setTrig({ watcher })} placeholder="For example new-mail" help="The name of a watcher in your space: a mailbox or a folder it watches. The steps start with the new item." /> : null}
          {t.kind === "signup" ? <Text tone="muted">Runs when someone signs up through your sign-up form. The person's name and email are what the steps start with.</Text> : null}
        </StepCard>

        <Lane lane={{ parent: null, key: "" }} steps={draft.steps} ctx={ctx} />
      </View>
    </View>
  );
}

type Ctx = { draft: Draft; options: Options; readOnly?: boolean; open: string | null; toggle: (id: string) => void; adding: string | null; setAdding: (k: string | null) => void; change: (steps: DraftStep[]) => void; setStep: (id: string, patch: Partial<DraftStep>) => void; setOpen: (id: string | null) => void };

const laneKey = (l: LaneRef) => `${l.parent ?? "top"}/${l.key}`;

/** One lane of steps: the top of the Flow, or the Then, Else, For each or Side by side lane of a step. Each lane has its own Add a step. */
function Lane({ lane, steps, ctx }: { lane: LaneRef; steps: DraftStep[]; ctx: Ctx }) {
  const { draft, options, readOnly, adding, setAdding, change, setOpen } = ctx;
  const nested = lane.parent !== null;
  return (
    <View>
      {steps.map((s) => <Node key={s.id} s={s} ctx={ctx} />)}
      {readOnly ? null : (
        <View className="flex-row gap-s3">
          <View className="items-center"><IconTile size={nested ? 32 : 40} name="plus" /></View>
          <View className="min-w-0 flex-1 gap-s3 pb-s3">
            {adding === laneKey(lane) ? (
              <StepPalette onCancel={() => setAdding(null)} onPick={(kind) => { const st = newStep(kind, draft, options); change(addTo(draft.steps, lane, st)); setOpen(st.id); setAdding(null); }} />
            ) : <View className="flex-row"><Button kind="secondary" size={nested ? "sm" : "md"} icon="plus" label={steps.length ? "Add a step" : nested ? "Add a step here" : "Add the first step"} onPress={() => setAdding(laneKey(lane))} /></View>}
          </View>
        </View>
      )}
    </View>
  );
}

/** A step: its card, and under it the lanes it holds (an If has Then and Else), indented. */
function Node({ s, ctx }: { s: DraftStep; ctx: Ctx }) {
  const { draft, options, readOnly, open, toggle, change, setStep, setOpen } = ctx;
  const all = flat(draft.steps);
  const n = all.findIndex((x) => x.id === s.id) + 1;
  const c = choiceOf(s.kind);
  const lanes = lanesOf(s);
  const mv = canMove(draft.steps, s.id);
  return (
    <View>
      <StepCard lead={`Step ${n}`} icon={(c?.icon ?? "flows") as any} title={c?.label ?? "Advanced step"} summary={stepSummary(s, options, draft)} problem={stepProblem(s, options)} open={open === s.id} onToggle={() => toggle(s.id)} last={false}
        onUp={!readOnly && mv.up ? () => change(moveDeep(draft.steps, s.id, -1)) : undefined} onDown={!readOnly && mv.down ? () => change(moveDeep(draft.steps, s.id, 1)) : undefined}
        onRemove={readOnly ? undefined : () => { change(removeDeep(draft.steps, s.id)); setOpen(null); }}>
        <StepEditor s={s} setStep={setStep} draft={draft} options={options} />
      </StepCard>
      {lanes.map((l) => (
        <View key={l.key} className="ml-s6 gap-s1 border-l-2 border-edge pl-s3">
          <View className="flex-row items-center gap-s2 pb-s1"><Chip tone={l.key === "else" ? "warn" : "accent"}>{l.label}</Chip>{s.kind === "decide" && l.key === "then" ? <Text size="caption" tone="label">when the condition holds</Text> : s.kind === "decide" ? <Text size="caption" tone="label">when it does not</Text> : null}</View>
          <Lane lane={{ parent: s.id, key: l.key }} steps={laneSteps(s, l.key)} ctx={ctx} />
        </View>
      ))}
      {s.kind === "parallel" && !readOnly ? (
        <View className="ml-s6 flex-row gap-s2 pb-s3">
          <Button kind="ghost" size="sm" icon="plus" label="Add a side" onPress={() => change(mapStep(draft.steps, s.id, (p) => ({ ...p, lanes: [...(p.lanes ?? []), { steps: [] }] })))} />
          {(s.lanes ?? []).length > 2 ? <Button kind="ghost" size="sm" icon="minus" label="Remove the last side" onPress={() => change(mapStep(draft.steps, s.id, (p) => ({ ...p, lanes: p.lanes.slice(0, -1) })))} /> : null}
        </View>
      ) : null}
    </View>
  );
}
