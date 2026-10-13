// The web build's drop zone: a file dropped on it, or chosen with a click, is read in the browser and handed over as text. Nothing is uploaded until Save.
import { useRef, useState } from "react";
import { Icon, Text } from "@vyre/ui";
import type { DropProps } from "./DropZone";

export function DropZone({ label, accept, done, error, onText }: DropProps) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const read = (file: File | undefined) => { if (file) file.text().then((t) => onText(t, file.name)).catch(() => onText("", file.name)); };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Text size="caption" strong tone="label">{label}</Text>
      <div role="button" tabIndex={0} aria-label={`${label}: drop a file or press Enter to choose one`}
        onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); read(e.dataTransfer.files?.[0]); }}
        style={{ cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 88, padding: 16, borderRadius: 14, boxSizing: "border-box", textAlign: "center",
          border: `1px dashed ${over ? "var(--edge-strong)" : "var(--edge)"}`, background: over ? "var(--hover)" : "var(--surface-3)" }}>
        <Icon name="upload" tone="text-2" size={20 as never} />
        <Text tone={done ? "default" : "label"}>{done || "Drop the file here, or choose it"}</Text>
      </div>
      <input ref={input} type="file" accept={accept} style={{ display: "none" }} onChange={(e) => { read(e.target.files?.[0]); e.target.value = ""; }} />
      {error ? <Text size="caption" tone="err">{error}</Text> : null}
    </div>
  );
}
