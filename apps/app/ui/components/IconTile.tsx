import { View } from "react-native";
import { useUiTheme } from "../theme";
import { Icon, type IconName } from "./Icon";

/** A kind of thing, not a who: a 32 square (radius 9) in surface-3 with a 20 icon in text-2, no outline. Settings rows, Kits, Flows, install steps. Never carries a letter. */
export function IconTile({ name, size = 32 }: { name: IconName; size?: 32 | 40 | 44 }) {
  const { color } = useUiTheme();
  return (
    <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), backgroundColor: color["surface-3"], alignItems: "center", justifyContent: "center" }}>
      <Icon name={name} size={20} tone="text-2" />
    </View>
  );
}
