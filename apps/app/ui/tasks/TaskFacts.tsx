import { View } from "react-native";
import { Card } from "../components/Card";
import { Chip } from "../components/Chip";
import { Text } from "../components/Text";
import { ActorMark } from "./ActorMark";
import { who, type World } from "./model";

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <View className="min-w-0 gap-s1 border-t border-edge py-s3 sm:flex-row">
    <Text size="caption" strong tone="label" className="sm:min-w-menu">{label}</Text>
    <View className="min-w-0 flex-1 gap-s1">{children}</View>
  </View>
);

const Actor = ({ world, id, meta }: { world: World; id: string; meta?: string }) => {
  const a = who(world, id);
  return (
    <View className="flex-row items-center gap-s2">
      <ActorMark who={a} size="sm" />
      <View className="min-w-0 flex-1"><Text strong>{a?.name || id}</Text>{meta ? <Text size="caption" tone="label">{meta}</Text> : null}</View>
    </View>
  );
};

type Facts = { doer: { id: string; meta: string }; checker: { id: string; meta?: string } | null; output: { label: string; target: string; doneWhen: string }; how: string; inputs: string[] };

/** Doer, Checker, Output (with what done means), How, Inputs: the facts of a task as rows in one card. `how` replaces the plain How line (the task page's segmented control). */
export function TaskFacts({ world, facts, how }: { world: World; facts: Facts; how?: React.ReactNode }) {
  return (
    <Card flush className="px-s4">
      <Fact label="Doer"><Actor world={world} id={facts.doer.id} meta={facts.doer.meta} /></Fact>
      <Fact label="Checker">{facts.checker ? <Actor world={world} id={facts.checker.id} meta={facts.checker.meta} /> : <Text tone="label">None</Text>}</Fact>
      <Fact label="Output"><Text><Text strong>{facts.output.label}</Text>{facts.output.target ? `: ${facts.output.target}` : ""}</Text><Text size="caption" tone="label">Done when {facts.output.doneWhen}</Text></Fact>
      <Fact label="How">{how ?? <Text tone="muted">{facts.how}</Text>}</Fact>
      <Fact label="Inputs">{facts.inputs.length ? <View className="flex-row flex-wrap gap-s2">{facts.inputs.map((t) => <Chip key={t}>{t}</Chip>)}</View> : <Text tone="label">None</Text>}</Fact>
    </Card>
  );
}

/** The draft, with its one sentence ("Intake drafted it from Welcome, using Research's notes. 3 sources."). */
export function DraftBlock({ draft }: { draft: { subject?: string; body: string; line: string } }) {
  return (
    <View className="gap-s2 rounded-card border border-edge bg-surface-3 p-s4">
      {draft.subject ? <Text strong>{draft.subject}</Text> : null}
      <Text>{draft.body}</Text>
      <Text size="caption" tone="label">{draft.line}</Text>
    </View>
  );
}
