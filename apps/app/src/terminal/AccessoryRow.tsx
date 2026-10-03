import { View } from "react-native";
import { Button } from "@vyre/ui";
import { ROW } from "./keys";

/** The keys a phone keyboard lacks, above the keyboard: esc, tab, ctrl (sticky), arrows, pipe, slash. keys.js says what each sends. */
export function AccessoryRow({ ctrlArmed, onKey }: { ctrlArmed: boolean; onKey: (id: string) => void }) {
  return (
    <View className="flex-row items-center justify-between gap-s1 px-s2 py-s1 border-t border-edge bg-panel">
      {ROW.map((k) => (
        <View key={k.id} className="flex-1">
          <Button
            label={k.label}
            size="sm"
            kind={k.sticky && ctrlArmed ? "primary" : "secondary"}
            accessibilityLabel={k.id === "ctrl" ? (ctrlArmed ? "ctrl, armed" : "ctrl") : k.id}
            onPress={() => onKey(k.id)}
          />
        </View>
      ))}
    </View>
  );
}
