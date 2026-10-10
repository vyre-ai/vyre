import { useEffect, useImperativeHandle, useRef } from "react";
import { WebView } from "react-native-webview";
import type { GlassFrameProps } from "./GlassFrame";
import { fromPage, toPage } from "./frame-bridge.js";
import { createWsBridge, webviewShim } from "@vyre/relay-client/wsbridge.js";
import { lazySocket } from "./lazy-socket.js";
import { socket } from "../../src/api/box";
import { FRAME_PAGE } from "../../src/glass/frame-page.generated";

/** A page message that belongs to the socket shim (an `open`, `send` or `close` of a numbered socket), not to the frame's own wire. */
const isSocketMessage = (m: any) => m && typeof m === "object" && Number.isInteger(m.id) && (m.t === "open" || m.t === "send" || m.t === "close");

/**
 * The screen page in a WebView on the phone: the noVNC canvas lives in it, the app tells it what to do with a script (toPage) and hears it as strings (fromPage).
 * Where the phone reaches the box directly (the same network or the tailnet) the page is the box's own (public/glass/frame.html) and its stream is the box's own origin; navigation away from that origin is refused.
 * Away from the server (`relay`) there is no origin to load it from: the page is bundled into the app (frame-page.generated.ts), its WebSocket is replaced by a shim, and the app carries the stream's bytes on the relay
 * channel (relay/client/wsbridge.js, contracts/glass-relay.md).
 */
export function GlassFrame({ src, onMessage, frameRef, label, relay }: GlassFrameProps) {
  const web = useRef<WebView | null>(null);
  const send = (m: unknown) => web.current?.injectJavaScript(`window.__vyreWs(${JSON.stringify(m)});true;`);
  const bridge = useRef<ReturnType<typeof createWsBridge> | null>(null);
  if (relay && !bridge.current) bridge.current = createWsBridge({ open: (path: string) => lazySocket((p) => socket(p), path), post: send });
  useEffect(() => () => { bridge.current?.closeAll(); bridge.current = null; }, []);
  useImperativeHandle(frameRef, () => ({ post: (m) => web.current?.injectJavaScript(toPage(m)) }), []);
  let origin = "";
  try { origin = new URL(src).origin; } catch { /* a bad address loads nothing */ }
  const hear = (raw: string) => {
    if (relay) { try { const m = JSON.parse(raw); if (isSocketMessage(m)) { bridge.current?.fromPage(raw); return; } } catch { /* the frame's own wire below */ } }
    const m = fromPage(raw);
    if (m) onMessage(m);
  };
  return (
    <WebView
      ref={web}
      {...(relay ? { source: { html: FRAME_PAGE, baseUrl: "about:blank" }, originWhitelist: ["about:*"], injectedJavaScriptBeforeContentLoaded: webviewShim(), onShouldStartLoadWithRequest: (r: { url: string }) => r.url === "about:blank" }
        : { source: { uri: src }, originWhitelist: origin ? [origin] : [], onShouldStartLoadWithRequest: (r: { url: string }) => Boolean(origin) && r.url.startsWith(origin) })}
      onMessage={(e) => hear(e.nativeEvent.data)}
      javaScriptEnabled
      domStorageEnabled={false}
      setSupportMultipleWindows={false}
      scrollEnabled={false}
      bounces={false}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction
      accessibilityLabel={label}
      style={{ flex: 1, backgroundColor: "transparent" }}
    />
  );
}
