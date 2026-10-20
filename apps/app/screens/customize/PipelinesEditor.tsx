import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Chip, Divider, Field, SectionLabel, Text, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { askable, toggleLost, toggleNeed } from "./stage-rules.js";
import { COLOURS, addPipeline, addStageIn, chanceOf, colourInput, moveStageIn, patchStage, pipelinesInput, pipelinesOf, removeStageIn, stageColour } from "./pipelines.js";
import { plainError } from "../../src/real/error-note.js";

/**
 * The stages of a type: one or several pipelines, and for each stage its name, chance of closing (0 to 100), colour, the fields it needs and whether it counts as lost. Every change is one
 * records.pipeline.set (colours: records.type.update); the box refuses what is not allowed, and its sentence is what shows.
 */
export function PipelinesEditor({ def, reload }: { def: any; reload: () => void }) {
  const [on, setOn] = useState(0);
  const [names, setNames] = useState<Record<string, string>>({});
  const [chances, setChances] = useState<Record<string, string>>({});
  const pipelines = pipelinesOf(def);
  useEffect(() => { if (on >= pipelines.length) setOn(0); }, [pipelines.length, on]);
  const cur = pipelines[Math.min(on, pipelines.length - 1)];
  const p = Math.min(on, pipelines.length - 1);
  const put = (next: ReturnType<typeof pipelinesOf>) => callT("records.pipeline.set", pipelinesInput(def.name, next)).then((r) => { if (r.error) showToast(plainError(r.error, "That did not save.")); else { setNames({}); setChances({}); reload(); } });
  const colour = (stage: string, c: string) => void callT("records.type.update", colourInput(def, stage, c)).then((r) => { if (r.error) showToast(plainError(r.error, "That did not save.")); else reload(); });
  const rename = (i: number) => {
    const k = `${p}:${i}`, n = (names[k] ?? cur.stages[i].name).trim();
    if (!n || cur.stages.some((s, j) => j !== i && s.name.toLowerCase() === n.toLowerCase())) { showToast("A stage needs a name that no other stage has."); setNames({}); return; }
    void put(patchStage(pipelines, p, i, { name: n }));
  };
  return (
    <>
      <SectionLabel>{pipelines.length > 1 ? "Pipelines" : "Stages"}</SectionLabel>
      <View className="flex-row flex-wrap items-center gap-s2">
        {pipelines.length > 1 ? pipelines.map((x, i) => <Chip key={x.name} selected={i === p} onPress={() => setOn(i)}>{x.name}</Chip>) : null}
        <Button kind="ghost" size="sm" icon="plus" label="Add a pipeline" onPress={() => { void put(addPipeline(pipelines)).then(() => setOn(pipelines.length)); }} />
      </View>
      <Card flush>
        {cur.stages.map((s, i) => {
          const k = `${p}:${i}`, c = stageColour(def, s.name);
          return (
            <View key={s.name + i}>
              {i ? <Divider /> : null}
              <View className="gap-s2 p-s3">
                <Field label={`Stage ${i + 1}`} value={names[k] ?? s.name} onChangeText={(v) => setNames({ ...names, [k]: v })} />
                <Field label="Chance of closing, %" value={chances[k] ?? (typeof s.probability === "number" ? String(s.probability) : "")} placeholder="For example 40" onChangeText={(v) => setChances({ ...chances, [k]: v })} />
                <View className="flex-row flex-wrap gap-s2">
                  <Button kind="ghost" size="sm" label="Save name and chance" disabled={(names[k] ?? s.name) === s.name && (chances[k] ?? "") === ""} onPress={() => {
                    if ((names[k] ?? s.name) !== s.name) { rename(i); return; }
                    const v = chanceOf(chances[k] ?? ""); void put(patchStage(pipelines, p, i, { probability: v }));
                  }} />
                  <Button kind="ghost" size="sm" label="Move up" disabled={i === 0} onPress={() => void put(moveStageIn(pipelines, p, i, -1))} />
                  <Button kind="ghost" size="sm" label="Move down" disabled={i === cur.stages.length - 1} onPress={() => void put(moveStageIn(pipelines, p, i, 1))} />
                  <Button kind="ghost" size="sm" label="Remove" disabled={cur.stages.length < 2} onPress={() => void put(removeStageIn(pipelines, p, i))} />
                </View>
                <View className="gap-s1">
                  <Text size="caption" tone="label">Colour</Text>
                  <View className="flex-row flex-wrap gap-s1">{COLOURS.map((x) => <Chip key={x} selected={c === x} onPress={() => colour(s.name, x)}>{x}</Chip>)}</View>
                </View>
                <View className="gap-s1">
                  <Text size="caption" tone="label">{s.requires.length ? "Needs these before a record can enter it" : "Needs nothing to enter"}</Text>
                  <View className="flex-row flex-wrap gap-s1">
                    {askable(def).map((f: any) => <Chip key={f.name} selected={s.requires.includes(f.name)} onPress={() => void put(pipelines.map((x, a) => a === p ? { ...x, stages: toggleNeed(x.stages, i, f.name) } : x))}>{String(f.label ?? f.name)}</Chip>)}
                    <Chip selected={s.lost} onPress={() => void put(pipelines.map((x, a) => a === p ? { ...x, stages: toggleLost(x.stages, i) } : x))}>Counts as lost, asks why</Chip>
                  </View>
                </View>
              </View>
            </View>
          );
        })}
      </Card>
      <View className="flex-row"><Button size="sm" icon="plus" label="Add a stage" onPress={() => void put(addStageIn(pipelines, p))} /></View>
    </>
  );
}
