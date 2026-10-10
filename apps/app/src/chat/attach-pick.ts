// Choosing files to add to a message on a phone: the system file picker (Files, iCloud, Drive) or the photo library. The bytes are read once into base64 and handed back; nothing is stored here.
// The web build has its own (attach-pick.web.ts).
import * as DocumentPicker from "expo-document-picker";

export type Picked = { name: string; mime: string; bytes: number; base64: string };
export const canPick = true;

const readBase64 = async (uri: string): Promise<{ base64: string; bytes: number }> => {
  const blob = await (await fetch(uri)).blob();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const s = String(reader.result ?? ""); resolve(s.slice(s.indexOf(",") + 1)); };
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(blob);
  });
  return { base64, bytes: blob.size };
};

/** Open the system picker. `photo` offers pictures only. An empty list when the person closes it. */
export async function pickFiles(photo: boolean): Promise<Picked[]> {
  const r = await DocumentPicker.getDocumentAsync({ type: photo ? ["image/*"] : ["*/*"], copyToCacheDirectory: true, multiple: true });
  if (r.canceled) return [];
  const out: Picked[] = [];
  for (const a of r.assets ?? []) {
    const { base64, bytes } = await readBase64(a.uri);
    out.push({ name: a.name, mime: a.mimeType || "application/octet-stream", bytes, base64 });
  }
  return out;
}
