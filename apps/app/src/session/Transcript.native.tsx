// The transcript in the native builds: React Native's inverted FlatList (newest at the bottom,
// history appended at the list's end, which is the top on screen), virtualized with a small
// window. maintainVisibleContentPosition keeps a reader in history still while the tail grows.

import { useMemo } from "react";
import { FlatList } from "react-native";
import type { TranscriptRow } from "./model";
import type { TranscriptProps } from "./Transcript";

export function Transcript({ rows, renderRow, hasMore, onNearTop, head }: TranscriptProps) {
  const newestFirst = useMemo(() => [...rows].reverse(), [rows]);
  return (
    <FlatList
      inverted
      data={newestFirst}
      keyExtractor={(r: TranscriptRow) => r.key}
      renderItem={({ item }) => <>{renderRow(item)}</>}
      onEndReached={() => hasMore && onNearTop()}
      onEndReachedThreshold={1}
      ListFooterComponent={head ? <>{head}</> : null}
      initialNumToRender={20}
      maxToRenderPerBatch={20}
      windowSize={7}
      removeClippedSubviews
      maintainVisibleContentPosition={{ minIndexForVisible: 1, autoscrollToTopThreshold: 40 }}
      keyboardShouldPersistTaps="handled"
    />
  );
}
