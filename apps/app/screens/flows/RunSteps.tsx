// A run read step by step: each step in the Flow's order with where it stands, how long it took, what went in and came out (a sealed value is only its placeholder), and the error in plain words.
import { useState } from "react";
import { View } from "react-native";
import { Chip, Divider, Row, Text } from "@vyre/ui";
import { stepRows, type Ledger, type PaintedNode, type StepRow } from "./run-model";

function Pairs({ label, items }: { label: string; items: [string, string][] }) {
  if (!items.length) return null;
  return (
    <View className="gap-s1">
      <Text size="caption" tone="label">{label}</Text>
      {items.map(([k, v]) => <View key={k} className="flex-row gap-s2"><Text size="secondary" tone="muted" className="w-[120px]">{k}</Text><Text size="secondary" className="min-w-0 flex-1">{v}</Text></View>)}
    </View>
  );
}

function Detail({ r }: { r: StepRow }) {
  if (!r.inputs.length && !r.outputs.length && !r.error && !r.wakes) return <Text size="secondary" tone="muted">Nothing more to show for this step.</Text>;
  return (
    <View className="gap-s2 pb-s2">
      {r.error ? <Text size="secondary" tone="err">{r.error}</Text> : null}
      {r.wakes ? <Text size="secondary" tone="muted">{r.wakes}</Text> : null}
      <Pairs label="Went in" items={r.inputs} />
      <Pairs label="Came out" items={r.outputs} />
    </View>
  );
}

export function RunSteps({ painted, steps, max, fmt }: { painted: PaintedNode[]; steps: Record<string, Ledger> | undefined; max?: Record<string, number>; fmt: (ms: number) => string }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = stepRows(painted, steps, fmt, max);
  return (
    <>
      {rows.map((r, i) => (
        <View key={r.key}>{i ? <Divider /> : null}
          <Row dense selected={open === r.key} onPress={() => setOpen(open === r.key ? null : r.key)} title={r.title} sub={[r.took, r.wakes].filter(Boolean).join(" · ") || undefined} end={<Chip tone={r.tone}>{r.status}</Chip>} />
          {open === r.key ? <View className="px-s4"><Detail r={r} /></View> : null}
        </View>
      ))}
    </>
  );
}
