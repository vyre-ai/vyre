import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Text, showToast } from "@vyre/ui";
import { planner } from "../planner/planner";
import { addInput, kindWord, previewLine, splitKind } from "../planner/model";
import { HomeField } from "./HomeField";

/** The planner's capture ("remind me at 7") is one line. Enter and the plus add it. */
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
    <View className="gap-s2">
      <HomeField name="Add a task" value={words} onChangeText={setWords} placeholder="Add a task, like remind me at 7" icon="plus" action="Add a task" busy={adding} busyLabel="Adding" onSubmit={add} />
      {preview ? <Text size="secondary" tone="label">{preview}</Text> : null}
    </View>
  );
}
