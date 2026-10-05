// The transcript in the native builds: React Native's inverted FlatList (newest at the bottom,
// history appended at the list's end, which is the top on screen), virtualized with a small
// window. maintainVisibleContentPosition keeps a reader in history still while the tail grows,
// and a "Jump to latest" pill shows while they are up there.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { TranscriptRow } from "./model";
import type { TranscriptProps } from "./Transcript";

/** Further up than this (px) is reading history. */
const AWAY = 40;

export function Transcript({ rows, renderRow, hasMore, onNearTop, head, jump, jumpTo }: TranscriptProps) {
  const newestFirst = useMemo(() => [...rows].reverse(), [rows]);
  const list = useRef<FlatList<TranscriptRow>>(null);
  const [away, setAway] = useState(false);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const up = e.nativeEvent.contentOffset.y > AWAY;
    setAway((was) => (was === up ? was : up));
  }, []);
  // A tapped quote scrolls to the original (the list is inverted, so index 0 is the newest row).
  useEffect(() => {
    if (!jumpTo) return;
    const index = newestFirst.findIndex((r) => r.key === jumpTo.key);
    if (index >= 0) list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
  }, [jumpTo?.n]);
  const toLatest = useCallback(() => {
    list.current?.scrollToOffset({ offset: 0, animated: true });
    setAway(false);
  }, []);
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={list}
        testID="transcript"
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
        maintainVisibleContentPosition={{ minIndexForVisible: 1, autoscrollToTopThreshold: AWAY }}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        onScrollToIndexFailed={(info) => { list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true }); }}
        scrollEventThrottle={100}
      />
      {away && jump ? jump(toLatest) : null}
    </View>
  );
}
