import { useState } from "react";
import { View } from "react-native";
import { AskCard } from "../components/AskCard";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { ActorMark } from "./ActorMark";
import { spaceRef } from "../marks/useMark";
import { cardFor, nameOf, who, type World } from "./model";
import { swipeActions } from "../motion/logic.js";
import type { SwipeAction } from "../motion/SwipeActions";
import { useUiTheme } from "../theme";
import { aid } from "../../src/vendor/deck/ui/kernel-view.js";

/**
 * The task card (DESIGN-tasks.md, Now): which record it belongs to, who made it and how, and what one tap does. It is the base AskCard with the task's words and
 * buttons. `onAction(id, input)` runs a button (Send with Face ID, Edit, Fix, Reassign, Mark done, Save...); `onOpen` opens the task in place.
 * `hero` is the step-up card for what the person does first. Chips: only a state (Stuck). Who asked or assigned it is in the sentence under the title, and
 * the space is the avatar's badge, never a chip.
 */
export function TaskCard({ world, task, showSpace, hero, onAction, onOpen }: { world: World; task: any; showSpace?: boolean; hero?: boolean; onAction: (id: string, input?: string) => void; onOpen: () => void }) {
  const { phone } = useUiTheme();
  const m = cardFor(world, task, { showSpace });
  const spTag = m.tags.find((t) => t.kind === "space");
  const [value, setValue] = useState("");
  const sw = swipeActions(m.actions.map((a) => a.id));
  const bind = (list: typeof sw.leading): SwipeAction[] => list.map((a) => ({ ...a, onPress: () => (a.id === "open" ? onOpen() : onAction(a.id)) }) as SwipeAction);
  // A check or approval with no draft sentence says who asked: "kit asked. Needs your approval to send."
  const doer = aid(task.doer);
  const asked = m.reason === "check" && !task.ext?.result?.draft && doer && doer !== world.me ? `${nameOf(world, doer)} asked. ` : "";
  // Beside the field on a wide screen, under it on a phone.
  const inlineSave = !!m.inline && !phone ? m.actions.find((a) => a.id === "save") : undefined;
  const actions = m.actions.filter((a) => a !== inlineSave);
  return (
    <AskCard
      swipe={{ leading: bind(sw.leading), trailing: bind(sw.trailing) }}
      needsYou={false}
      hero={hero}
      lead={<ActorMark who={who(world, m.lead)} size={hero ? 44 : 40} space={spTag ? spaceRef(spTag.text) : undefined} />}
      title={m.title}
      why={`${asked}${m.why}`}
      tags={m.tags.filter((t) => t.tone === "warn").slice(0, 2).map((t) => ({ text: t.text, tone: t.tone as never }))}
      onTitlePress={onOpen}
      actions={actions.map((a) => ({ label: a.label, kind: a.kind, icon: a.icon as never, onPress: () => (a.id === "open" ? onOpen() : onAction(a.id, value)) }))}
    >
      {m.inline ? (
        <View className="flex-row items-end gap-s2">
          <Field className="flex-1" label={m.inline.label} value={value} onChangeText={setValue} kind={m.inline.kind} placeholder={m.inline.kind === "date" ? "YYYY-MM-DD" : undefined} />
          {inlineSave ? <Button kind="primary" label={inlineSave.label} onPress={() => onAction("save", value)} /> : null}
        </View>
      ) : null}
    </AskCard>
  );
}
