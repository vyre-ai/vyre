// One session: the 0.3 chat screen on the real session stream (src/chat, core/stream), with the
// session's terminal beside it on a desktop and full screen on a phone (src/terminal). `demo` is the
// same screen on the mock stream. The old transcript path is gone;
// reached from here; its Transcript list is what the chat screen virtualises with.

import { useCallback, useMemo, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Text as UiText, ThemeProvider, useUiTheme } from "@vyre/ui";
import ChatDemo from "../chat-demo";
import { call, boxOrigin } from "../../src/api/box";
import { ChatScreen } from "../../src/chat/ChatScreen";
import { useGlassFor } from "../../src/state/glass";
import { useNeeds } from "../../src/state/needs";
import { COPY } from "../../src/state/glass-model.js";
import { useThread } from "../../src/state/threads";
import { tokens } from "../../src/theme/tokens";
import { GlassCard, GlassPill, useScreenFocused } from "../../src/ui/GlassMini";
import { IconButton } from "../../src/ui/IconButton";
import { DEFAULT_FRAME_URL } from "../../src/terminal/Terminal";
import { TerminalPane } from "../../src/terminal/TerminalPane";
import { TerminalScreen } from "../../src/terminal/TerminalScreen";

/** /session/demo is the chat screen on the mock stream; every other id is a box session on the real stream. */
export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return /^demo(-three|-people|-assistant)?$/.test(String(id)) ? <ChatDemo sample={String(id)} /> : <ThemeProvider><BoxSession thread={String(id)} /></ThemeProvider>;
}

/** This screen's name for the terminal: a ticket is bound to the surface that asked for it (core/term). */
const SURFACE = `${Platform.OS === "web" ? "deck" : "phone"}:app${Math.random().toString(36).slice(2, 8)}`;

type Term = { id: string; reason: string | null };

function BoxSession({ thread }: { thread: string }) {
  const router = useRouter();
  const { phone } = useUiTheme();
  const listed = useThread(thread);
  const [term, setTerm] = useState<Term | null>(null);
  const [termNote, setTermNote] = useState<string | null>(null);
  const [width, setWidth] = useState(520);

  const openTerminal = useCallback(async () => {
    setTermNote(null);
    if (!boxOrigin()) return setTermNote("The terminal needs a direct connection to the box; this one is over the relay.");
    const r = await call<{ term: string }>("term.open", { session: thread, surface: SURFACE });
    if (r.error) return setTermNote(r.error.message || "Could not open a terminal.");
    setTerm({ id: r.data.term, reason: null });
  }, [thread]);

  // A fresh one-use ticket for this terminal at byte offset `from`, as a ws URL on the box's own origin.
  const getTicket = useCallback(
    async (from: number) => {
      if (!term) throw new Error("no terminal");
      const r = await call<{ path: string }>("term.attach", { term: term.id, surface: SURFACE, from });
      if (r.error) throw new Error(r.error.message || r.error.code);
      return { url: boxOrigin().replace(/^http/, "ws") + r.data.path };
    },
    [term],
  );
  // The WebView on a phone loads the terminal page from the box; on the web the app's own copy serves it.
  const frameUrl = Platform.OS === "web" || !boxOrigin() ? undefined : boxOrigin() + DEFAULT_FRAME_URL;
  const title = listed?.name ?? "Session";
  const handlers = useMemo(() => ({ onFaceId: async () => true, onOpenTerminal: () => void openTerminal() }), [openTerminal]);
  const guts = useMemo(() => <ThreadGlass agent={listed?.agent ?? null} thread={thread} />, [listed?.agent, thread]);

  const chat = (
    <ChatScreen
      sessionId={thread}
      title={title}
      belowHeader={guts}
      onBack={() => router.back()}
      onBranched={(id) => router.push({ pathname: "/u/chats/[id]", params: { id } })}
      onOpenTerminal={() => void openTerminal()}
      handlers={handlers}
    />
  );
  const common = term ? { getTicket, frameUrl, title, subtitle: listed?.projectName ?? undefined } : null;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ flex: 1, minWidth: 0 }}>{chat}</View>
        {term && common && !phone ? <TerminalPane {...common} width={width} onWidth={setWidth} onClose={() => setTerm(null)} /> : null}
      </View>
      {term && common && phone ? (
        <View style={StyleSheet.absoluteFill}>
          <TerminalScreen {...common} onBack={() => setTerm(null)} />
        </View>
      ) : null}
      {termNote ? (
        <View pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, bottom: 96 }}>
          <UiText size="caption" tone="label" style={{ textAlign: "center" }}>{termNote}</UiText>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The thread's agent's computer under the header (glass-mini.md): the Card, collapsible to the Pill
 * by its own icon button ("Hide screen", "Show screen"). Nothing when the agent has no computer.
 */
function ThreadGlass({ agent, thread }: { agent: string | null; thread: string }) {
  const view = useGlassFor(agent);
  const focused = useScreenFocused();
  const [open, setOpen] = useState(true);
  const needs = useNeeds();
  if (!view) return null;
  const waiting = needs.find((n) => n.thread === thread || (!n.thread && n.agent === agent))?.title ?? null;
  const G = tokens.layout.gutterPhone;
  return (
    <View style={[styles.glass, { paddingLeft: G, paddingRight: G - tokens.space[3] }]}>
      <View style={styles.glassBody}>
        {open ? <GlassCard view={view} waiting={waiting} visible={focused} here={thread} /> : <GlassPill view={view} waiting={waiting} here={thread} />}
      </View>
      {/* The icon set has no chev-u: Hide is chev-d turned over. */}
      <View style={open ? styles.flip : null}>
        <IconButton icon="chev-d" size="touch" accessibilityLabel={open ? COPY.hide : COPY.show} onPress={() => setOpen((o) => !o)} testID="glass-toggle" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  glass: { flexDirection: "row", alignItems: "flex-start", gap: tokens.space[3], paddingVertical: tokens.space[3] },
  glassBody: { flex: 1, minWidth: 0, justifyContent: "center", minHeight: tokens.control.touch },
  flip: { transform: [{ rotate: "180deg" }] },
});
