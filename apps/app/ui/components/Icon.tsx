import { View } from "react-native";
import Svg, { Circle, Line, Path, Polyline, Rect } from "react-native-svg";
import { ICONS, type IconName } from "../../src/ui/icons.generated";
import { tokens } from "../../src/theme/tokens";
import { useUiTheme } from "../theme";

export type { IconName };
export type IconSize = (typeof tokens.icon.sizes)[number];

const GRID = tokens.icon.grid;
const STROKE = tokens.icon.stroke;

/**
 * The one icon set (docs/design/one-app/icons.txt): the elements unchanged, no fill, round caps, in the ink of the control
 * it sits in. Decorative: the control around it carries the name. `tone` is a colour role, never a hex.
 */
export function Icon({ name, tone = "text-2", size = 16 }: { name: IconName; tone?: string; size?: IconSize }) {
  const { color } = useUiTheme();
  const sw = (STROKE * GRID) / size;
  const ink = { fill: "none", stroke: color[tone] ?? color["text-2"], strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${GRID} ${GRID}`}>
        {ICONS[name].map((p, i) => {
          switch (p.el) {
            case "path": return <Path key={i} d={p.d} {...ink} />;
            case "circle": return <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} {...ink} />;
            case "rect": return <Rect key={i} x={p.x} y={p.y} width={p.width} height={p.height} rx={p.rx} {...ink} />;
            case "line": return <Line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} {...ink} />;
            case "polyline": return <Polyline key={i} points={p.points} {...ink} />;
          }
        })}
      </Svg>
    </View>
  );
}
