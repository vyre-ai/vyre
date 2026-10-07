import { View } from "react-native";
import Svg, { Circle, Ellipse, Path, Rect } from "react-native-svg";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { ICONS, ICON_GRID, type IconName } from "./icons.generated";

export type { IconName };

/**
 * The one icon set (team/0.3/assets/icons, src/ui/icons.source.json) on its 24 grid, drawn with
 * react-native-svg: the set's elements unchanged, no fill, round caps and joins, in the ink of
 * the control it sits in. The drawings are generated from icons.txt from icons.source.json (npm run icons), so a name
 * the set lacks does not type-check; a new icon needs a design review.
 */

/** 12 in chips, tags and meta lines; 16 the default; 20 on 44 buttons, rail buttons and empty-state tiles. */
export type IconSize = (typeof tokens.icon.sizes)[number];

const GRID = ICON_GRID;
/** The family strokes 1.6 on its 24 grid, drawn at 20; a smaller drawing thickens so the line never drops under 1.33 px. */
const STROKE = 1.6;

/**
 * Decorative: hidden from assistive tech, the control around it carries the name. The ink is the
 * caller's (the row's, the button's), the theme's text when none is given. The stroke stays 1.5
 * at every size, so it is set in grid units against the scale rather than scaled with the drawing.
 */
export function Icon({ name, color, size = tokens.icon.sizes[1] }: { name: IconName; color?: string; size?: IconSize }) {
  const theme = useTheme();
  const sw = STROKE * Math.max(1, 20 / size);
  const ink = { fill: "none", stroke: color ?? theme.color.text, strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${GRID} ${GRID}`}>
        {ICONS[name].map((p, i) => {
          switch (p.el) {
            case "path":
              return <Path key={i} d={p.d} {...ink} />;
            case "circle":
              return <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} {...ink} />;
            case "rect":
              return <Rect key={i} x={p.x} y={p.y} width={p.width} height={p.height} rx={p.rx} {...ink} />;
            case "ellipse":
              return <Ellipse key={i} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} {...ink} />;
          }
        })}
      </Svg>
    </View>
  );
}
