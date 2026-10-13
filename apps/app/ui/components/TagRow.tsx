import { useState } from "react";
import { View } from "react-native";
import { Chip } from "./Chip";
import { Field } from "./Field";
import { Text } from "./Text";
import { normalize } from "../../../../lib/tags.js";
import { suggest } from "../tags/model.js";

/**
 * The tags of one thing as a row of neutral chips. Read only, a chip opens that tag's page (`onOpen`). With `onAdd` and `onRemove` it edits in place: a press on a chip takes the tag off (the chip
 * shows an x), "Tag" opens a one-line field that offers the Space's tags (`known`) while you type and adds on Enter. The words are the engine's (lib/tags.js); a word that is not a tag says why under the field.
 */
export function TagRow({ tags, known = [], onOpen, onAdd, onRemove, empty }: {
  tags: string[]; known?: string[]; onOpen?: (tag: string) => void; onAdd?: (tag: string) => void | Promise<void>; onRemove?: (tag: string) => void | Promise<void>; /** Shown when there are none and nothing can be added. */ empty?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState("");
  const edit = !!onAdd && !!onRemove;
  const add = async (raw: string) => {
    const t = normalize(raw);
    if (!t) { setProblem("A tag is lower-case letters, numbers and dashes, up to 40 characters."); return; }
    try { await onAdd?.(t); setTyped(""); setProblem(""); } catch (e) { setProblem(e instanceof Error ? e.message : "That tag was not added."); }
  };
  if (!edit && !tags.length) return empty ? <Text tone="faint">{empty}</Text> : null;
  const offers = adding ? suggest(known, tags, typed) : [];
  return (
    <View className="gap-s2">
      <View accessibilityLabel="Tags" className="flex-row flex-wrap items-center gap-s1">
        {tags.map((t) => edit
          ? <Chip key={t} icon="x" onPress={() => void onRemove?.(t)}>{`#${t}`}</Chip>
          : <Chip key={t} onPress={onOpen ? () => onOpen(t) : undefined}>{`#${t}`}</Chip>)}
        {edit ? <Chip icon="plus" onPress={() => { setAdding((a) => !a); setProblem(""); }}>{tags.length ? "Tag" : "Add a tag"}</Chip> : null}
      </View>
      {adding ? (
        <View className="gap-s2">
          <Field name="New tag" value={typed} onChangeText={(v) => { setTyped(v); setProblem(""); }} placeholder="A word, then Enter" autoFocus onSubmit={() => void add(typed)} onKey={(k) => { if (k === "Escape") { setAdding(false); setTyped(""); setProblem(""); } }} error={problem || undefined} />
          {offers.length ? <View className="flex-row flex-wrap gap-s1">{offers.map((t) => <Chip key={t} icon="plus" onPress={() => void add(t)}>{`#${t}`}</Chip>)}</View> : null}
        </View>
      ) : null}
    </View>
  );
}
