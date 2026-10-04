// Face ID, as the prototype fakes it: a sheet that says what is being approved and has one button. A real source swaps `onApprove`
// for the platform prompt; the words stay.
import { Platform, View } from "react-native";
import { Button, Sheet, Text, haptic } from "@vyre/ui";

export type FaceAsk = { title: string; body: string; label?: string; onApprove: () => void };

/** What this device calls its own approval: Face ID on an iPhone, a fingerprint on Android, Touch ID on a Mac, Windows Hello on Windows, else the passkey. */
export function presenceName(): string {
  if (Platform.OS === "ios") return "Face ID";
  if (Platform.OS === "android") return "your fingerprint";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Mac/.test(ua) ? "Touch ID" : /Windows/.test(ua) ? "Windows Hello" : "your passkey";
}
const say = (t?: string) => (t ? t.replace(/Face ID/g, presenceName()) : t);

export function FaceIdSheet({ ask, onClose }: { ask: FaceAsk | null; onClose: () => void }) {
  return (
    <Sheet open={!!ask} onClose={onClose} title={say(ask?.title)}>
      <Text tone="muted">{say(ask?.body)}</Text>
      <View className="flex-row gap-s2">
        <Button kind="primary" icon="faceid" label={say(ask?.label ?? "Approve with Face ID")} onPress={() => { const a = ask; onClose(); haptic.approve(); a?.onApprove(); }} />
        <Button kind="ghost" label="Cancel" onPress={onClose} />
      </View>
    </Sheet>
  );
}
