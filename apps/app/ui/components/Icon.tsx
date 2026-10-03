import { View } from "react-native";
import Svg, { Circle, Ellipse, Path, Rect } from "react-native-svg";
import { ICONS, ICON_GRID, ICON_NAMES, type IconName } from "../../src/ui/icons.generated";
import { useUiTheme } from "../theme";

export type { IconName };
/** The family's own icon names (not the old aliases), in name order: the gallery draws every one. */
export { ICON_NAMES };
export type IconSize = 12 | 14 | 16 | 18 | 20 | 24;

const GRID = ICON_GRID;
/** 1.6 on the 24 grid at 20; thicker below so the line never drops under 1.33 px. */
const STROKE = 1.6;

/**
 * The one icon set (team/0.3/assets/icons, 24 grid, stroke 1.6): the elements unchanged, no fill, round caps, in the ink of the control
 * it sits in. Decorative: the control around it carries the name. `tone` is a colour role, never a hex.
 */
export function Icon({ name, tone = "text-2", size = 16 }: { name: IconName; tone?: string; size?: IconSize }) {
  const { color } = useUiTheme();
  const sw = STROKE * Math.max(1, 20 / size);
  const ink = { fill: "none", stroke: color[tone] ?? color["text-2"], strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${GRID} ${GRID}`}>
        {ICONS[name].map((p, i) => {
          switch (p.el) {
            case "path": return <Path key={i} d={p.d} {...ink} />;
            case "circle": return <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} {...ink} />;
            case "rect": return <Rect key={i} x={p.x} y={p.y} width={p.width} height={p.height} rx={p.rx} {...ink} />;
            case "ellipse": return <Ellipse key={i} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} {...ink} />;
          }
        })}
      </Svg>
    </View>
  );
}
