import { useEffect, useState } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { aid, stageFieldOf, stageNames } from "../../src/vendor/deck/ui/kernel-view.js";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { EmptyState } from "../components/States";
import { Row } from "../components/Row";
import { StageSteps } from "../components/StageSteps";
import { Text } from "../components/Text";
import { ActorMark } from "./ActorMark";
import { useUiTheme } from "../theme";
import { createdLine, liveLine, progressText, recordTitle, required, stageGroups, stateTone, stateWord, teamOf, waitsFor, who, type World } from "./model";

const WIDE = 1000;

/** A stage and its tasks: the current stage open, the others folded (a finished one says "n of m done"). The person's own folds stay until the record moves to another stage. */
function Stages({ world, tasks, stages, current, onOpen }: { world: World; tasks: any[]; stages: string[]; current?: string; onOpen: (t: any) => void }) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  useEffect(() => setToggled({}), [current]);
  const groups = stageGroups(tasks, stages, current);
  if (!groups.length) return <EmptyState title="No tasks yet" body="Entering a stage makes its tasks." />;
  return (
    <View>
      {groups.map((g, gi) => {
        const open = g.label in toggled ? toggled[g.label] : g.current;
        return (
          <View key={g.label} className={gi > 0 ? "border-t border-edge" : ""}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setToggled((s) => ({ ...s, [g.label]: !open }))} className="min-h-row flex-row items-center gap-s2 px-s4 py-s2">
              <Icon name={open ? "chevron-down" : "chevron"} size={16} tone="label" />
              <Text strong className="flex-1">{g.label}</Text>
              {g.current && g.stage ? <Chip tone="accent">Now</Chip> : null}
              <Text size="caption" tone="label">{g.tasks.length ? `${g.done} of ${g.total} done` : "No tasks yet"}</Text>
            </Pressable>
            {open ? (g.tasks.length ? g.tasks.map((t) => <TaskRow key={t.id} world={world} task={t} all={tasks} onOpen={() => onOpen(t)} />) : <View className="px-s4 pb-s3"><Text tone="label">No tasks yet.</Text></View>) : null}
          </View>
        );
      })}
    </View>
  );
}

function TaskRow({ world, task: t, all, onOpen }: { world: World; task: any; all: any[]; onOpen: () => void }) {
  const a = who(world, aid(t.doer));
  const chk = t.checker ? who(world, aid(t.checker))?.name || aid(t.checker) : "";
  const waits = waitsFor(t, all);
  const meta = [t.state === "waiting" && waits.length ? `Waits for ${waits.join(", ")}` : null, chk ? `Checked by ${chk}` : null, !required(t) ? "Optional" : null].filter(Boolean).join(" · ");
  const extra = t.state === "stuck" && t.stuck ? t.stuck.reason : t.state === "working" && t.ext?.now ? `${a?.name || aid(t.doer)} ${t.ext.now}` : "";
  return (
    <Row
      lead={<ActorMark who={a} size="sm" />}
      title={t.title}
      sub={<View>{meta ? <Text size="caption" tone="label" numberOfLines={1}>{meta}</Text> : null}{extra ? <Text size="caption" tone={t.state === "stuck" ? "warn" : "ok"} numberOfLines={2}>{extra}</Text> : null}</View>}
      end={<Chip tone={stateTone(t.state) as never}>{stateWord(t, world.me)}</Chip>}
      onPress={onOpen}
    />
  );
}

/** The files a project holds: its file fields and what its tasks produced. */
function filesOf(def: any, row: any, tasks: any[]): { name: string; sub: string }[] {
  const out: { name: string; sub: string }[] = [];
  for (const f of def.fields.filter((x: any) => x.kind === "file")) { const v = row.data?.[f.name]; if (v?.name) out.push({ name: v.name, sub: f.label }); }
  for (const t of tasks) { const f = t.ext?.result?.file; if (f?.name) out.push({ name: f.name, sub: t.title }); }
  return out;
}

/**
 * The project page: a record of a type that holds work, as a project (DESIGN-tasks.md, "Stages are made of tasks"). The stage strip, the line saying what the team is
 * doing now, each stage's tasks, the team with its doing-now line, linked records, chats and files. A task opens in place; when the last required task of a stage is
 * done the record moves on by itself, and this page redraws from the store.
 */
export function ProjectView({ world, def, row, events, links, onOpenTask }: { world: World; def: any; row: any; events: any[]; links: { field: string; rec: any; def: any }[]; onOpenTask: (t: any) => void }) {
  const { width } = useWindowDimensions();
  const { phone } = useUiTheme();
  const tasks = world.tasks.filter((t) => t.record === row.urn);
  const sf = stageFieldOf(def);
  const stages: string[] = sf ? stageNames(def, sf) : [];
  const current: string | undefined = sf ? row.data?.[sf.name] : undefined;
  const ownerField = def.fields.find((f: any) => f.kind === "actor");
  const owner: string = ownerField ? aid(row.data?.[ownerField.name]?.actor) : "";
  const team = teamOf({ tasks, actors: world.actors, owner });
  const live = liveLine(tasks, world.actors);
  const created = createdLine(events, world.actors, world.now);
  const files = filesOf(def, row, tasks);
  const wide = width >= WIDE;

  const left = (
    <Card title="Tasks" flush actions={<Text size="caption" tone="label">{progressText(tasks.filter(required))}</Text>}>
      <Stages world={world} tasks={tasks} stages={stages} current={current} onOpen={onOpenTask} />
    </Card>
  );
  const right = (
    <View className="gap-s4">
      <Card title="Team" flush>
        {team.map((m, i) => <View key={m.id}>{i > 0 ? <Divider /> : null}<Row lead={<ActorMark who={who(world, m.id)} />} title={who(world, m.id)?.name || m.id} sub={m.doing} /></View>)}
      </Card>
      <Card title="Linked records" flush>
        {links.length ? links.map((l, i) => <View key={l.rec.urn}>{i > 0 ? <Divider /> : null}<Row lead={<Avatar of={{ kind: l.rec.type === "contact" ? "person" : "project", id: l.rec.id, name: recordTitle(world, l.rec) }} />} title={recordTitle(world, l.rec)} sub={l.def?.label || l.field} /></View>) : <EmptyState title="Nothing linked yet" />}
      </Card>
      <Card title="Chats" flush><EmptyState title="No chats yet" body="Chats about this project will appear here." /></Card>
      <Card title="Files" flush>
        {files.length ? files.map((f, i) => <View key={f.name}>{i > 0 ? <Divider /> : null}<Row title={f.name} sub={f.sub} /></View>) : <EmptyState title="No files yet" />}
      </Card>
    </View>
  );
  return (
    <View className="gap-s4">
      {created ? <Text size="caption" tone="label">{created}</Text> : null}
      {stages.length ? <StageSteps strip={phone} stages={stages} current={Math.max(0, stages.indexOf(current ?? ""))} /> : null}
      {live ? <View className="flex-row items-center gap-s2"><View className="h-s2 w-s2 rounded-full bg-ok" /><Text tone="muted">{live}</Text></View> : null}
      {wide ? <View className="flex-row items-start gap-s6"><View className="min-w-0 flex-[3]">{left}</View><View className="min-w-0 flex-[2]">{right}</View></View> : <View className="gap-s4">{left}{right}</View>}
    </View>
  );
}
