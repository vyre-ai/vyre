// The web and the other platforms have no kept connection for notices (the installed web app has Web Push; the iPhone shows a notice when the app opens).
import type { KeepState } from "./keepalive-model.ts";
export async function syncKeepAlive(): Promise<void> {}
export async function noticeRow(): Promise<{ state: KeepState; value: string; line: string }> { return { state: "unavailable", value: "", line: "" }; }
export async function tapNotices(): Promise<{ state: KeepState; value: string; line: string }> { return noticeRow(); }
