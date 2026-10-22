"use dom";
// A PowerPoint file (.pptx), as the text of its slides. DOM-only: the zip is read here, inflated with the browser's own
// DecompressionStream, and shown in an iframe with sandbox="". No script from the file runs. A browser without that
// stream shows the download note instead.
import { useEffect, useState } from "react";

function unescapeXml(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function inflate(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream !== "function") throw new Error("no inflate");
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

/** Slide text from a pptx zip. Local headers only; a missing inflater fails the whole draw. */
async function slideText(raw: Uint8Array): Promise<string[]> {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: string[] = [];
  let i = 0;
  while (i + 30 <= raw.length) {
    if (dv.getUint32(i, true) !== 0x04034b50) { i += 1; continue; }
    const method = dv.getUint16(i + 8, true);
    const comp = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extra = dv.getUint16(i + 28, true);
    const nameAt = i + 30;
    const dataAt = nameAt + nameLen + extra;
    if (dataAt + comp > raw.length) break;
    const name = new TextDecoder().decode(raw.subarray(nameAt, nameAt + nameLen));
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
      const data = raw.subarray(dataAt, dataAt + comp);
      const xml = method === 0 ? new TextDecoder().decode(data) : await inflate(data);
      for (const m of xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)) out.push(unescapeXml(m[1]));
    }
    i = dataAt + comp || i + 1;
  }
  return out;
}

export default function PptxDom({ base64, ink = "inherit" }: { base64: string; ink?: string; dom?: import("expo/dom").DOMProps }) {
  const [html, setHtml] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    slideText(raw).then((lines) => {
      if (!live) return;
      const body = lines.length ? lines.map((t) => `<p>${escapeHtml(t)}</p>`).join("") : "<p>This deck has no text to show.</p>";
      setHtml(`<!doctype html><meta charset="utf-8"><body style="margin:16px;font-family:system-ui,sans-serif">${body}</body>`);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [base64]);
  if (failed) return <div style={{ padding: 16, fontFamily: "system-ui, sans-serif", fontSize: 14, color: ink }}>This presentation could not be drawn. Download it to open it.</div>;
  return <iframe sandbox="" srcDoc={html} title="Presentation" style={{ width: "100%", height: "100%", border: 0, background: "transparent" }} />;
}
