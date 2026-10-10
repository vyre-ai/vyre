// The live screen inside a chat card, in a browser and on the phone: Glass's own viewer and hook, small. The picture is noVNC in Glass's iframe; taking over, signing in privately and handing back are Glass's own acts (glass.take,
// glass.release), so every rule Glass has (the idle countdown, the private sign-in that blinds the agent, the note the agent gets) holds here unchanged. `autoTake` takes the keyboard as soon as the screen is live
// (the sign-in card), `private` makes that take a private sign-in. `onHandedBack` says the person gave it back.
import { useEffect, useRef } from "react";
import { View } from "react-native";
import { Banner, Button, Chip, Text, useUiTheme } from "@vyre/ui";
import { GlassFrame } from "../../screens/glass/GlassFrame";
import { frameUrl, relayOnly, useGlass } from "../../screens/glass/state";
import { badgeWord, overText } from "../../screens/glass/model";

export function LiveScreen({ computer, private: priv = false, autoTake = false, onHandedBack }: { computer: string; private?: boolean; autoTake?: boolean; onHandedBack?: () => void }) {
  const { color } = useUiTheme();
  const g = useGlass(computer, `computer:${computer}`);
  const tried = useRef(false);
  useEffect(() => {
    if (autoTake && !tried.current && g.conn === "live" && !g.mine && !g.other) { tried.current = true; void g.take(priv); }
  }, [autoTake, priv, g.conn, g.mine, g.other, g]);
  const [title, detail] = overText(g.conn, computer, g.why);
  const hand = async () => { await g.release(""); onHandedBack?.(); };
  return (
    <View style={{ gap: 8 }}>
      <View style={{ width: "100%", aspectRatio: g.size ? g.size.w / g.size.h : 16 / 10, backgroundColor: color["surface-3"], borderRadius: 10, overflow: "hidden" }} accessibilityLabel={`Live view of ${computer}'s screen`}>
        <GlassFrame src={frameUrl()} relay={relayOnly()} onMessage={g.onFrame} frameRef={g.frame} label={`${computer}'s screen`} />
        {g.conn !== "live" ? (
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: 12 }}>
            <View style={{ alignItems: "center", gap: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-3"] }}>
              <Text strong>{title}</Text>{detail ? <Text size="secondary" tone="muted">{detail}</Text> : null}
              {["ended", "error", "noscreen", "failed"].includes(g.conn) ? <Button size="sm" label="Try again" onPress={g.retryNow} /> : null}
            </View>
          </View>
        ) : null}
      </View>
      {g.notice ? <Banner tone={g.notice.tone === "err" ? "warn" : undefined}><Text>{g.notice.text}</Text></Banner> : null}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Chip>{g.mine ? (g.holder?.private ? "Signing in privately" : "You have control") : badgeWord(g.conn)}</Chip>
        <View style={{ flex: 1 }} />
        {g.mine ? <Button kind="primary" size="sm" label={g.holder?.private ? "I am signed in" : "Hand back"} disabled={g.busy} onPress={hand} />
          : g.conn === "live" && !g.other ? <Button kind="primary" size="sm" icon="hand" label={priv ? "Sign in privately" : "Take over"} disabled={g.busy} onPress={() => void g.take(priv)} /> : null}
      </View>
    </View>
  );
}
