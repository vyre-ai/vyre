"use dom";
// A PDF, drawn with react-pdf (MIT; pdf.js is Apache-2.0). This is the one DOM-only renderer: on the web it is an ordinary component, on a phone Expo runs it in a web view ("use dom"), so the props are plain
// data (the bytes as base64). The pdf.js worker is a file the export copies next to the app (scripts/pdf-worker.mjs, public/pdf/), served from the app's own address.
import { useMemo, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";

pdfjs.GlobalWorkerOptions.workerSrc = `${process.env.EXPO_PUBLIC_VYRE_APP_BASE === "root" ? "" : "/app"}/pdf/pdf.worker.min.mjs`;

const bar = { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#888" } as const;
const btn = { font: "inherit", padding: "4px 10px", borderRadius: 8, border: "1px solid rgba(128,128,128,.35)", background: "transparent", color: "inherit", cursor: "pointer" } as const;

export default function PdfDom({ base64, width = 720 }: { base64: string; width?: number; dom?: import("expo/dom").DOMProps }) {
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const file = useMemo(() => ({ data: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) }), [base64]);
  if (failed) return <div style={{ ...bar, padding: 16 }}>This PDF could not be drawn. Download it to open it.</div>;
  return (
    <div style={{ width: "100%", height: "100%", overflow: "auto", background: "rgba(128,128,128,.12)" }}>
      <div style={{ ...bar, position: "sticky", top: 0, zIndex: 1, background: "rgba(128,128,128,.2)", backdropFilter: "blur(6px)" }}>
        <span>{pages ? `${pages} ${pages === 1 ? "page" : "pages"}` : "Opening"}</span>
        <span style={{ flex: 1 }} />
        <button style={btn} aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}>{"−"}</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button style={btn} aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}>+</button>
      </div>
      <Document file={file} onLoadSuccess={(d) => setPages(d.numPages)} onLoadError={() => setFailed(true)} loading="" error="">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: 12 }}>
          {Array.from({ length: pages }, (_, i) => (
            <Page key={i} pageNumber={i + 1} width={Math.round(width * zoom)} renderTextLayer={false} renderAnnotationLayer={false} />
          ))}
        </div>
      </Document>
    </div>
  );
}
