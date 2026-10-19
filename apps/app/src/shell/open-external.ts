// Open a link outside the app (see open-external-model.js): the Mac app's own open, else a window, else the system. Every window.open and Linking.openURL in the app goes through here.
import { Linking, Platform } from "react-native";
import { shell } from "./shell";
import { openExternalWith, openableUrl, type Opened } from "./open-external-model.js";

export { openableUrl };

/** Open `url`. `name` and `features` make a small sign-in window in a browser. Answers whether something took the link; when not, show it as text to copy. */
export function openExternal(url: string, o: { name?: string; features?: string } = {}): Promise<Opened> {
  const s = shell();
  const web = Platform.OS === "web" && typeof window !== "undefined";
  return openExternalWith(url, o, {
    shellOpen: s ? (u) => s.open(u) : null,
    windowOpen: web ? (u, name, features) => window.open(u, name, features) : null,
    linkingOpen: (u) => Linking.openURL(u),
  });
}
