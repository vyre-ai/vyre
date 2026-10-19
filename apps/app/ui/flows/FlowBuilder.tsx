import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Chip } from "../components/Chip";
import { IconTile } from "../components/IconTile";
import { Row } from "../components/Row";
import { Switch } from "../components/Switch";
import { Text } from "../components/Text";
import { StepCard } from "./StepCard";
import { TriggerFields } from "./TriggerFields";
import { FlowSettings } from "./FlowSettings";
import { StepEditor } from "./StepEditor";
import { StepPalette } from "./StepPalette";
import { ContextBox } from "./ContextBox";
import { choiceOf, flowSentence, newStep, policyWords, stepProblem, stepSummary, triggerOf, triggerPhrase } from "./logic.js";
import { canTurnOff } from "./failure.js";
import { useUiTheme } from "../theme";
import { addTo, canMove, duplicateDeep, flat, laneSteps, lanesOf, mapStep, moveDeep, removeDeep } from "./tree.js";
import type { Draft, DraftStep, Options } from "./logic.js";
import type { LaneRef } from "./tree.js";

export type { Draft, DraftStep, Options };

/**
 * The Flow builder: a Flow read as a sentence. Across the top the whole Flow in one line ("When a record is created in RefundRequests, create a RefundRequests record, then hand it to the
 * Refunds agent."), under it the trigger ("When") and the steps in order ("Then"), each a closed card that says what it does and opens to its settings, and "Add a step" with the palette of
 * what a Flow can do. It edits a draft; `toDefinition` writes the stored Flow. A step the engine cannot do yet is shown and marked Coming. See docs/design/system/components/flow-builder.md.
 */
export function FlowBuilder({ draft, onChange, options, readOnly, accessNote, onTestStep, initialOpen }: { /** A step (or "trigger") open when the page first draws; the sample-world shots use it. */ initialOpen?: string; /** Try one step with nothing changed or sent (flows.step.test): given the step id and the Flow as drawn, the lines to show; absent where a Flow cannot be tried. */ onTestStep?: (stepId: string, draft: Draft) => Promise<TestShown>; draft: Draft; onChange: (d: Draft) => void; options: Options; readOnly?: boolean; /** What is true about access on this box; the default is the approver rule. */ accessNote?: string }) {
  const [open, setOpen] = useState<string | null>(initialOpen ?? null);
  const [adding, setAdding] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setStep = (id: string, patch: Partial<DraftStep>) => {
    const f = (s: DraftStep) => ({ ...s, ...patch });
    set({ steps: mapStep(draft.steps, id, f), ...(draft.onFailure ? { onFailure: mapStep(draft.onFailure, id, f) } : {}) });
  };
  const { phone } = useUiTheme();
  const ctx: Ctx = { onTestStep, docked: !phone, draft, options, readOnly, open, toggle: (id) => setOpen(open === id ? null : id), adding, setAdding, change: (root, steps) => set(root === "steps" ? { steps } : { onFailure: steps }), setStep, setOpen };
  const docked = !phone;
  const openStep = open && open !== "trigger" ? flat([...draft.steps, ...(draft.onFailure ?? [])]).find((x) => x.id === open) ?? null : null;
  const openRoot: Root = openStep && flat(draft.steps).some((x) => x.id === openStep.id) ? "steps" : "onFailure";
  const t = draft.trigger;
  const setTrig = (patch: Record<string, unknown>) => set({ trigger: { ...t, ...patch } });
  const more = draft.moreTriggers ?? [];
  const setMore = (i: number, patch: Record<string, unknown>) => set({ moreTriggers: more.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  return (
    <View className="gap-s4">
      <Card hero>
        <View className="gap-s2">
          <Text size="caption" tone="label" strong>This Flow, in one sentence</Text>
          <Text size="page" strong>{flowSentence(draft, options)}</Text>
        </View>
      </Card>

      <View className={docked ? "flex-row items-start gap-s4" : "gap-s4"}>
      <View className="min-w-0 flex-1 gap-s4">
      <Text size="caption" tone="label">{accessNote ?? "Each step can only read and write what the person who added it can reach. It runs with the access of the person who approved it, and pauses if that is lost."}</Text>
      <View>
        <StepCard lead="When" icon={(triggerOf(t.kind)?.icon ?? "bolt") as any} title={more.length ? `${more.length + 1} ways to start` : t.kind === "advanced" ? "Another way to start" : triggerOf(t.kind)?.label ?? "Choose what starts it"} summary={`When ${[t, ...more].map((x) => triggerPhrase(x, options)).join(", or when ")}`} open={open === "trigger"} onToggle={() => ctx.toggle("trigger")}
          last={false}>
          {more.length ? <Text size="caption" tone="label" strong>Starts it, trigger 1</Text> : null}
          <TriggerFields t={t} setTrig={setTrig} options={options} />
          {more.map((x, i) => (
            <View key={i} className="gap-s3 border-t border-edge pt-s3">
              <View className="flex-row items-center gap-s2"><Chip tone="accent">or</Chip><Text size="caption" tone="label" strong className="flex-1">{`Trigger ${i + 2}`}</Text>{readOnly ? null : <Button kind="ghost" size="sm" icon="x" label="Remove" onPress={() => set({ moreTriggers: more.filter((_, j) => j !== i) })} />}</View>
              <TriggerFields t={x} setTrig={(patch) => setMore(i, patch)} options={options} />
            </View>
          ))}
          {readOnly || more.length >= 7 ? null : <View className="flex-row"><Button kind="secondary" size="sm" icon="plus" label="Add trigger" onPress={() => set({ moreTriggers: [...more, { kind: "created", type: "" }] })} /></View>}
        </StepCard>

        <Lane lane={{ parent: null, key: "" }} steps={draft.steps} root="steps" ctx={ctx} />
      </View>

      <FlowSettings draft={draft} onChange={onChange} readOnly={readOnly} />

      {readOnly && !(draft.onFailure ?? []).length ? null : (
        <View className="gap-s2">
          <View className="flex-row items-center gap-s2"><Chip tone="warn">If the run fails</Chip></View>
          <Text size="caption" tone="label">These steps run once, before the run is marked as failed. They can read what went wrong as {"{error.message}"}, {"{error.code}"} and {"{error.step}"}.</Text>
          <Lane lane={{ parent: null, key: "" }} steps={draft.onFailure ?? []} root="onFailure" inHandler ctx={ctx} />
        </View>
      )}
      </View>
      {docked && openStep ? <StepPanel s={openStep} ctx={ctx} root={openRoot} inHandler={openRoot === "onFailure"} /> : null}
      </View>
    </View>
  );
}

/** What a step test said: the input it was given, what it would give back, and what it would send or do, with a line that nothing happened. */
function TestResult({ r }: { r: TestShown }) {
  if ("problem" in r) return <Text size="caption" tone="warn">{r.problem}</Text>;
  const rows = (label: string, list: [string, string][]) => (list.length ? <View className="gap-s1"><Text size="caption" tone="label">{label}</Text>{list.map(([k, v]) => <View key={k} className="flex-row gap-s2"><Text size="secondary" tone="muted" className="w-[110px]">{k}</Text><Text size="secondary" className="min-w-0 flex-1">{v}</Text></View>)}</View> : null);
  return (
    <View className="gap-s2">
      {r.error ? <Text size="secondary" tone="err">{r.error}</Text> : null}
      {rows("Went in", r.input)}
      {rows("Would come out", r.output)}
      {r.effects.length ? <View className="gap-s1"><Text size="caption" tone="label">Would do</Text>{r.effects.map((e, i) => <Text key={i} size="secondary">{e}</Text>)}</View> : null}
      <Text size="caption" tone="label">{r.note}</Text>
    </View>
  );
}

/** The open step's settings, docked beside the steps so the Flow stays in view while it is edited. */
function StepPanel({ s, ctx, root, inHandler }: { s: DraftStep; ctx: Ctx; root: Root; inHandler?: boolean }) {
  const { draft, options, readOnly, change, setStep, setOpen } = ctx;
  const mine = rootSteps(draft, root);
  const all = flat([...draft.steps, ...(draft.onFailure ?? [])]);
  const mv = canMove(mine, s.id);
  const c = choiceOf(s.kind);
  const [tried, setTried] = useState<TestShown | null>(null);
  const [trying, setTrying] = useState(false);
  useEffect(() => { setTried(null); }, [s.id]);
  return (
    <View className="w-[380px] flex-none gap-s3 rounded-card border border-edge-strong bg-surface-2 p-s4">
      <View className="flex-row items-center gap-s2">
        <Text strong numberOfLines={1} className="min-w-0 flex-1">{c?.label ?? "Advanced step"}</Text>
        <Button kind="ghost" size="sm" icon="x" label="Close" onPress={() => setOpen(null)} />
      </View>
      <StepEditor s={s} setStep={setStep} draft={draft} options={options} inHandler={inHandler} />
      {ctx.onTestStep ? (
        <View className="gap-s2 border-t border-edge pt-s3">
          <View className="self-start"><Button kind="secondary" size="sm" icon="play" label={trying ? "Trying" : "Test this step"} disabled={trying} onPress={async () => { setTrying(true); try { setTried(await ctx.onTestStep!(s.id, draft)); } finally { setTrying(false); } }} /></View>
          {tried ? <TestResult r={tried} /> : null}
        </View>
      ) : null}
      {readOnly ? null : (
        <View className="flex-row flex-wrap items-center gap-s2 border-t border-edge pt-s3">
          {mv.up ? <Button kind="ghost" size="sm" icon="chevron-up" label="Move up" onPress={() => change(root, moveDeep(mine, s.id, -1))} /> : null}
          {mv.down ? <Button kind="ghost" size="sm" icon="chevron-down" label="Move down" onPress={() => change(root, moveDeep(mine, s.id, 1))} /> : null}
          <Button kind="ghost" size="sm" icon="copy" label="Duplicate" onPress={() => { const r = duplicateDeep(mine, s.id, all.map((x) => x.id)); change(root, r.steps); if (r.id) setOpen(r.id); }} />
          {canTurnOff(s.kind) ? <Button kind="ghost" size="sm" icon="eye-off" label={s.enabled === false ? "Turn on" : "Turn off"} onPress={() => setStep(s.id, { enabled: s.enabled === false ? undefined : false })} /> : null}
          <Button kind="ghost" size="sm" icon="trash" label="Remove step" onPress={() => { change(root, removeDeep(mine, s.id)); setOpen(null); }} />
        </View>
      )}
    </View>
  );
}

type Root = "steps" | "onFailure";
export type TestShown = { ok: boolean; error: string; input: [string, string][]; output: [string, string][]; effects: string[]; note: string } | { problem: string };
type Ctx = { onTestStep?: (stepId: string, draft: Draft) => Promise<TestShown>; docked?: boolean; draft: Draft; options: Options; readOnly?: boolean; open: string | null; toggle: (id: string) => void; adding: string | null; setAdding: (k: string | null) => void; change: (root: Root, steps: DraftStep[]) => void; setStep: (id: string, patch: Partial<DraftStep>) => void; setOpen: (id: string | null) => void };

const laneKey = (root: Root, l: LaneRef) => `${root}/${l.parent ?? "top"}/${l.key}`;
const rootSteps = (d: Draft, root: Root) => (root === "steps" ? d.steps : d.onFailure ?? []);

/** One lane of steps: the top of the Flow (or of its "If the run fails" steps), or the Then, Else, For each, Side by side or "If this fails" lane of a step. Each lane has its own Add a step. `inHandler`: the steps run only because something failed. */
function Lane({ lane, steps, ctx, root, inHandler }: { lane: LaneRef; steps: DraftStep[]; ctx: Ctx; root: Root; inHandler?: boolean }) {
  const { draft, options, readOnly, adding, setAdding, change, setOpen } = ctx;
  const nested = lane.parent !== null;
  return (
    <View>
      {steps.map((s) => <Node key={s.id} s={s} ctx={ctx} root={root} inHandler={inHandler} />)}
      {readOnly ? null : (
        <View className="flex-row gap-s3">
          <View className="items-center"><IconTile size={nested ? 32 : 40} name="plus" /></View>
          <View className="min-w-0 flex-1 gap-s3 pb-s3">
            {adding === laneKey(root, lane) ? (
              <StepPalette without={inHandler ? ["parallel"] : undefined} onCancel={() => setAdding(null)} onPick={(kind) => { const st = newStep(kind, draft, options); change(root, addTo(rootSteps(draft, root), lane, st)); setOpen(st.id); setAdding(null); }} />
            ) : <View className="flex-row"><Button kind="secondary" size={nested ? "sm" : "md"} icon="plus" label={steps.length ? "Add a step" : nested ? "Add a step here" : "Add the first step"} onPress={() => setAdding(laneKey(root, lane))} /></View>}
          </View>
        </View>
      )}
    </View>
  );
}

/** A step: its card, and under it the lanes it holds (an If has Then and Else, any step may have "If this fails"), indented. */
function Node({ s, ctx, root, inHandler }: { s: DraftStep; ctx: Ctx; root: Root; inHandler?: boolean }) {
  const { draft, options, readOnly, open, toggle, change, setStep, setOpen } = ctx;
  const mine = rootSteps(draft, root);
  const all = flat([...draft.steps, ...(draft.onFailure ?? [])]);
  const n = all.findIndex((x) => x.id === s.id) + 1;
  const c = choiceOf(s.kind);
  const lanes = lanesOf(s);
  const mv = canMove(mine, s.id);
  const { phone } = useUiTheme();
  const main = lanes.filter((l) => l.key !== "on_fail");
  const rest = lanes.filter((l) => l.key === "on_fail");
  const side = !phone && (s.kind === "decide" || s.kind === "parallel") && main.length >= 2;
  const laneView = (l: (typeof lanes)[number], wide: boolean) => (
    <View key={l.key} className={wide ? "w-[360px] flex-none gap-s1 rounded-card border border-edge bg-surface-2 p-s3" : "ml-s6 gap-s1 border-l-2 border-edge pl-s3"}>
          <View className="flex-row items-center gap-s2 pb-s1"><Chip tone={l.key === "else" || l.key === "on_fail" ? "warn" : "accent"}>{l.label}</Chip>{l.key === "on_fail" ? <Text size="caption" tone="label">{s.on_fail?.then === "continue" ? "when it fails, then the Flow carries on" : "when it fails, then the Flow stops"}</Text> : s.kind === "decide" && l.key === "then" ? <Text size="caption" tone="label">when the condition holds</Text> : s.kind === "decide" && l.key === "else" ? <Text size="caption" tone="label">when it does not</Text> : null}</View>
          <Lane lane={{ parent: s.id, key: l.key }} steps={laneSteps(s, l.key)} ctx={ctx} root={root} inHandler={inHandler || l.key === "on_fail"} />
        </View>
  );
  return (
    <View>
      <StepCard lead={`Step ${n}`} icon={(c?.icon ?? "flows") as any} title={c?.label ?? "Advanced step"} summary={`${stepSummary(s, options, draft)}${policyWords(s)}`} problem={stepProblem(s, options)} open={open === s.id} onToggle={() => toggle(s.id)} last={false}
        onUp={!readOnly && mv.up ? () => change(root, moveDeep(mine, s.id, -1)) : undefined} onDown={!readOnly && mv.down ? () => change(root, moveDeep(mine, s.id, 1)) : undefined}
        docked={ctx.docked}
        onDuplicate={readOnly ? undefined : () => { const r = duplicateDeep(mine, s.id, all.map((x) => x.id)); change(root, r.steps); if (r.id) setOpen(r.id); }}
        off={s.enabled === false} onToggleOff={readOnly || !canTurnOff(s.kind) ? undefined : () => setStep(s.id, { enabled: s.enabled === false ? undefined : false })}
        onRemove={readOnly ? undefined : () => { change(root, removeDeep(mine, s.id)); setOpen(null); }}>
        <StepEditor s={s} setStep={setStep} draft={draft} options={options} inHandler={inHandler} />
      </StepCard>
      {side ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={main.length > 2} className="ml-s6 flex-none grow-0" contentContainerStyle={{ gap: 12, paddingBottom: 12, alignItems: "flex-start" }}>
          {main.map((l) => laneView(l, true))}
        </ScrollView>
      ) : null}
      {(side ? rest : lanes).map((l) => laneView(l, false))}
      {s.kind === "parallel" && !readOnly ? (
        <View className="ml-s6 flex-row gap-s2 pb-s3">
          <Button kind="ghost" size="sm" icon="plus" label="Add a side" onPress={() => change(root, mapStep(mine, s.id, (p) => ({ ...p, lanes: [...(p.lanes ?? []), { steps: [] }] })))} />
          {(s.lanes ?? []).length > 2 ? <Button kind="ghost" size="sm" icon="minus" label="Remove the last side" onPress={() => change(root, mapStep(mine, s.id, (p) => ({ ...p, lanes: p.lanes.slice(0, -1) })))} /> : null}
        </View>
      ) : null}
    </View>
  );
}
