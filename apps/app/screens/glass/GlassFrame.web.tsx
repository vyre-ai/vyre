import { createElement, useEffect, useImperativeHandle, useRef } from "react";
import type { GlassFrameProps } from "./GlassFrame";

/** The screen page in an iframe: the noVNC canvas lives in it, messages go over postMessage, and only this frame's own are heard. */
export function GlassFrame({ src, onMessage, frameRef, label }: GlassFrameProps) {
  const el = useRef<HTMLIFrameElement | null>(null);
  const on = useRef(onMessage);
  on.current = onMessage;
  useImperativeHandle(frameRef, () => ({ post: (m) => el.current?.contentWindow?.postMessage(m, location.origin) }), []);
  useEffect(() => {
    const h = (e: MessageEvent) => { if (e.source && e.source === el.current?.contentWindow && e.origin === location.origin && e.data && typeof e.data === "object") on.current(e.data); };
    window.addEventListener("message", h);
    return () => window.removeEventListener("message", h);
  }, []);
  return createElement("iframe", { ref: el, src, title: label, style: { border: 0, width: "100%", height: "100%", display: "block", background: "transparent" } });
}
