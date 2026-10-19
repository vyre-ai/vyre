// The one way the app opens an address outside itself (a sign-in page, a docs link, GitHub). The Mac app's window blocks pop-ups and ignores the web's own "open" for some links, but its shell has a call that hands an
// https link to the person's browser (Host/VyreAppWindow.swift, "open"), so that is tried first; a browser opens a tab; a phone uses the system. Only http, https and mailto addresses are opened.
import { shell } from "../shell/shell.ts";

/** Is this an address the app may open outside itself? */
export const openable = (url: string): boolean => /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(String(url || "").trim());

/** Open an address in the person's browser. Resolves true when something was asked to open it, false when it was refused or blocked (so the screen can show the link to copy). @param url */
export async function openLink(url: string): Promise<boolean> {
  const u = String(url || "").trim();
  if (!openable(u)) return false;
  try {
    const s = shell();
    if (s && typeof s.open === "function") { await s.open(u); return true; }
    // react-native is loaded only here, after the shell had its chance (and so a test of the shell path needs no renderer)
    const { Linking, Platform } = await import("react-native");
    if (Platform.OS === "web") { const w = window.open(u, "_blank", "noopener,noreferrer"); return w !== null; }
    await Linking.openURL(u);
    return true;
  } catch { return false; }
}

/** A sign-in page opened beside the app: a small window in a browser (so the app stays in view), the person's browser in the Mac app (its window opens no pop-ups). @param url @param name the window's name */
export async function openAside(url: string, name: string): Promise<boolean> {
  if (!openable(url)) return false;
  if (shell() || typeof window === "undefined" || (await import("react-native")).Platform.OS !== "web") return openLink(url);
  const w = window.open(url, name, "width=520,height=720");
  return w !== null ? true : openLink(url);
}
