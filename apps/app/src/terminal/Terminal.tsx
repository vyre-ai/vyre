import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useUiTheme } from "@vyre/ui";
import { TerminalFrame, type FrameHandle } from "./TerminalFrame";
import { MONO, termTheme } from "./theme";

export type TermState = { state: "idle" | "connecting" | "live" | "reconnecting" | "ended" | "closed"; offset: number; owner: boolean; cols: number; rows: number; reason?: string };

export type TerminalHandle = {
  /** Keys, as bytes (keys.js builds them for the accessory row). */
  sendKeys: (d: string) => void;
  /** Text as the terminal would paste it (bracketed when the program asked for it). */
  paste: (d: string) => void;
  /** Copy the selection (or the screen when nothing is selected) to the clipboard. Resolves to the text. */
  copy: () => Promise<string>;
  /** Make this screen the one that sizes the terminal. */
  take: () => void;
  /** Arm or disarm sticky ctrl: the next key typed on the keyboard is sent as its control byte. */
  setCtrl: (on: boolean) => void;
  focus: () => void;
  /** Reconnect now (the app came to the front). */
  nudge: () => void;
  /** Text size in px; the pinch gesture sets it too (onFont tells the host). */
  setFont: (px: number) => void;
};

export type TerminalProps = {
  /**
   * A fresh one-use ticket as a ws(s) URL, for the terminal at byte offset `from`: term.attach { term, surface, from } then the box's
   * origin + path (the path already carries from). The Terminal calls it on first connect and on every reconnect.
   */
  getTicket: (from: number) => Promise<{ url: string }>;
  /** Where the terminal page is served: the app's own /app/term/frame.html on the web; the box's address plus that path in a phone's WebView. */
  frameUrl?: string;
  fontSize?: number;
  onState?: (s: TermState) => void;
  /** The program turned application-cursor keys on or off (full-screen programs: vim, less): the accessory row's arrows follow it. */
  onAppCursor?: (on: boolean) => void;
  onSelection?: (text: string) => void;
  onFont?: (px: number) => void;
  /** The armed ctrl was used by a typed key (so the accessory row lets go of it). */
  onCtrlDone?: () => void;
  testID?: string;
};

export const DEFAULT_FRAME_URL = "/app/term/frame.html";

/**
 * A terminal: xterm.js drawing the bytes of a term socket (core/term), resumable by byte offset, in the app's colours.
 * One implementation on every device: the page in public/term is an iframe on the web and a WebView on a phone.
 * Compose it: TerminalPane (desktop) and TerminalScreen (phone) wrap it; a screen can use it bare.
 */
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(p, ref) {
  const { color, resolved } = useUiTheme();
  const frame = useRef<FrameHandle | null>(null);
  const props = useRef(p);
  props.current = p;
  const [ready, setReady] = useState(false);
  const theme = termTheme(color, resolved.scheme);
  const copied = useRef<((t: string) => void) | null>(null);

  const post = useCallback((m: Record<string, unknown>) => frame.current?.post(m), []);

  useImperativeHandle(ref, () => ({
    sendKeys: (d) => post({ t: "key", d }),
    paste: (d) => post({ t: "paste", d }),
    copy: () => new Promise<string>((resolve) => { copied.current = resolve; post({ t: "copy" }); setTimeout(() => { if (copied.current === resolve) { copied.current = null; resolve(""); } }, 1500); }),
    take: () => post({ t: "take" }),
    setCtrl: (on) => post({ t: "ctrl", on }),
    focus: () => post({ t: "focus" }),
    nudge: () => post({ t: "nudge" }),
    setFont: (px) => post({ t: "font", px }),
  }), [post]);

  // Colours and type go to the page once it is up ("init", which also connects), and again when the app's theme changes ("theme").
  const started = useRef(false);
  useEffect(() => {
    if (!ready) return;
    post({ t: started.current ? "theme" : "init", theme, fontSize: p.fontSize ?? 13, fontFamily: MONO });
    started.current = true;
  }, [ready, resolved.scheme, theme.background, theme.foreground, p.fontSize]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMessage = useCallback((m: any) => {
    const cur = props.current;
    switch (m.t) {
      case "ready": setReady(true); break;
      case "ticket":
        cur.getTicket(Number(m.from) || 0).then((r) => post({ t: "ticket", id: m.id, url: r.url }), (e) => post({ t: "ticket", id: m.id, error: String(e && e.message || e) }));
        break;
      case "state": cur.onState?.({ state: m.state, offset: m.offset, owner: m.owner, cols: m.cols, rows: m.rows, reason: m.reason }); break;
      case "mode": cur.onAppCursor?.(Boolean(m.appCursor)); break;
      case "selection": cur.onSelection?.(String(m.text || "")); break;
      case "ctrl": if (!m.on) cur.onCtrlDone?.(); break;
      case "font": cur.onFont?.(Number(m.px)); break;
      case "copied": {
        const text = String(m.text || "");
        // The page copies on the web itself; a phone's WebView cannot, so the app does.
        if (text) Clipboard.setStringAsync(text).catch(() => {});
        copied.current?.(text); copied.current = null;
        break;
      }
    }
  }, [post]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }} testID={p.testID}>
      <TerminalFrame src={p.frameUrl ?? DEFAULT_FRAME_URL} onMessage={onMessage} background={theme.background} frameRef={frame} />
    </View>
  );
});
