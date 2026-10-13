import { useState } from "react";
import { View } from "react-native";
import { Button, Field, Sheet, Text } from "@vyre/ui";

/** The small question every "Describe it" asks where it lives; the answer goes to the one Engineer chat, which starts on it at once. */
export function DescribeSheet({ open, title, question, placeholder, cta, onClose, onSend }: { open: boolean; title: string; question: string; placeholder: string; cta: string; onClose: () => void; onSend: (words: string) => void }) {
  const [text, setText] = useState("");
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <View className="gap-s3 p-s4">
        <Text tone="muted">The Engineer reads what this is, asks the few questions that matter and drafts it. Nothing is made until you say yes.</Text>
        <Field label={question} value={text} onChangeText={setText} placeholder={placeholder} multiline lines={3} autoFocus />
        <View className="flex-row gap-s2"><Button kind="primary" size="sm" label={cta} onPress={() => { onSend(text.trim()); setText(""); }} /><Button kind="ghost" size="sm" label="Cancel" onPress={onClose} /></View>
      </View>
    </Sheet>
  );
}
