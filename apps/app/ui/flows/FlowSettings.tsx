import { View } from "react-native";
import { Card } from "../components/Card";
import { Field } from "../components/Field";
import { Text } from "../components/Text";
import { FormulaBox } from "./FormulaBox";
import { flowSettings, setFlowSetting } from "./logic.js";
import type { Draft } from "./logic.js";

/** The settings that belong to the whole Flow, not to a step. Each one is optional: left empty, the engine's own default applies. */
export function FlowSettings({ draft, onChange, readOnly }: { draft: Draft; onChange: (d: Draft) => void; readOnly?: boolean }) {
  const v = flowSettings(draft);
  const set = (key: "description" | "concurrency" | "lock" | "stuckMinutes") => (value: string) => onChange(setFlowSetting(draft, key, value));
  return (
    <Card>
      <View className="gap-s3">
        <Text strong>Settings for the whole Flow</Text>
        <Field label="Description (optional)" value={v.description} onChangeText={set("description")} disabled={readOnly} placeholder="What this Flow is for" />
        <Field label="Runs at the same time (optional)" kind="number" value={v.concurrency} onChangeText={set("concurrency")} disabled={readOnly} placeholder="No limit set" help="1 to 32. A new run waits while this many are going." />
        <FormulaBox label="Keep runs apart by (optional, a formula)" value={v.lock} onChange={set("lock")} placeholder="For example trigger.after.id" />
        <Text size="caption" tone="label">Two runs that give the same answer never go at the same moment, for example one at a time for each record.</Text>
        <Field label="Call a run stuck after (minutes, optional)" kind="number" value={v.stuckMinutes} onChangeText={set("stuckMinutes")} disabled={readOnly} placeholder="The default" help="From 1 minute to 1440 (24 hours)." />
      </View>
    </Card>
  );
}
