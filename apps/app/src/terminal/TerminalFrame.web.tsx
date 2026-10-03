import { createElement, useEffect, useImperativeHandle, useRef } from "react";
import type { FrameProps } from "./TerminalFrame";

/** The terminal page in an iframe: messages go over postMessage, and only this frame's own are heard. */
export function TerminalFrame({ src, onMessage, background, frameRef, testID }: FrameProps) {
  const el = useRef<HTMLIFrameElement | null>(null);
  const on = useRef(onMessage);
  on.current = onMessage;
  useImperativeHandle(frameRef, () => ({ post: (m) => el.current?.contentWindow?.postMessage(m, "*") }), []);
  useEffect(() => {
    const h = (e: MessageEvent) => { if (e.source && e.source === el.current?.contentWindow && e.data && typeof e.data === "object") on.current(e.data); };
    window.addEventListener("message", h);
    return () => window.removeEventListener("message", h);
  }, []);
  return createElement("iframe", { ref: el, src, title: "Terminal", "data-testid": testID, style: { border: 0, width: "100%", height: "100%", display: "block", background: background || "transparent" }, allow: "clipboard-read; clipboard-write" });
}
