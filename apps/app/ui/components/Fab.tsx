import { View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { PressableScale } from "../motion/PressableScale";
import { elevation } from "../lib/elevation";
import { useUiTheme } from "../theme";

/**
 * The floating action button (ui-review Projects phone 5): a 56 round primary button with a 24 icon, bottom right, 16 in from the edges, level-2 elevation.
 * Only on a phone list that creates things. Put it in a sibling of the scroll view so it stays put; it is also the trigger a Menu anchors to.
 */
export function Fab({ icon = "plus", label, onPress }: { icon?: IconName; label: string; onPress?: () => void }) {
  const { resolved } = useUiTheme();
  return (
    <PressableScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} depth={0.92} className="items-center justify-center rounded-full bg-primary" style={[{ width: 56, height: 56 }, elevation(resolved.scheme, 2)]}>
      <View><Icon name={icon} size={24} tone="primary-ink" /></View>
    </PressableScale>
  );
}
