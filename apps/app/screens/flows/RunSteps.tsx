// A run read step by step: each step in the Flow's order with where it stands, how long it took, what went in and came out (a sealed value is only its placeholder), and the error in plain words.
import { useState } from "react";
import { View } from "react-native";
import { Button, Chip, Divider, Row, Text } from "@vyre/ui";
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

function Detail({ r, name, thread, open }: { r: StepRow; name: (id: string) => string; thread?: string; open?: (thread: string) => void }) {
  if (!r.inputs.length && !r.outputs.length && !r.error && !r.wakes && !r.by && !r.tries.length) return <Text size="secondary" tone="muted">Nothing more to show for this step.</Text>;
  return (
    <View className="gap-s2 pb-s2">
      {r.error ? <Text size="secondary" tone="err">{r.error}</Text> : null}
      {r.wakes ? <Text size="secondary" tone="muted">{r.wakes}</Text> : null}
      {r.by ? <Text size="secondary" tone="muted">{`${r.tone === "accent" ? "Waiting on" : "Answered by"} ${name(r.by)}`}</Text> : null}
      {r.tries.map((t) => <Text key={t} size="secondary" tone="muted">{t}</Text>)}
      {thread && open ? <View className="self-start"><Button kind="secondary" size="sm" label="Open the agent's work" onPress={() => open(thread)} /></View> : null}
      <Pairs label="Went in" items={r.inputs} />
      <Pairs label="Came out" items={r.outputs} />
    </View>
  );
}

const DOT: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", err: "bg-err", accent: "bg-accent", plain: "bg-text-3" };

export function RunSteps({ painted, steps, max, fmt, name = (id) => id, rail, threads, openThread }: { threads?: Record<string, string>; openThread?: (thread: string) => void; painted: PaintedNode[]; steps: Record<string, Ledger> | undefined; max?: Record<string, number>; fmt: (ms: number) => string; name?: (id: string) => string; rail?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = stepRows(painted, steps, fmt, max);
  return (
    <>
      {rows.map((r, i) => (
        <View key={r.key}>{i ? <Divider /> : null}
          <Row dense lead={rail ? <View className={`h-[10px] w-[10px] rounded-full ${DOT[r.tone]}`} /> : undefined} selected={open === r.key} onPress={() => setOpen(open === r.key ? null : r.key)} title={r.title} sub={[r.took, r.wakes].filter(Boolean).join(" · ") || undefined} end={<Chip tone={r.tone}>{r.status}</Chip>} />
          {open === r.key ? <View className="px-s4"><Detail r={r} name={name} thread={r.task ? threads?.[r.task] : undefined} open={openThread} /></View> : null}
        </View>
      ))}
    </>
  );
}
