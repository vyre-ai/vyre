// Local notices on the phone, made by the app itself (modules/vyre-notify on Android: the
// platform NotificationManager, no push service, no Google Play services). The permission flow and
// showing a notice are here; no push token is requested, stored or sent anywhere. See
// notify-model.ts for the transport interface that a person-owned push path would implement.
// On Android a notice while the app is closed comes over Vyre's own connection (see
// docs/work/native-core.md, "Notices when the app is closed").

import { Linking, Platform } from "react-native";
import Notify, { type PermissionState } from "../../modules/vyre-notify";
import { cleanNotice, nullTransport, SAY, type Notice, type NotifyState, type PushTransport } from "./notify-model.ts";

export type { Notice, NotifyState, PushTransport } from "./notify-model.ts";
export { cleanNotice, nullTransport, SAY } from "./notify-model.ts";

let transport: PushTransport = nullTransport;
/** Plug in a transport the person owns. None by default. */
export const setTransport = (t: PushTransport) => void (transport = t);
export const activeTransport = () => transport;

const stateOf = (p: PermissionState): NotifyState =>
  p.granted ? "granted" : p.status === "undetermined" || p.canAskAgain ? "ask" : "denied";

export async function notifyState(): Promise<{ state: NotifyState; say: string }> {
  try {
    const state = stateOf(await Notify!.getPermission());
    return { state, say: SAY[state] };
  } catch {
    return { state: "unavailable", say: SAY.unavailable };
  }
}

/** Ask for permission (the system prompt shows only when the person has not decided). */
export async function requestNotify(): Promise<{ state: NotifyState; say: string }> {
  try {
    const state = stateOf(await Notify!.requestPermission());
    return { state, say: SAY[state] };
  } catch {
    return { state: "unavailable", say: SAY.unavailable };
  }
}

/** Show a notice now. False when it was empty or permission is not given. */
export async function showLocal(n: Notice): Promise<boolean> {
  const c = cleanNotice(n);
  if (!c || (await notifyState()).state !== "granted") return false;
  return (Platform.OS === "android" || Platform.OS === "ios") && Notify ? Notify.show(c.id, c.title, c.body ?? null, c.route ?? null) : false;
}

/** Calls `go(route)` when the person taps a notice. Returns the unsubscribe. A tap opens vyre://<route>?notice=1. */
export function onTap(go: (route: string) => void): () => void {
  const sub = Linking.addEventListener("url", ({ url }) => {
    const m = /^vyre:\/\/([^?#]*)\?(?:[^#]*&)?notice=1/.exec(url);
    if (m) go("/" + m[1].replace(/^\/+/, ""));
  });
  return () => sub.remove();
}
