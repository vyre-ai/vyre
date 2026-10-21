import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Button, Field, Text, showToast } from "@vyre/ui";
import { Section } from "../../ui/tasks/Section";
import { planner } from "../planner/planner";
import { addInput, kindWord, previewLine, splitKind } from "../planner/model";

/** Tasks on Home: the planner's capture ("remind me at 7") is the composer. */
export function HomeTasks() {
  const [words, setWords] = useState("");
  const [preview, setPreview] = useState("");
  const [adding, setAdding] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const { kind, text } = splitKind(words);
    const mine = ++seq.current;
    if (!text) { setPreview(""); return; }
    if (kind === "todo" || kind === "note") { setPreview(`${kindWord(kind)}: ${text}`); return; }
    const t = setTimeout(() => {
      planner.parse(text, kind || undefined).then((p) => { if (seq.current === mine) setPreview(previewLine(p, text)); }).catch(() => { if (seq.current === mine) setPreview(""); });
    }, 250);
    return () => clearTimeout(t);
  }, [words]);
  const add = () => {
    const input = addInput(words);
    if (!input || adding) return;
    setAdding(true);
    planner.add(input).then(() => { setWords(""); setPreview(""); showToast("Added."); }).catch((e) => showToast(e instanceof Error && e.message ? e.message : "That did not go through.")).finally(() => setAdding(false));
  };
  return (
    <Section title="Tasks">
      <View className="gap-s3">
        <Field label="Add a task" name="task" value={words} onChangeText={setWords} placeholder="Remind me at 7, or todo buy milk" onSubmit={add} />
        {preview ? <Text size="secondary" tone="label">{preview}</Text> : null}
        <Button kind="primary" label={adding ? "Adding" : "Add"} onPress={add} disabled={!words.trim() || adding} />
      </View>
    </Section>
  );
}
