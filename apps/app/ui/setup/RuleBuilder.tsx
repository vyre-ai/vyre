import { View } from "react-native";
import { Chip } from "../components/Chip";
import { Segmented } from "../components/Segmented";
import { Select } from "../components/Select";
import { Text } from "../components/Text";
import { buildRule, ruleWords } from "./logic.js";
import type { FieldRef } from "./types";

export type Rule = { field: string; op: "is" | "is_not" | "filled"; value?: string };

/** "Only when Plan is Trust": pick a field, how it compares, and a value. The result is written in the Expression language the type stores, and read back in words. */
export function RuleBuilder({ title, fields, rule, onChange }: { title: string; fields: FieldRef[]; rule: Rule | null; onChange: (r: Rule | null, expr: string) => void }) {
  const f = fields.find((x) => x.name === rule?.field);
  const set = (r: Rule | null) => onChange(r, r ? buildRule(r) : "");
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">{title}</Text>
      {rule ? (
        <>
          <Select label="Field" value={rule.field} options={fields.map((x) => [x.name, x.label] as [string, string])} onChange={(v) => set({ field: v, op: "is", value: "" })} />
          <Segmented<Rule["op"]> label="Compare" value={rule.op} onChange={(op) => set({ ...rule, op })} options={[["is", "is"], ["is_not", "is not"], ["filled", "is filled in"]]} />
          {rule.op !== "filled" ? (
            f?.options?.length ? <View className="flex-row flex-wrap gap-s2">{f.options.map((o) => <Chip key={o} selected={rule.value === o} onPress={() => set({ ...rule, value: o })}>{o}</Chip>)}</View> : null
          ) : null}
          {buildRule(rule) ? <Text tone="muted">{ruleWords(rule, f?.label ?? rule.field)}</Text> : <Text size="caption" tone="label">Pick a value to finish the rule.</Text>}
          <View className="flex-row"><Chip onPress={() => set(null)} icon="x">Remove the rule</Chip></View>
        </>
      ) : (
        <View className="flex-row"><Chip icon="plus" onPress={() => set({ field: fields[0]?.name ?? "", op: "is", value: "" })}>Add a rule</Chip></View>
      )}
    </View>
  );
}
