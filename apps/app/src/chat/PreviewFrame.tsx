// A preview in a frame (phone): the system web view. Its canvas is the browser's own white (tokens.page.web), never the theme: a page that sets no background looks as it does anywhere else. Its sign-in is a top-level one for the web view, so its cookie works without a third-party exception.
import { WebView } from "react-native-webview";
import { tokens } from "../theme/tokens";

export function PreviewFrame({ src, title }: { src: string; title: string }) {
  return <WebView source={{ uri: src }} accessibilityLabel={title} style={{ flex: 1, backgroundColor: tokens.page.web }} originWhitelist={["https://*", "http://*"]} setSupportMultipleWindows={false} />;
}
