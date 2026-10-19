import { Pressable, View } from "react-native";
import { Icon } from "./Icon";
import { useUiTheme } from "../theme";

/** A tick box: on, off, or some (a header box when only part of a list is picked). Pressing it flips it; the label is for screen readers. */
export function Checkbox({ on, some, onChange, label }: { on: boolean; some?: boolean; onChange: (on: boolean) => void; label: string }) {
  const { color } = useUiTheme();
  const mixed = !!some && !on;
  const lit = on || mixed;
  return (
    <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked: mixed ? "mixed" : on }} onPress={() => onChange(!on)} hitSlop={8}>
      <View style={{ height: 18, width: 18, alignItems: "center", justifyContent: "center", borderRadius: 5, borderWidth: 1, borderColor: lit ? color.primary : color["edge-strong"], backgroundColor: lit ? color.primary : "transparent" }}>
        {lit ? <Icon name={mixed ? "minus" : "check"} size={12} tone="primary-ink" /> : null}
      </View>
    </Pressable>
  );
}
