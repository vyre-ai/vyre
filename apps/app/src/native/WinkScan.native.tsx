import { useCallback, useMemo, useRef } from "react";
import { WebView } from "react-native-webview";
import { useTheme } from "../theme/theme";
import { WINK_SCAN_HTML } from "./wink-scan-page.generated.js";
import { readScanMessage, type WinkScanEvent } from "./wink-scan-model";

/**
 * The camera reader for the drawn Wink code (ADR 0043): the Deck's own decoder in the system WebView, which opens the back camera and posts the 8-byte ticket once it reads
 * one. A WebView and not Hermes because a decode attempt is 1 to 2 s of JIT work (scripts/build-wink-scan.mjs). The page's base address is an https one, which makes it a
 * secure context, the one getUserMedia needs; it makes no request. Unmount stops the camera.
 */
/** The phone has a camera reader for the drawn code. */
export const canReadDrawnCode = true;

export function WinkScan({ onEvent, style }: { onEvent: (e: WinkScanEvent) => void; style?: object }) {
  const { color } = useTheme();
  const done = useRef(false);
  const source = useMemo(() => ({ html: WINK_SCAN_HTML.replace("__PAGE_BG__", color.bg), baseUrl: "https://vyre.run/" }), [color.bg]);
  const handle = useCallback((raw: string) => {
    const e = readScanMessage(raw);
    if (!e || done.current) return;
    if (e.type === "ticket") done.current = true; // one ticket, then nothing more from this page
    onEvent(e);
  }, [onEvent]);
  return (
    <WebView
      testID="wink-scan"
      source={source}
      originWhitelist={["https://vyre.run", "about:blank"]}
      onMessage={(e) => handle(e.nativeEvent.data)}
      style={[{ flex: 1, backgroundColor: color.bg }, style]}
      javaScriptEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      mediaCapturePermissionGrantType="grant"
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      setSupportMultipleWindows={false}
      allowFileAccess={false}
      // the page is inline and never navigates: only its own base URL (the first load) and about:blank pass, so nothing else can be loaded under the camera grant (reviewer-3, LOW)
      onShouldStartLoadWithRequest={(r) => r.url === "about:blank" || r.url === "https://vyre.run/"}
    />
  );
}
