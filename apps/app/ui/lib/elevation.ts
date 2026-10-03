import type { ViewStyle } from "react-native";
import { tokens } from "../../src/theme/tokens";

type Layer = readonly [number, number, number, number, string, boolean];

/** Elevation levels 1 to 3 as a boxShadow (React Native 0.76 and later, and the web): each layer is [x, y, blur, spread, colour, inset]. Nothing else casts a shadow. */
export function elevation(scheme: "dark" | "paper", level: 1 | 2 | 3): ViewStyle {
  const v2 = tokens.v2 as any;
  const layers: Layer[] = v2.elevation[scheme][`e${level}`];
  const edgeTop = v2.color[scheme].edgeTop;
  return {
    boxShadow: layers.map(([x, y, b, s, c, inset]) => `${inset ? "inset " : ""}${x}px ${y}px ${b}px ${s}px ${c === "edgeTop" ? edgeTop : c}`).join(", "),
  } as ViewStyle;
}
