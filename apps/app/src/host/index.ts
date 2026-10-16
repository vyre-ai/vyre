// The in-page tool host's one door (host-core.js). A page with no daemon answers first run, unlock and lock itself: the hosted web app (web.vyre.run), and a build made for it (EXPO_PUBLIC_VYRE_HOST=1,
// which the first-run proof uses). The Mac and Windows windows join in the next stage. A page whose daemon answers (a box's own /app/, a phone paired to a server) never comes here.
import { Platform } from "react-native";
import { createHost } from "./host-core.js";
import { hostStore } from "./host-store";
import { relayUrl } from "../api/relay-url";

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

/** The GitHub leg, from the app's own sign-in (real/github.ts) and the relay's assertion route. */
const github = {
  async start() {
    const { signInWithGithub } = await import("../real/github");
    const r = await signInWithGithub({ signin: true });
    return r.ok ? { ok: true, session: r.session, user: { id: r.user.id, login: r.user.login } } : { ok: false, code: (r as { code?: string }).code };
  },
  async assert(session: { ticket: string; cv: string }, audience: string): Promise<string> {
    const base = (process.env.EXPO_PUBLIC_VYRE_RELAY_HTTP || relayUrl().replace(/^ws/, "http")).replace(/\/+$/, "");
    const res = await fetch(`${base}/v1/github/assert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: session.ticket, cv: session.cv, space: audience }) });
    const body = (await res.json().catch(() => null)) as { assertion?: string } | null;
    if (!res.ok || !body || typeof body.assertion !== "string") throw Object.assign(new Error("GitHub sign-in has run out. Start again."), { code: "expired" });
    return body.assertion;
  },
};

/** One id per browser, kept on this device and never secret: it only tells a space "the same browser again". localStorage on the web; a session's own when storage is refused. */
let sessionDeviceId = "";
async function deviceId(): Promise<string> {
  const KEY = "vyre.device-id";
  try { const kept = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null; if (kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept)) return kept; } catch { /* no storage */ }
  if (!sessionDeviceId) sessionDeviceId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, sessionDeviceId); } catch { /* no storage */ }
  return sessionDeviceId;
}

let host: ReturnType<typeof createHost> | null = null;
export function getHost() {
  if (!host) host = createHost({ store: hostStore, directory: directory(), github, signin: { deviceId } });
  return host;
}
