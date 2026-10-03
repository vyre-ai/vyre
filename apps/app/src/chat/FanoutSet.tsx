// A fan-out set: one question asked of several assistants or models, the answers side by side as a
// set. On a desktop the cards sit in a row; on a phone they are snap cards you swipe, with a dot
// for each. "Keep this" under a finished answer sends fanout-keep and carries on with that answer;
// the others stay as they were, dimmed and marked "Not kept". Cards subscribe to their own rows, so
// each streams on its own and the set never reflows another card's text.

import { useRef, useState } from "react";
import { ScrollView, View, useWindowDimensions, StyleSheet } from "react-native";
import { Button, Chip, Text, useUiTheme } from "@vyre/ui";
import { ChatAvatar } from "./ChatAvatar";
import { useSyncExternalStore } from "react";
import type { ChatStore } from "./store";
import type { Fanout } from "./group.js";

const S = StyleSheet.create({
  s1: { flexDirection: "row", alignItems: "center", gap: 8 },
  s2: { flex: 1 },
  s3: { flexDirection: "row" },
  s4: { gap: 8 },
  s5: { flexDirection: "row", gap: 12, alignItems: "stretch" },
  s6: { flexDirection: "row", gap: 6, justifyContent: "center" },
});


function Card({ store, message, fanout, width, phone, renderText }: {
  store: ChatStore; message: string; fanout: Fanout; width?: number; phone: boolean;
  renderText: (key: string) => React.ReactNode;
}) {
  const { color } = useUiTheme();
  const key = "a:" + message;
  useSyncExternalStore((f) => store.subscribeRow(key, f), () => store.rowRev(key));
  const it = store.item(key);
  const g = store.group;
  const lab = g.label(key);
  const kept = fanout.kept === message;
  const lost = !!fanout.kept && !kept;
  const done = !!it?.done;
  return (
    <View
      accessibilityLabel={`Answer from ${lab.name}`}
      style={[
        { borderWidth: 1, borderColor: kept ? color.accent : color.edge, backgroundColor: color["surface-2"], borderRadius: 12, padding: 12, gap: 8, minWidth: 0, opacity: lost ? 0.55 : 1 },
        width ? { width } : { flex: 1 },
        ({ scrollSnapAlign: "start" } as any),
      ]}
    >
      <View style={S.s1}>
        <ChatAvatar name={lab.name} family="agent" size="sm" />
        <Text strong style={S.s2} numberOfLines={1}>{lab.name}</Text>
        {kept ? <Chip tone="ok" icon="check">Kept</Chip> : lost ? <Text size="caption" tone="label">Not kept</Text> : null}
      </View>
      <View style={{ flex: 1, minHeight: phone ? 96 : 120 }}>{it ? renderText(key) : null}</View>
      {g.cut(message) ? <Text size="caption" tone="warn">{g.cut(message)}</Text> : null}
      {fanout.kept ? null : done ? (
        <View style={S.s3}>
          <Button kind="secondary" size={phone ? "md" : "sm"} icon="check" label="Keep this" accessibilityLabel={`Keep the answer from ${lab.name}`} onPress={() => store.social.keep(fanout.group, message)} />
        </View>
      ) : (
        <View style={{ minHeight: phone ? 40 : 32, justifyContent: "center" }}><Text size="caption" tone="label">Still answering</Text></View>
      )}
    </View>
  );
}

export function FanoutSet({ store, fanout, wide, renderText }: { store: ChatStore; fanout: Fanout; wide: boolean; renderText: (key: string) => React.ReactNode }) {
  const { width } = useWindowDimensions();
  const { color } = useUiTheme();
  const [page, setPage] = useState(0);
  const cardW = Math.min(width - 32 - 28, 360);
  const n = fanout.members.length;
  const names = fanout.members.map((m) => store.group.label("a:" + m.message).name);
  const lastPage = useRef(0);
  return (
    <View accessibilityLabel={`Answers from ${names.join(", ")}`} style={S.s4}>
      <Text size="caption" tone="label">{fanout.kept ? `Asked ${n}, kept one` : `Asked ${n} at once. Keep the one you want to carry on with.`}</Text>
      {wide ? (
        <View style={S.s5}>
          {fanout.members.map((m) => <Card key={m.message} store={store} message={m.message} fanout={fanout} phone={false} renderText={renderText} />)}
        </View>
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            snapToInterval={cardW + 12}
            decelerationRate="fast"
            scrollEventThrottle={32}
            onScroll={(e) => {
              const p = Math.round(e.nativeEvent.contentOffset.x / (cardW + 12));
              if (p !== lastPage.current) { lastPage.current = p; setPage(p); }
            }}
            style={({ scrollSnapType: "x mandatory" } as any)}
            contentContainerStyle={{ gap: 12, paddingRight: 28 }}
          >
            {fanout.members.map((m) => <Card key={m.message} store={store} message={m.message} fanout={fanout} width={cardW} phone renderText={renderText} />)}
          </ScrollView>
          <View accessibilityLabel={`Answer ${page + 1} of ${n}`} style={S.s6}>
            {fanout.members.map((m, i) => <View key={m.message} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: i === page ? color.text : color["edge-strong"] }} />)}
          </View>
        </>
      )}
    </View>
  );
}
