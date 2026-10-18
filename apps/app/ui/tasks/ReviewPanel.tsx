import { useState } from "react";
import { View } from "react-native";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { Text } from "../components/Text";
import { showToast } from "../components/Toast";
import { useStore } from "../store";
import { checkKey, checklistOf, reviewGate, reviewInput } from "./slots-model.js";

/**
 * The reviewer's side of a task that is In review (DESIGN-tasks-v2.md): the skills' checklist to tick, a note, and Pass or Request changes. A pass sends nothing; the approver still decides.
 * The kernel checks that the person is the reviewer and not the doer; this panel only gates what the tool would refuse (an item unanswered, a miss without a note, changes without a note).
 */
export function ReviewPanel({ task, me }: { task: any; me: string }) {
  const store = useStore();
  const list = checklistOf(task);
  const [ticks, setTicks] = useState<Record<string, boolean | undefined>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const gate = reviewGate(list, ticks, note);
  const send = async (result: "pass" | "changes") => {
    setBusy(true);
    try {
      await (store as any).review(task.id, reviewInput(result, list, ticks, note), me);
      showToast(result === "pass" ? `Passed: ${task.title}.` : `Sent back with changes: ${task.title}.`);
    } catch (e) { showToast(String((e as Error)?.message || e)); } finally { setBusy(false); }
  };
  return (
    <View className="gap-s3 rounded-card border border-edge p-s4">
      <Text strong>Review this work</Text>
      {task.slots?.reviewer?.instructions ? <View className="gap-s1"><Text size="caption" tone="label" strong>From the requester</Text><Text tone="muted">{String(task.slots.reviewer.instructions)}</Text></View> : null}
      {Array.isArray(task.slots?.reviewer?.skills) && task.slots.reviewer.skills.length ? <Text size="caption" tone="label">{`Checked against: ${task.slots.reviewer.skills.map((x: { name?: string; id: string }) => x.name || x.id).join(", ")}`}</Text> : null}
      {list.length ? (
        <View className="gap-s2">
          {list.map((x) => {
            const k = checkKey(x);
            const v = ticks[k];
            return (
              <View key={k} className="flex-row items-center gap-s2">
                <Text className="min-w-0 flex-1">{x.item}</Text>
                <Button size="sm" kind={v === true ? "primary" : "secondary"} label="Holds" onPress={() => setTicks({ ...ticks, [k]: true })} />
                <Button size="sm" kind={v === false ? "primary" : "secondary"} label="Missed" onPress={() => setTicks({ ...ticks, [k]: false })} />
              </View>
            );
          })}
        </View>
      ) : <Text tone="muted">No checklist on this one. Look it over, then pass it or ask for changes.</Text>}
      <Field label="Note" value={note} onChangeText={setNote} multiline placeholder="What to change, or why a missed item is fine" />
      {gate.why && !gate.pass ? <Text size="caption" tone="label">{gate.why}</Text> : null}
      <View className="flex-row flex-wrap justify-end gap-s2">
        <Button kind="secondary" label="Request changes" disabled={busy || !gate.changes} onPress={() => void send("changes")} />
        <Button kind="primary" label="Pass" disabled={busy || !gate.pass} onPress={() => void send("pass")} />
      </View>
    </View>
  );
}
