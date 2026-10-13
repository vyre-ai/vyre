import { useState } from "react";
import { View } from "react-native";
import { Button, Field, Sheet, Text } from "@vyre/ui";
import { startName } from "../templates/model";

/** Asks what to call a new project made from a template ("Rivera Family Trust"), in the template's own words: "Start a matter". */
export function StartSheet({ noun, open, busy, onClose, onStart }: { noun: string; open: boolean; busy: boolean; onClose: () => void; onStart: (name: string) => void }) {
  const [text, setText] = useState("");
  const n = startName(text);
  const word = noun.toLowerCase();
  return (
    <Sheet open={open} onClose={onClose} title={`New ${word}`}>
      <View className="gap-s3 p-s4">
        <Text tone="muted">{`Gives the ${word} its team and its stages, and puts the first stage's tasks in Now.`}</Text>
        <Field label="Name" value={text} onChangeText={setText} placeholder="Rivera Family Trust" />
        {text && !n.ok ? <Text size="caption" tone="label">{n.why}</Text> : null}
        <View className="flex-row gap-s2">
          <Button kind="primary" size="sm" label={`Start ${word}`} loading={busy} disabled={!n.ok} onPress={() => n.ok && onStart(n.name)} />
          <Button kind="ghost" size="sm" label="Cancel" onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}
