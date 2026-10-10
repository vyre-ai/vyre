// Glass in the web app (parity row 8; web only for 0.2.9, phone and Mac in 0.3.1): watch an agent's computer, take over the keyboard or sign in privately, and browse its files.
// The picture is noVNC in an iframe (src/glass/frame.js); everything the person does goes through the glass.* tools. The box has files and no screen ("box").
import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Banner, Button, Card, Chip, EmptyState, Field, Segmented, Text, useUiTheme } from "@vyre/ui";
import { Frame } from "../places/Frame";
import FilesTab from "./FilesTab";
import { GlassFrame } from "./GlassFrame";
import { frameUrl, relayOnly, useGlass } from "./state";
import { badgeWord, clock, holdingRows, holdingTitle, latencyLabel, overText, relayed, stateLine, stateWord, watchersLine, whyBlocked } from "./model";

export default function GlassScreen() {
  const { name: raw } = useLocalSearchParams<{ name: string }>();
  const name = String(raw ?? "");
  const box = name === "box";
  if (Platform.OS !== "web") {
    return <Frame title="Glass" sub="Watch an agent's computer."><Card><EmptyState title="Glass is in the web app" body="Open Vyre in a browser on your computer to watch, take over and browse files. Phone and Mac come in a later release." /></Card></Frame>;
  }
  return box ? <Box /> : <Computer name={name} />;
}

/** The box: files, no screen. */
function Box() {
  return <Frame title="Your server" sub="Files in the folders you chose for Glass. Your server has no screen."><FilesTab target="box" name="box" /></Frame>;
}

function Computer({ name }: { name: string }) {
  const target = `computer:${name}`;
  const g = useGlass(name, target);
  const { color } = useUiTheme();
  const [tab, setTab] = useState<"screen" | "files">("screen");
  const [priv, setPriv] = useState(false);
  const [note, setNote] = useState("");
  const [now, setNow] = useState(Date.now());
  // The held time counts once a second, only while this tab is visible and holding.
  useEffect(() => {
    if (!g.mine) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [g.mine]);
  // "T" takes over; Ctrl+Enter hands back when focus is outside the screen.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
      if (g.mine && e.key === "Enter" && e.ctrlKey) { e.preventDefault(); void g.release(note); return; }
      if (!typing && !g.mine && !g.other && g.conn === "live" && (e.key === "t" || e.key === "T") && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); void g.take(false); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [g, note]);

  if (g.loaded === "loading") return <Frame title={`${name}'s computer`}><Text tone="faint">Opening Glass.</Text></Frame>;
  if (g.loaded === "missing" || g.loaded === "offline") {
    return (
      <Frame title={`${name}'s computer`} sub="Glass">
        <Card><EmptyState title={g.loaded === "offline" ? "Your server is not answering" : `${name}'s computer runs on your server`}
          body={g.loaded === "offline" ? "Glass opens once your server answers again. Nothing was lost." : "No box is paired with this device, so there is no screen to watch. Add your server under Settings, Devices."} /></Card>
      </Frame>
    );
  }
  const state = g.info ? stateWord(g.info.state) : "";
  const sub = !g.info ? `Glass does not know a computer for ${name}.` : state;
  const blocked = whyBlocked(g.holder, g.surface, g.conn === "live");
  const [title, detail] = overText(g.conn, name, g.why);
  const wait = g.idleAt ? Math.max(0, Math.ceil((g.idleAt - now) / 1000)) : 0;
  const rows = g.holder ? holdingRows(name, g.holder.private) : [];
  return (
    <Frame title={`${name}'s computer`} sub={sub}>
      {g.hasScreen ? <Segmented label="Glass" value={tab} onChange={setTab} options={[["screen", "Screen"], ["files", "Files"]]} /> : null}
      {/* The screen stays mounted under the Files tab so the stream is not dropped when the person looks at files. */}
      <View style={{ display: tab === "screen" ? "flex" : "none" }} className="gap-s3 pt-s2">
        {g.notice ? (
          <Banner tone={g.notice.tone === "err" ? "warn" : undefined}>
            <View className="flex-row items-center gap-s2"><View className="min-w-0 flex-1">{g.notice.title ? <Text strong>{g.notice.title}</Text> : null}<Text>{g.notice.text}</Text></View><Button kind="ghost" size="sm" label="Dismiss" onPress={() => g.setNotice(null)} /></View>
          </Banner>
        ) : null}
        {g.other && g.holder ? <Banner><Text>{`${blocked.replace(/ has control\.$/, "")} has the keyboard${g.holder.since ? `, ${clock(now - g.holder.since)}` : ""}. ${name} is paused and this view is read-only.`}</Text></Banner> : null}
        <View className="flex-row flex-wrap gap-s3">
          <View className="min-w-0 flex-[3] gap-s2" style={{ minWidth: 320 }}>
            <View style={{ width: "100%", aspectRatio: g.size ? g.size.w / g.size.h : 16 / 10, backgroundColor: color["surface-3"], borderRadius: 8, overflow: "hidden" }} accessibilityLabel={`Live view of ${name}'s screen`}>
              <GlassFrame src={frameUrl()} relay={relayOnly()} onMessage={g.onFrame} frameRef={g.frame} label={`${name}'s screen`} />
              {g.conn !== "live" ? (
                <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", padding: 16 }}>
                  <View className="items-center gap-s2 rounded-card border border-edge bg-surface-3 p-s4"><Text strong>{title}</Text>{detail ? <Text size="secondary" tone="muted">{detail}</Text> : null}
                    {["ended", "error", "noscreen", "failed"].includes(g.conn) ? <Button size="sm" label={g.conn === "failed" ? "Retry" : "Try again"} onPress={g.retryNow} /> : null}</View>
                </View>
              ) : null}
            </View>
            <View className="flex-row flex-wrap items-center gap-s2">
              <Chip>{badgeWord(g.conn)}</Chip>
              {g.conn === "live" && relayed(g.link) ? <Text size="caption" tone="faint">relayed, fewer frames</Text> : null}
              {g.conn === "live" && latencyLabel(g.link) ? <Text size="caption" tone="faint" mono>{latencyLabel(g.link)}</Text> : null}
              {g.size && g.conn === "live" ? <Text size="caption" tone="faint" mono>{`${g.size.w} x ${g.size.h}`}</Text> : null}
              <View className="flex-1" />
              <Button kind="ghost" size="sm" label={g.fit ? "1:1" : "Fit"} onPress={() => g.setFitting(!g.fit)} />
            </View>
            <Text size="secondary" tone="muted">{g.mine ? (g.holder?.private ? `Sign in, then hand back. ${name} cannot see this page until you do.` : "You have control. Hand it back when you're done.") : g.other ? `${name} is paused while someone else drives.` : stateLine(name, g.info?.state ?? "")}</Text>
            {g.info ? <Text size="caption" tone="faint">{watchersLine(g.info.viewers)}</Text> : null}
            {g.mine ? (
              <View className="gap-s2">
                <View className="flex-row flex-wrap items-center gap-s2">
                  <Chip>{g.holder?.private ? "Signing in privately" : "You have control"}</Chip>
                  <Text mono size="caption">{g.holder?.since ? clock(now - g.holder.since) : ""}</Text>
                  {g.idleAt ? <Text size="caption" tone="warn">{`Handing back to ${name} in ${wait} s. Type or move to keep control.`}</Text> : null}
                </View>
                <Field label={`Note for ${name} (optional)`} value={note} onChangeText={setNote} />
                <View className="self-start"><Button kind="primary" label={`Hand back to ${name}`} disabled={g.busy} onPress={() => { void g.release(note).then(() => setNote("")); }} /></View>
              </View>
            ) : (
              <View className="flex-row flex-wrap gap-s2">
                <Button kind="ghost" label="Sign in privately" disabled={g.busy || Boolean(blocked)} onPress={() => setPriv(true)} />
                <Button kind="primary" label={g.busy ? "Taking over" : "Take over (T)"} disabled={g.busy || Boolean(blocked)} onPress={() => void g.take(false)} />
              </View>
            )}
            {!g.mine && blocked && g.conn !== "live" ? null : !g.mine && blocked ? <Text size="caption" tone="label">{blocked}</Text> : null}
            {priv ? (
              <Card>
                <View className="gap-s2">
                  <Text strong>Sign in privately</Text>
                  <Text size="secondary">{`While you sign in, ${name} cannot see or read the page: its hands stop, it takes no screenshots, and nothing you type reaches its thread. When you hand back, ${name} keeps the signed-in session, never the password.`}</Text>
                  <View className="flex-row gap-s2"><Button kind="ghost" size="sm" label="Cancel" onPress={() => setPriv(false)} /><Button kind="primary" size="sm" label="Start" onPress={() => { setPriv(false); void g.take(true); }} /></View>
                </View>
              </Card>
            ) : null}
          </View>
          <View className="min-w-0 flex-1 gap-s2" style={{ minWidth: 240 }}>
            {g.mine && g.holder ? (
              <Card>
                <View className="gap-s2">
                  <Text size="caption" strong tone="label">While you type</Text>
                  <Text strong>{holdingTitle(name, g.holder.private)}</Text>
                  {rows.map(([a, b, on]) => <View key={a} className="flex-row justify-between gap-s2"><Text size="secondary" tone={on ? undefined : "muted"}>{a}</Text><Text mono size="caption" tone={on ? "ok" : "faint"}>{b}</Text></View>)}
                  <Text size="caption" tone="label">{`${name} carries on from where it stopped and gets a note: who had the keyboard, for how long, and your note if you wrote one. Never what you typed. Ctrl+Enter hands back.`}</Text>
                </View>
              </Card>
            ) : (
              <View className="gap-s1">
                <Text size="caption" strong tone="label">Activity</Text>
                {g.log.length ? g.log.map((l) => <Text key={l.at + l.text} size="secondary"><Text mono size="caption" tone="faint">{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })}</Text>{`  ${l.text}`}</Text>)
                  : <Text size="secondary" tone="muted">Take-overs, hand-backs and who opens this screen show here while you watch.</Text>}
                <Text size="caption" tone="label">{`Take over pauses ${name}'s hands until you hand back. Sign in privately also hides the page from ${name}, for passwords.`}</Text>
              </View>
            )}
          </View>
        </View>
      </View>
      {tab === "files" || !g.hasScreen ? <FilesTab target={target} name={name} /> : null}
    </Frame>
  );
}
