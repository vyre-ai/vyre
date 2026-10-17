import { View } from "react-native";
import { Card } from "./Card";
import { ControlRow } from "./ControlRow";
import { Text } from "./Text";

/**
 * The one recovery key, shown once, as the body of the identity step (not a sheet that can be dismissed and hide the key).
 * Continue stays off until the person says they saved it.
 */
export function RecoveryKeySheet({ secret, saved, onSaved }: { secret: string; saved: boolean; onSaved: (v: boolean) => void }) {
  return (
    <View className="gap-s4">
      <Card>
        <View className="gap-s2">
          <Text size="caption" strong tone="label">Recovery key</Text>
          <Text mono selectable>{secret}</Text>
        </View>
      </Card>
      <Text tone="muted">This is shown once. Keep it somewhere only you can open. Vyre cannot show it again.</Text>
      <ControlRow title="I saved it" sub="Continue stays off until you have." on={saved} onToggle={onSaved} />
    </View>
  );
}
