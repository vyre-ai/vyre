// A preview in a frame (phone): the system web view. Its sign-in is a top-level one for the web view, so its cookie works without a third-party exception.
import { WebView } from "react-native-webview";
import { useUiTheme } from "@vyre/ui";

export function PreviewFrame({ src, title }: { src: string; title: string }) {
  const { color } = useUiTheme();
  return <WebView source={{ uri: src }} accessibilityLabel={title} style={{ flex: 1, backgroundColor: color.panel }} originWhitelist={["https://*", "http://*"]} setSupportMultipleWindows={false} />;
}
