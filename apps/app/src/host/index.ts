// The in-page tool host's one door (host-core.js). A page with no daemon answers first run, unlock and lock itself: the hosted web app (web.vyre.run), and a build made for it (EXPO_PUBLIC_VYRE_HOST=1,
// which the first-run proof uses). Stage 2 adds the space steps (create a space with the one install line, wait for the server, show the paired server). The Mac and Windows windows join in the next stage. A page whose daemon answers (a box's own /app/, a phone paired to a server) never comes here.
import { Platform } from "react-native";
import { createHost } from "./host-core.js";
import { hostStore } from "./host-store";
import { spacePorts } from "./space-ports";

const HOSTED = /^web\.vyre\.run$/i;

/** Is this page one with no daemon of its own, which answers the first-run tools itself? */
export function hostWanted(): boolean {
  if (Platform.OS !== "web") return false;
  if (typeof process !== "undefined" && process.env.EXPO_PUBLIC_VYRE_HOST === "1") return true;
  return typeof location !== "undefined" && HOSTED.test(location.hostname);
}

function directory(): string {
  const set = typeof process !== "undefined" ? process.env.EXPO_PUBLIC_VYRE_NAMES : "";
  return set || "https://names.vyre.run";
}

let host: ReturnType<typeof createHost> | null = null;
export function getHost() {
  if (!host) host = createHost({ store: hostStore, directory: directory(), space: { load: spacePorts } });
  return host;
}
