// Notices with the app closed, Android: ask the native side (modules/vyre-notify) to hold the app's connection to the home in a foreground service, as the person wants. See keepalive-model.ts.
import { Linking, Platform } from "react-native";
import Notify from "../../modules/vyre-notify";
import { notifyState, requestNotify } from "./notify";
import { keepPlan, keepState, KEEP_SAY, keepTap, type KeepState } from "./keepalive-model.ts";

const android = Platform.OS === "android";
const read = async () => {
  const p = (await notifyState()).state;
  const permission = p === "granted" ? "granted" : p === "ask" ? "ask" : p === "denied" ? "denied" : "unavailable";
  const wanted = android && Notify?.keepAliveWanted ? await Notify.keepAliveWanted().catch(() => true) : true;
  return { android, permission, wanted } as const;
};

/** At start: do what the person wants about the kept connection (it is on until they turn it off, once notices are allowed). */
export async function syncKeepAlive(): Promise<void> {
  if (!android || !Notify) return;
  try {
    const plan = keepPlan(await read());
    if (plan === "start") await Notify.startKeepAlive?.();
    else if (plan === "stop") await Notify.stopKeepAlive?.();
  } catch { /* the native side is not there: notices come while the app is open */ }
}

/** The row in Settings. */
export async function noticeRow(): Promise<{ state: KeepState; value: string; line: string }> {
  const state = keepState(await read().catch(() => ({ android, permission: "unavailable", wanted: true }) as never));
  return { state, ...KEEP_SAY[state] };
}

/** A tap on the row: allow, turn on, turn off, or open the phone's settings. Returns the row as it reads now. */
export async function tapNotices(): Promise<{ state: KeepState; value: string; line: string }> {
  const now = (await noticeRow()).state;
  const act = keepTap(now);
  try {
    if (act === "ask") { await requestNotify(); await Notify?.startKeepAlive?.(); }
    else if (act === "turn-on") await Notify?.startKeepAlive?.();
    else if (act === "turn-off") await Notify?.stopKeepAlive?.();
    else if (act === "open-settings") void Linking.openSettings();
  } catch { /* unchanged */ }
  return noticeRow();
}
