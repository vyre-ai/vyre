import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Icon } from "./Icon";
import { SPRING } from "../motion/tokens";
import { useUiTheme } from "../theme";

/** Where a row dropped after being dragged `dy` px from index `from` lands among `n` rows of height `h`. */
export const dropIndex = (from: number, dy: number, h: number, n: number): number => Math.max(0, Math.min(n - 1, from + Math.round(dy / h)));

/**
 * A list whose rows are dragged by a grip to reorder. Rows are one fixed height. The row lifts while it is held and settles where it is dropped;
 * `onMove(from, to)` is the caller's, who owns the order. Dragging is never the only way: the caller keeps move buttons beside it.
 */
export function SortableList<T>({ items, keyOf, rowHeight = 64, onMove, render }: { items: T[]; keyOf: (t: T) => string; rowHeight?: number; onMove: (from: number, to: number) => void; render: (t: T, i: number) => React.ReactNode }) {
  return (
    <View>
      {items.map((t, i) => <SortableRow key={keyOf(t)} i={i} n={items.length} last={i === items.length - 1} h={rowHeight} onMove={onMove}>{render(t, i)}</SortableRow>)}
    </View>
  );
}

function SortableRow({ i, n, h, last, onMove, children }: { i: number; n: number; last: boolean; h: number; onMove: (from: number, to: number) => void; children: React.ReactNode }) {
  const { color } = useUiTheme();
  const y = useSharedValue(0);
  const held = useSharedValue(0);
  const drop = (dy: number) => { const to = dropIndex(i, dy, h, n); if (to !== i) onMove(i, to); };
  const pan = Gesture.Pan()
    .onBegin(() => { held.value = 1; })
    .onUpdate((e) => { y.value = e.translationY; })
    .onEnd((e) => { runOnJS(drop)(e.translationY); })
    .onFinalize(() => { held.value = 0; y.value = withSpring(0, SPRING["spatial.fast"]); });
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }, { scale: 1 + held.value * 0.015 }], zIndex: held.value ? 10 : 0, opacity: held.value ? 0.96 : 1 }));
  return (
    <Animated.View style={[{ minHeight: h, flexDirection: "row", alignItems: "center", borderBottomWidth: last ? 0 : 1, borderBottomColor: color.edge }, style]}>
      <GestureDetector gesture={pan}>
        <View accessibilityLabel="Drag to reorder" style={{ width: 32, alignItems: "center", justifyContent: "center", alignSelf: "stretch" }}><Icon name="sort" tone="text-3" /></View>
      </GestureDetector>
      <View style={{ flex: 1, minWidth: 0, borderColor: color.edge }}>{children}</View>
    </Animated.View>
  );
}
