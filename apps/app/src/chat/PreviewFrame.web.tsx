// A preview in a frame (web: the Mac app's window and every browser). Its address is on its own origin, so the page cannot reach Vyre; the sandbox keeps it from navigating the app away, and lets it do what a page does
// (scripts, forms, downloads, its own storage).
import { createElement } from "react";
import { useUiTheme } from "@vyre/ui";

export function PreviewFrame({ src, title }: { src: string; title: string }) {
  const { color } = useUiTheme();
  return createElement("iframe", { src, title, sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads", allow: "clipboard-write", style: { border: 0, width: "100%", height: "100%", display: "block", background: color.panel } });
}
