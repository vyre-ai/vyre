import { View } from "react-native";
import { useUiTheme } from "../theme";
import { Icon, type IconName } from "./Icon";

/** A kind of thing, not a who: a 32 square (radius 9) in surface-3 with a 20 icon in text-2, no outline. Settings rows, Kits, Flows, install steps. Never carries a letter. */
export function IconTile({ name, size = 32, tone = "text-2", badge }: { name: IconName; size?: 32 | 40 | 44; /** The icon ink: a colour role (warn for a held thing, accent for a link). */ tone?: string; /** A mark at the bottom right (the space badge), already ringed. */ badge?: React.ReactNode }) {
  const { color } = useUiTheme();
  return (
    <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), backgroundColor: color["surface-3"], alignItems: "center", justifyContent: "center" }}>
      <Icon name={name} size={20} tone={tone} />
      {badge ? <View style={{ position: "absolute", right: -6, bottom: -6 }}>{badge}</View> : null}
    </View>
  );
}
