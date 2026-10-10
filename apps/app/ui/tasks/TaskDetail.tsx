import { View } from "react-native";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Segmented } from "../components/Segmented";
import { Text } from "../components/Text";
import { Section } from "./Section";
import { DraftBlock, TaskFacts } from "./TaskFacts";
import { briefOf, cardFor, draftOf, HOW_LABEL, recordTitle, stateTone, STATE_LABEL, taskFacts, type World } from "./model";

/**
 * One task, as a page (DESIGN-tasks.md): who does it (one doer, accountable), who checks it, what done looks like, how it is made and what it starts from.
 * A stuck task says why and offers Fix and Reassign; a drafted item shows the draft with its one sentence, and Send with Face ID and Edit.
 */
export function TaskDetail({ world, task, onAction, onHow, onOpenRecord }: {
  world: World; task: any; onAction: (id: string, input?: string) => void; onHow: (how: string) => void; onOpenRecord?: (urn: string) => void;
}) {
  const m = cardFor(world, task);
  const rec = world.records.get(task.record);
  const titles = new Map(world.tasks.map((t) => [t.id, t.title] as [string, string]));
  const draft = draftOf(world, task);
  const brief = briefOf(task);
  const showHow = ["sent", "draft", "note"].includes(task.output?.kind);
  const tpl = task.template ? world.records.get(task.template) : null;
  const acts = task.state !== "stuck" && m.reason ? m.actions.filter((a) => a.id !== "open" && a.id !== "save") : [];
  return (
    <View className="gap-s4">
      <View className="items-start gap-s2">
        <Text size="title" strong>{task.title}</Text>
        <View className="flex-row flex-wrap gap-s2">
          <Chip tone={stateTone(task.state) as never}>{STATE_LABEL[task.state]}</Chip>
        </View>
      </View>
      {task.state === "stuck" && task.stuck ? (
        <Banner tone="warn">
          <View className="gap-s2">
            <Text><Text strong>{m.title}.</Text> {task.stuck.reason} {task.stuck.suggested_fix?.text}</Text>
            <View className="flex-row flex-wrap gap-s2">{m.actions.map((a) => <Button key={a.id} size="sm" kind={a.kind} label={a.label} onPress={() => onAction(a.id)} />)}</View>
          </View>
        </Banner>
      ) : null}
      {brief ? <Section title="What to do"><Text>{brief}</Text></Section> : null}
      <TaskFacts world={world} facts={taskFacts(world, task, { titles })} how={showHow ? (
        <View className="items-start gap-s2">
          <Segmented label="How" value={task.how || "person"} onChange={onHow} options={Object.entries(HOW_LABEL) as [string, string][]} />
          {tpl ? <Chip tone="accent">{recordTitle(world, tpl)}</Chip> : null}
        </View>
      ) : undefined} />
      {draft ? <Section title="The draft"><DraftBlock draft={draft} /></Section> : null}
      {acts.length ? <View className="flex-row flex-wrap gap-s2">{acts.map((a) => <Button key={a.id} kind={a.kind} icon={a.icon as never} label={a.label} onPress={() => onAction(a.id)} />)}</View> : null}
      {rec && onOpenRecord ? <Button kind="ghost" size="sm" label={`Open ${recordTitle(world, rec)}`} onPress={() => onOpenRecord(rec.id)} /> : null}
    </View>
  );
}
