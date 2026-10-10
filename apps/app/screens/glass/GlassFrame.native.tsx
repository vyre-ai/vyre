import { useImperativeHandle, useRef } from "react";
import { WebView } from "react-native-webview";
import type { GlassFrameProps } from "./GlassFrame";
import { fromPage, toPage } from "./frame-bridge.js";

/**
 * The screen page in a WebView on the phone: the noVNC canvas lives in it, the app tells it what to do with a script (toPage) and hears it as strings (fromPage). The page is the box's own
 * (public/glass/frame.html), so the stream is the box's own origin: it works where the phone reaches the box directly (the same network or the tailnet). Navigation away from that origin is refused.
 */
export function GlassFrame({ src, onMessage, frameRef, label }: GlassFrameProps) {
  const web = useRef<WebView | null>(null);
  useImperativeHandle(frameRef, () => ({ post: (m) => web.current?.injectJavaScript(toPage(m)) }), []);
  let origin = "";
  try { origin = new URL(src).origin; } catch { /* a bad address loads nothing */ }
  return (
    <WebView
      ref={web}
      source={{ uri: src }}
      originWhitelist={origin ? [origin] : []}
      onShouldStartLoadWithRequest={(r) => Boolean(origin) && r.url.startsWith(origin)}
      onMessage={(e) => { const m = fromPage(e.nativeEvent.data); if (m) onMessage(m); }}
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
