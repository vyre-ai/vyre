import { useImperativeHandle, useRef } from "react";
import { WebView } from "react-native-webview";
import type { FrameProps } from "./TerminalFrame";

/** The terminal page in a WebView: the same page and the same messages as the web iframe. Needs react-native-webview in the build. */
export function TerminalFrame({ src, onMessage, background, frameRef, testID }: FrameProps) {
  const web = useRef<WebView | null>(null);
  useImperativeHandle(frameRef, () => ({ post: (m) => web.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent("message",{data:${JSON.stringify(JSON.stringify(m))}}));true;`) }), []);
  return (
    <WebView
      ref={web}
      testID={testID}
      source={{ uri: src }}
      originWhitelist={["*"]}
      onMessage={(e) => { try { onMessage(JSON.parse(e.nativeEvent.data)); } catch {} }}
      style={{ flex: 1, backgroundColor: background || "transparent" }}
      containerStyle={{ backgroundColor: background || "transparent" }}
      overScrollMode="never"
      bounces={false}
      scrollEnabled={false}
      hideKeyboardAccessoryView
      keyboardDisplayRequiresUserAction={false}
      automaticallyAdjustContentInsets={false}
      setSupportMultipleWindows={false}
    />
  );
}
