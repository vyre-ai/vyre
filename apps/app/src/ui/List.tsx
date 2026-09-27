import type { ReactElement } from "react";
import { FlatList, Platform, ScrollView, type ListRenderItemInfo, type StyleProp, type ViewStyle } from "react-native";

/** At or below this many rows everything is mounted (chat core window.js, THRESHOLD); above, the list is virtualized. */
export const VIRTUAL_ABOVE = 100;

type Props<T> = {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T) => ReactElement;
  /** Every row's height: a virtualized list lays out without measuring. */
  rowHeight: number;
  header?: ReactElement | null;
  footer?: ReactElement | null;
  style?: StyleProp<ViewStyle>;
};

// The one inner scroller (the shell never scrolls): overscroll stays inside it.
const inner = Platform.OS === "web" ? ({ overscrollBehavior: "contain" } as unknown as ViewStyle) : null;

/**
 * A list of fixed-height rows. Up to 100 rows are a plain scroller (nothing to recycle, nothing to
 * guess); above that React Native's FlatList with a small window, so memory stays flat however
 * much waits.
 */
export function List<T>({ items, keyOf, render, rowHeight, header, footer, style }: Props<T>) {
  if (items.length <= VIRTUAL_ABOVE) {
    return (
      <ScrollView style={[{ flex: 1 }, inner, style]}>
        {header}
        {items.map((it) => (
          <ListKey key={keyOf(it)}>{render(it)}</ListKey>
        ))}
        {footer}
      </ScrollView>
    );
  }
  return (
    <FlatList
      style={[{ flex: 1 }, inner, style]}
      data={items as T[]}
      keyExtractor={keyOf}
      renderItem={({ item }: ListRenderItemInfo<T>) => render(item)}
      getItemLayout={(_, i) => ({ length: rowHeight, offset: rowHeight * i, index: i })}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      initialNumToRender={14}
      maxToRenderPerBatch={14}
      windowSize={5}
      removeClippedSubviews={Platform.OS !== "web"}
    />
  );
}

function ListKey({ children }: { children: ReactElement }) {
  return children;
}
