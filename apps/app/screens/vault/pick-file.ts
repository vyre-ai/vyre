// Choosing a file to import on a phone: the system file picker (Files, iCloud, Drive). The bytes are read once into base64 and handed back; nothing is stored. The web build has its own (pick-file.web.ts).
import * as DocumentPicker from "expo-document-picker";
import type { Picked } from "./import-source";

export const canPick = true;

/** The extensions a source offers, as the picker's types: it takes MIME types, and any type when a source lists none it knows. */
const MIME: Record<string, string> = { ".csv": "text/csv", ".json": "application/json", ".xml": "text/xml", ".zip": "application/zip", ".txt": "text/plain" };
const typesOf = (accept: string): string[] => {
  const t = [...new Set(accept.split(",").map((a) => MIME[a.trim()]).filter(Boolean))];
  // a 1pux, dash or .env file has no MIME type the system knows: offer every file
  return /\.(1pux|dash|env)/.test(accept) || !t.length ? ["*/*"] : [...t, "application/octet-stream"];
};

/** Open the system file picker. Null when the person closes it. */
export async function pickFile(accept: string): Promise<Picked | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: typesOf(accept), copyToCacheDirectory: true, multiple: false });
  const a = r.canceled ? null : r.assets?.[0];
  if (!a) return null;
  const blob = await (await fetch(a.uri)).blob();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const s = String(reader.result ?? ""); resolve(s.slice(s.indexOf(",") + 1)); };
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(blob);
  });
  return { name: a.name, base64 };
}
