// One thread's transcript drawn inline, read only: the agent's text, its thinking and its tool calls, as Chat draws them (the same rows). Mounted only while a Flow chat's section is open, so it loads on expanding.
import { useMemo } from "react";
import { View } from "react-native";
import { useUiTheme } from "@vyre/ui";
import { ChatRow, SkeletonThread } from "../../src/chat/ChatRows";
import { groupToolRuns } from "../../src/chat/tool-runs.js";
import type { BlockCtx } from "../../src/chat/Blocks";
import { useSessionStream } from "../../src/chat/store";

export default function ThreadInline({ thread }: { thread: string }) {
  const { phone } = useUiTheme();
  const { store, rows: layout, loading } = useSessionStream(thread);
  const rows = useMemo(() => groupToolRuns(layout, (k: string) => store.item(k)) as unknown as typeof layout, [layout, store]);
  const ctx = useMemo<BlockCtx>(() => ({ wide: !phone }), [phone]);
  if (loading) return <SkeletonThread wide={!phone} />;
  return <View style={{ gap: 8 }}>{rows.map((r) => <ChatRow key={r.key} store={store} row={r as never} ctx={ctx} />)}</View>;
}
