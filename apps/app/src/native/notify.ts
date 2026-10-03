// Local notifications on the phone (expo-notifications). The permission flow and showing a notice
// are here; no push token is requested, stored or sent anywhere. See notify-model.ts for the
// transport interface that a person-owned push path would implement.

import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { cleanNotice, nullTransport, SAY, type Notice, type NotifyState, type PushTransport } from "./notify-model.ts";

export type { Notice, NotifyState, PushTransport } from "./notify-model.ts";
export { cleanNotice, nullTransport, SAY } from "./notify-model.ts";

let transport: PushTransport = nullTransport;
/** Plug in a transport the person owns. None by default. */
export const setTransport = (t: PushTransport) => void (transport = t);
export const activeTransport = () => transport;

const CHANNEL = "needs-you";
let ready = false;

async function setup() {
  if (ready) return;
  ready = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: "Needs you", importance: Notifications.AndroidImportance.DEFAULT });
  }
}

const stateOf = (p: { granted: boolean; canAskAgain: boolean; status: string }): NotifyState =>
  p.granted ? "granted" : p.status === "undetermined" || p.canAskAgain ? "ask" : "denied";

export async function notifyState(): Promise<{ state: NotifyState; say: string }> {
  try {
    const state = stateOf(await Notifications.getPermissionsAsync());
    return { state, say: SAY[state] };
  } catch {
    return { state: "unavailable", say: SAY.unavailable };
  }
}

/** Ask for permission (the system prompt shows only when the person has not decided). */
export async function requestNotify(): Promise<{ state: NotifyState; say: string }> {
  try {
    await setup();
    const state = stateOf(await Notifications.requestPermissionsAsync());
    return { state, say: SAY[state] };
  } catch {
    return { state: "unavailable", say: SAY.unavailable };
  }
}

/** Show a notice now. False when it was empty or permission is not given. */
export async function showLocal(n: Notice): Promise<boolean> {
  const c = cleanNotice(n);
  if (!c || (await notifyState()).state !== "granted") return false;
  await setup();
  await Notifications.scheduleNotificationAsync({
    identifier: c.id,
    content: { title: c.title, body: c.body, data: c.route ? { route: c.route } : {} },
    trigger: Platform.OS === "android" ? { channelId: CHANNEL } : null,
  });
  return true;
}

/** Calls `go(route)` when the person taps a notice. Returns the unsubscribe. */
export function onTap(go: (route: string) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    const route = (r.notification.request.content.data as { route?: unknown } | undefined)?.route;
    if (typeof route === "string" && route.startsWith("/")) go(route);
  });
  return () => sub.remove();
}
