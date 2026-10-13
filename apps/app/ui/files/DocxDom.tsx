"use dom";
// A Word document (.docx), drawn by docx-preview (Apache-2.0) onto white pages the way Word shows them. DOM-only, so it is a "use dom" component: on the web an ordinary one, on a phone in a web view.
// The document is data and is never run: docx-preview builds elements from the file's text and styles, and the viewer shows nothing that can script.
import { useEffect, useState } from "react";
import { renderAsync } from "docx-preview";
import { neutralise } from "./neutralise.js";

export default function DocxDom({ base64, ink = "inherit" }: { base64: string; ink?: string; dom?: import("expo/dom").DOMProps }) {
  const [failed, setFailed] = useState(false);
  const [html, setHtml] = useState("");
  useEffect(() => {
    let live = true;
    // Drawn off screen, made inert (neutralise.js), then shown in an iframe with sandbox="": a hostile file can run nothing and reach nothing, whatever its links say.
    const el = document.createElement("div");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    renderAsync(bytes.buffer as ArrayBuffer, el, undefined, { inWrapper: true, ignoreWidth: false, ignoreHeight: true, breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, useBase64URL: true })
      .then(() => { if (live) { neutralise(el); setHtml(`<!doctype html><meta charset="utf-8"><body style="margin:0">${el.innerHTML}</body>`); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [base64]);
  if (failed) return <div style={{ padding: 16, fontFamily: "system-ui, sans-serif", fontSize: 14, color: ink, opacity: 0.6 }}>This document could not be drawn. Download it to open it.</div>;
  return <iframe sandbox="" srcDoc={html} title="Document" style={{ width: "100%", height: "100%", border: 0, background: "transparent" }} />;
}
