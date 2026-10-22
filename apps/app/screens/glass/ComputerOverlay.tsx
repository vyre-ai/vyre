// The agent's computer over the whole window: the screen, a bar with Take over and Sign in privately, and close. Nothing else from the old Glass page.
// Escape closes it. Escape while this window holds the keyboard hands it back first; the next Escape closes.
import { useEffect, useRef } from "react";
import { Platform, View } from "react-native";
import { Button, IconButton, Text, useUiTheme } from "@vyre/ui";
import { elevation } from "../../ui/lib/elevation";
import { PortalHere } from "../../src/chat/PortalHere";
import { GlassFrame } from "./GlassFrame";
import { overText, whyBlocked } from "./model";
import { frameUrl, relayOnly, useGlass } from "./state";

const QUIET = new Set(["live", "hidden", "connecting", "waiting"]);

export function ComputerOverlay({ agent, onClose }: { agent: string; onClose: () => void }) {
  const g = useGlass(agent, `computer:${agent}`);
  const { color, resolved } = useUiTheme();
  const hold = useRef(false);
  hold.current = g.mine;
  const latched = useRef(false);
  const release = useRef(g.release);
  release.current = g.release;
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => { if (!g.mine) latched.current = false; }, [g.mine]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (hold.current && !latched.current) { latched.current = true; void release.current(""); return; }
      close.current();
    };
    const docs = new Set<Document>();
    const hook = (doc: Document | null | undefined) => {
      if (!doc || docs.has(doc)) return;
      docs.add(doc);
      doc.addEventListener("keydown", onKey, true);
    };
    hook(document);
    const label = `${agent}'s screen`;
    const watch = () => {
      const frame = document.querySelector(`iframe[title="${label}"]`);
      if (frame instanceof HTMLIFrameElement) { try { hook(frame.contentDocument); } catch { /* a frame that is not ours */ } }
    };
    watch();
    const id = setInterval(watch, 400);
    return () => { clearInterval(id); for (const doc of docs) doc.removeEventListener("keydown", onKey, true); };
  }, [agent]);

  const blocked = whyBlocked(g.holder, g.surface, g.conn === "live");
  const [title, detail] = overText(g.conn, agent, g.why);
  const showErr = Boolean(g.info) && !QUIET.has(g.conn);
  const unknown = g.loaded === "ready" && !g.info;
  const off = g.loaded === "missing" || g.loaded === "offline";
  return (
    <PortalHere>
      <View style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 80, backgroundColor: color.bg } as any}>
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} accessibilityLabel={`Live view of ${agent}'s screen`}>
          <GlassFrame src={frameUrl()} relay={relayOnly()} onMessage={g.onFrame} frameRef={g.frame} label={`${agent}'s screen`} />
        </View>
        {unknown || off || showErr ? (
          <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 72, alignItems: "center", justifyContent: "center", padding: 24 }}>
            <Text strong>{unknown ? `Glass does not know a computer for ${agent}.` : off ? (g.loaded === "offline" ? "Your server is not answering." : "No server is paired with this device, so there is no screen to watch.") : title}</Text>
            {!unknown && !off && detail ? <Text size="secondary" tone="muted">{detail}</Text> : null}
          </View>
        ) : null}
        <View style={{ position: "absolute", top: 12, right: 12 }}>
          <IconButton icon="x" label="Close" kind="secondary" onPress={onClose} />
        </View>
        <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 16, alignItems: "center" }}>
          <View style={[{ flexDirection: "row", alignItems: "center", gap: 8, padding: 8, borderRadius: 12, borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"] }, elevation(resolved.scheme, 2)]}>
            <Button size="sm" kind={g.mine ? "secondary" : "primary"} label={g.mine ? "Hand back" : "Take over"} disabled={g.busy || (!g.mine && Boolean(blocked))} onPress={() => { if (g.mine) void g.release(""); else void g.take(false); }} />
            <Button size="sm" kind="secondary" label="Sign in privately" disabled={g.busy || (!g.mine && Boolean(blocked))} onPress={() => void g.take(true)} />
          </View>
          {g.notice && g.notice.tone === "err" ? <Text size="caption" tone="warn">{g.notice.text}</Text> : null}
        </View>
      </View>
    </PortalHere>
  );
}
