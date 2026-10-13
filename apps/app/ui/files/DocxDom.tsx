"use dom";
// A Word document (.docx), drawn by docx-preview (Apache-2.0) onto white pages the way Word shows them. DOM-only, so it is a "use dom" component: on the web an ordinary one, on a phone in a web view.
// The document is data and is never run: docx-preview builds elements from the file's text and styles, and the viewer shows nothing that can script.
import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";

export default function DocxDom({ base64 }: { base64: string; dom?: import("expo/dom").DOMProps }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const el = box.current;
    if (!el) return;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    renderAsync(bytes.buffer as ArrayBuffer, el, undefined, { inWrapper: true, ignoreWidth: false, ignoreHeight: true, breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, useBase64URL: true })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; el.innerHTML = ""; };
  }, [base64]);
  if (failed) return <div style={{ padding: 16, fontFamily: "system-ui, sans-serif", fontSize: 14, color: "#888" }}>This document could not be drawn. Download it to open it.</div>;
  return <div style={{ width: "100%", height: "100%", overflow: "auto", background: "rgba(128,128,128,.18)" }}><div ref={box} /></div>;
}
