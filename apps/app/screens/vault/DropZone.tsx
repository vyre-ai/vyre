// A place to give the Add sheet a key file (a dropped JSON): on a phone, a button that opens the system file picker. The web build has its own (DropZone.web.tsx), which also takes a dropped file.
import { Pressable, View } from "react-native";
import { Icon, Text } from "@vyre/ui";
import { pickFile } from "./pick-file";

/** The text of a picked file: its bytes arrive as base64 and are read once. */
export const textOfBase64 = (b64: string): string => { try { return decodeURIComponent(escape(atob(b64))); } catch { return ""; } };

export type DropProps = { label: string; accept: string; /** What the zone shows once a file is in: a name, never the file's content. */ done?: string; error?: string; onText: (text: string, name: string) => void };

export function DropZone({ label, accept, done, error, onText }: DropProps) {
  const choose = async () => { const f = await pickFile(accept); if (f) onText(textOfBase64(f.base64), f.name); };
  return (
    <View className="gap-s1">
      <Text size="caption" strong tone="label">{label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: choose a file`} onPress={choose} className="min-h-control items-center justify-center gap-s1 rounded-card border border-dashed border-edge bg-surface-3 p-s4">
        <Icon name="upload" tone="text-2" size={20} />
        <Text tone={done ? "default" : "label"} className="text-center">{done || "Choose the file"}</Text>
      </Pressable>
      {error ? <Text size="caption" tone="err">{error}</Text> : null}
    </View>
  );
}
