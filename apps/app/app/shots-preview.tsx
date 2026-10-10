// Sample world only: a preview of a page that sets no background of its own, in the frame, for the screenshot pass (light and dark). The frame's canvas is the browser's white in both: the page is never recoloured.
import { View } from "react-native";
import { ThemeProvider, Text } from "@vyre/ui";
import { PreviewFrame } from "../src/chat/PreviewFrame";

const PAGE = "data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><body style='margin:0;padding:24px;font:16px/1.5 system-ui,sans-serif'><h1 style='margin:0 0 8px'>Tell us about your case</h1><p>This page sets no background. It looks the same in a browser, in the light theme and in the dark one.</p><button>Send it</button></body>");

export default function ShotsPreview() {
  return (
    <ThemeProvider>
      <View style={{ padding: 20, gap: 12, maxWidth: 760 }}>
        <Text tone="label" size="caption">Preview of a page with no background</Text>
        <View style={{ height: 320, borderWidth: 1 }}><PreviewFrame src={PAGE} title="Sample page" /></View>
      </View>
    </ThemeProvider>
  );
}
