import { useState } from "react";
import { AskCard } from "../components/AskCard";
import { Field } from "../components/Field";
import { ActorMark } from "./ActorMark";
import { cardFor, who, type World } from "./model";
import { swipeActions } from "../motion/logic.js";
import type { SwipeAction } from "../motion/SwipeActions";

/**
 * The task card (DESIGN-tasks.md, Now): which record it belongs to, who made it and how, and what one tap does. It is the base AskCard with the task's words and
 * buttons. `onAction(id, input)` runs a button (Send with Face ID, Edit, Fix, Reassign, Mark done, Save...); `onOpen` opens the task in place.
 */
export function TaskCard({ world, task, showSpace, onAction, onOpen }: { world: World; task: any; showSpace?: boolean; onAction: (id: string, input?: string) => void; onOpen: () => void }) {
  const m = cardFor(world, task, { showSpace });
  const [value, setValue] = useState("");
  const sw = swipeActions(m.actions.map((a) => a.id));
  const bind = (list: typeof sw.leading): SwipeAction[] => list.map((a) => ({ ...a, onPress: () => (a.id === "open" ? onOpen() : onAction(a.id)) }) as SwipeAction);
  return (
    <AskCard
      swipe={{ leading: bind(sw.leading), trailing: bind(sw.trailing) }}
      needsYou={false}
      lead={<ActorMark who={who(world, m.lead)} />}
      title={m.title}
      why={m.why}
      tags={m.tags.map((t) => ({ text: t.text, tone: (t.kind === "space" ? "space" : t.tone) as never }))}
      onTitlePress={onOpen}
      actions={m.actions.map((a) => ({ label: a.label, kind: a.kind, icon: a.icon as never, onPress: () => (a.id === "open" ? onOpen() : onAction(a.id, value)) }))}
    >
      {m.inline ? <Field label={m.inline.label} value={value} onChangeText={setValue} kind={m.inline.kind} placeholder={m.inline.kind === "date" ? "YYYY-MM-DD" : undefined} /> : null}
    </AskCard>
  );
}
