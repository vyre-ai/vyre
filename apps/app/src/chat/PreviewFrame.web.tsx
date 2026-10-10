// A preview in a frame (web: the Mac app's window and every browser). Its address is on its own origin, so the page cannot reach Vyre; the sandbox keeps it from navigating the app away, and lets it do what a page does
// (scripts, forms, downloads, its own storage). Its canvas is the browser's own white (tokens.page.web), never the theme: a page that sets no background looks as it does anywhere else.
import { createElement } from "react";
import { tokens } from "../theme/tokens";

export function PreviewFrame({ src, title }: { src: string; title: string }) {
  return createElement("iframe", { src, title, sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads", allow: "clipboard-write", style: { border: 0, width: "100%", height: "100%", display: "block", background: tokens.page.web } });
}
