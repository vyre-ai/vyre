// Face ID, as the prototype fakes it: a sheet that says what is being approved and has one button. A real source swaps `onApprove`
// for the platform prompt; the words stay.
import { View } from "react-native";
import { Button, Sheet, Text, haptic } from "@vyre/ui";

export type FaceAsk = { title: string; body: string; label?: string; onApprove: () => void };

export function FaceIdSheet({ ask, onClose }: { ask: FaceAsk | null; onClose: () => void }) {
  return (
    <Sheet open={!!ask} onClose={onClose} title={ask?.title}>
      <Text tone="muted">{ask?.body}</Text>
      <View className="flex-row gap-s2">
        <Button kind="primary" icon="faceid" label={ask?.label ?? "Approve with Face ID"} onPress={() => { const a = ask; onClose(); haptic.approve(); a?.onApprove(); }} />
        <Button kind="ghost" label="Cancel" onPress={onClose} />
      </View>
    </Sheet>
  );
}
