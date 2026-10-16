import { useState } from "react";
import { ASSISTANT_MARK, actedVia } from "../../src/store-core/kernel-view.js";
import { View } from "react-native";
import { AskCard } from "../components/AskCard";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { FormFields } from "../components/FormFields";
import { blank, isQuestions, missing, submission } from "../components/form-fields-model.js";
import { showToast } from "../components/Toast";
import { snoozeNeed } from "../../src/state/snooze";
import { DatePick, FilePick, LaterMenu, type AskFile } from "./AskControls";
import { askKind, landing, openTarget } from "./ask-model.js";
import { ActorMark } from "./ActorMark";
import { spaceRef } from "../marks/useMark";
import { cardFor, nameOf, recordTitle as recordTitleOf, who, type World } from "./model";
import { swipeActions } from "../motion/logic.js";
import type { SwipeAction } from "../motion/SwipeActions";
import { useUiTheme } from "../theme";
import { aid } from "../../src/store-core/kernel-view.js";

/**
 * The task card (DESIGN-tasks.md, Now): which record it belongs to, who made it and how, and what one tap does. It is the base AskCard with the task's words and
 * buttons. `onAction(id, input)` runs a button (Send with Face ID, Edit, Fix, Reassign, Mark done, Save...); `onOpen` opens the task in place.
 * `hero` is the step-up card for what the person does first. Chips: only a state (Stuck). Who asked or assigned it is in the sentence under the title, and
 * the space is the avatar's badge, never a chip.
 */
export function TaskCard({ world, task, showSpace, hero, onAction, onOpen }: { world: World; task: any; showSpace?: boolean; hero?: boolean; onAction: (id: string, input?: string, extra?: unknown) => void; onOpen: () => void }) {
  const { phone } = useUiTheme();
  const m = cardFor(world, task, { showSpace });
  const spTag = m.tags.find((t) => t.kind === "space");
  const [value, setValue] = useState("");
  // A question with a form: the fields sit above Yes, and Yes hands in the answers (nothing is sent while a required one is empty).
  const questions = isQuestions(task.form) && m.actions.some((a) => a.id === "yes") ? (task.form as any[]) : null;
  const [answers, setAnswers] = useState<Record<string, string | boolean>>(() => (questions ? blank(questions) : {}));
  const [tried, setTried] = useState(false);
  const sw = swipeActions(m.actions.map((a) => a.id));
  const bind = (list: typeof sw.leading): SwipeAction[] => list.map((a) => ({ ...a, onPress: () => (a.id === "open" || (a.id === "yes" && questions) ? onOpen() : onAction(a.id)) }) as SwipeAction);
  // A check or approval with no draft sentence says who asked: "kit asked. Needs your approval to send."
  const doer = aid(task.doer);
  const asked = m.reason === "check" && !task.ext?.result?.draft && doer && doer !== world.me ? `${nameOf(world, doer)} asked. ` : "";
  // Beside the field on a wide screen, under it on a phone.
  const inlineSave = !!m.inline && !phone ? m.actions.find((a) => a.id === "save") : undefined;
  const kind = askKind(m, task);
  // A file ask has no "Add the file" button: the picker is on the card. A yes or no also offers to show the plan before it is answered.
  const actions = m.actions.filter((a) => a !== inlineSave && !(kind === "file" && a.id === "file"));
  const rec = world.records.get(task.record);
  const chat = openTarget(task);
  const [busy, setBusy] = useState(false);
  const later = (until: number, label: string) => {
    const undo = snoozeNeed(task.id, until);
    showToast(`${m.title}: back ${label.toLowerCase()}.`, { label: "Undo", run: undo });
  };
  return (
    <AskCard
      swipe={{ leading: bind(sw.leading), trailing: bind(sw.trailing) }}
      needsYou={false}
      hero={hero}
      lead={<ActorMark who={who(world, m.lead)} size={hero ? 44 : 40} space={spTag ? spaceRef(spTag.text) : undefined} />}
      title={m.title}
      why={`${asked}${m.why}${actedVia(task) ? ` ${ASSISTANT_MARK}` : ""}`}
      tags={m.tags.filter((t) => t.tone === "warn").slice(0, 2).map((t) => ({ text: t.text, tone: t.tone as never }))}
      onTitlePress={onOpen}
      actions={[
        ...actions.map((a) => ({ label: a.label, kind: a.kind, icon: a.icon as never, onPress: () => {
          if (a.id === "open") { onOpen(); return; }
          if (a.id === "yes" && questions) {
            const lacking = missing(questions, answers);
            if (lacking.length) { setTried(true); showToast(`Answer ${lacking[0]} first.`); return; }
            onAction("yes", undefined, submission(questions, answers));
            return;
          }
          onAction(a.id, value);
        } })),
        ...(kind === "yes_no" ? [{ label: "See what will happen", kind: "ghost" as const, onPress: onOpen }] : []),
      ]}
    >
      {questions ? <FormFields fields={questions} values={answers} onChange={setAnswers} showMissing={tried} now={world.now} /> : null}
      {kind === "date" && m.inline ? (
        <View className="gap-s2">
          <DatePick label={m.inline.label} value={value} onChange={setValue} now={world.now} />
          <View className="flex-row"><Button kind="primary" label="Save" disabled={!value} onPress={() => onAction("save", value)} /></View>
        </View>
      ) : m.inline ? (
        <View className="flex-row items-end gap-s2">
          <Field className="flex-1" label={m.inline.label} value={value} onChangeText={setValue} kind={m.inline.kind} onSubmit={() => value.trim() && onAction("save", value)} />
          {inlineSave ? <Button kind="primary" label={inlineSave.label} onPress={() => onAction("save", value)} /> : null}
        </View>
      ) : null}
      {kind === "file" ? <FilePick busy={busy} lands={landing(task, { recordTitle: rec ? recordTitleOf(world, rec) : "" }).words} onFile={(f: AskFile) => { setBusy(true); Promise.resolve(onAction("file-picked", undefined, f)).finally(() => setBusy(false)); }} /> : null}
      <View className="flex-row flex-wrap items-center gap-s2">
        {chat ? <Button size="sm" kind="ghost" icon="chat" label={chat.label} onPress={() => onAction("open-chat")} /> : null}
        <LaterMenu now={world.now} onLater={later} />
      </View>
    </AskCard>
  );
}
