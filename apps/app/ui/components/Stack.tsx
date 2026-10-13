import { View } from "react-native";
import { useUiTheme } from "../theme";
import { px } from "../lib/measure";

/** The space steps a Stack takes: the theme's own scale (--s-1 to --s-12), never a number. */
export type StackGap = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8;

/**
 * One layout primitive for screens: its children in a column (or a row) with a gap from the space scale. A screen composes with Stack and library components and
 * carries no size, space or colour of its own. `row` lays children out in a line (`wrap` lets it break), `align` and `justify` are the flex words, `grow` takes the free room.
 */
export function Stack({ gap = 3, row, wrap, align, justify, grow, children }: { gap?: StackGap; row?: boolean; wrap?: boolean; align?: "start" | "center" | "end" | "stretch"; justify?: "start" | "center" | "end" | "between"; grow?: boolean; children?: React.ReactNode }) {
  const { map } = useUiTheme();
  const flex = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", between: "space-between" } as const;
  return (
    <View style={{ flexDirection: row ? "row" : "column", flexWrap: wrap ? "wrap" : "nowrap", gap: gap ? px(map, `--s-${gap}`) : 0, minWidth: 0, ...(align ? { alignItems: flex[align] } : null), ...(justify ? { justifyContent: flex[justify] } : null), ...(grow ? { flexGrow: 1, flexShrink: 1 } : null) }}>
      {children}
    </View>
  );
}
