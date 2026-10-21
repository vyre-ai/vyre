import { Platform } from "react-native";
import { showToast } from "../components/Toast";
import { recordPath } from "./copy-value.js";

/** The browser's clipboard on the web, the phone's otherwise. */
export async function writeClipboard(text: string): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error("no clipboard");
  }
  const mod = await import("expo-clipboard");
  await mod.setStringAsync(text);
}

/** A link to the record: the full address on the web, the path otherwise. */
export function recordLink(id: string): string {
  const path = recordPath(id);
  if (Platform.OS === "web" && typeof location !== "undefined" && location.origin) return `${location.origin}${path}`;
  return path;
}

/** Copy text and say so. The toast is "Copied", or the same failure line the page has always used. */
export async function copyAndTell(text: string): Promise<void> {
  try {
    await writeClipboard(text);
    showToast("Copied");
  } catch {
    showToast("Copying did not work here. Select the text and copy it.");
  }
}
