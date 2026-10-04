// Access, on the real box: Claude Code on a computer (core/pluginagent). The card that asks (Allow, Don't allow), the row that lets it ask again after a no, and the row that takes its reach away.
// Nothing shows until pluginagent.status answers, and nothing when the box has no such tool.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Divider, Text, showToast } from "@vyre/ui";
import { tool, said } from "../../src/real/box";
import { ALLOW, ASK_AGAIN, ASK_CAPTION, DONT_ALLOW, allowedToast, askAgainToast, askTitle, declinedLine, declinedTitle, declinedToast, grantedLine, pluginRefusal, pluginView, removeLabel, removedToast } from "./plugin-model.js";

export function RealPlugin({ onChanged }: { onChanged?: () => void }) {
  const [view, setView] = useState<ReturnType<typeof pluginView> | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => {
    Promise.all([tool<any>("pluginagent.status"), tool<any>("pluginagent.pending").catch(() => [])]).then(([s, p]) => setView(pluginView(s, p))).catch(() => setView(null));
  }, []);
  useEffect(load, [load]);
  if (!view || (!view.asks.length && !view.row)) return null;
  const run = (key: string, go: () => Promise<unknown>, done: string) => {
    setBusy(key);
    go().then(() => { showToast(done); load(); onChanged?.(); }).catch((e) => showToast((e as { code?: string })?.code && /^(expired|conflict|not_found|denied|not_allowed|forbidden)$/.test((e as { code: string }).code) ? pluginRefusal((e as { code: string }).code) : said(e))).finally(() => setBusy(""));
  };
  return (
    <Card flush>
      {view.asks.map((a, i) => (
        <View key={a.id}>
          {i ? <Divider /> : null}
          <View className="gap-s2 p-s3">
            <Text strong>{askTitle(a.computer)}</Text>
            <Text size="caption" tone="label">{ASK_CAPTION}</Text>
            <View className="flex-row gap-s2">
              <Button kind="primary" size="sm" label={ALLOW} disabled={Boolean(busy)} onPress={() => run(`a${a.id}`, () => tool("pluginagent.grant", { id: a.id }), allowedToast(a.computer))} />
              <Button kind="ghost" size="sm" label={DONT_ALLOW} disabled={Boolean(busy)} onPress={() => run(`d${a.id}`, () => tool("pluginagent.decline"), declinedToast)} />
            </View>
          </View>
        </View>
      ))}
      {view.row?.kind === "granted" ? (
        <View>
          {view.asks.length ? <Divider /> : null}
          <View className="gap-s2 p-s3">
            <Text strong>{`Claude Code on ${view.row.computer}`}</Text>
            <Text tone="muted">{grantedLine}</Text>
            <View className="flex-row"><Button kind="hold" size="sm" label={removeLabel} onPress={() => { const c = (view.row as { computer: string }).computer; run("r", () => tool("pluginagent.revoke"), removedToast(c)); }} /></View>
          </View>
        </View>
      ) : null}
      {view.row?.kind === "declined" ? (
        <View>
          {view.asks.length ? <Divider /> : null}
          <View className="gap-s2 p-s3">
            <Text strong>{declinedTitle}</Text>
            <Text tone="muted">{declinedLine}</Text>
            <View className="flex-row"><Button kind="primary" size="sm" label={ASK_AGAIN} disabled={Boolean(busy)} onPress={() => run("on", () => tool("pluginagent.on"), askAgainToast)} /></View>
          </View>
        </View>
      ) : null}
    </Card>
  );
}
