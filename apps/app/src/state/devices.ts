import { create } from "zustand";
import { CAPS } from "@vyre/chat-core/caps.js";
import { call, listen } from "../api/box";
import { about, deviceName, loadPairing } from "../api/relay";
import { onConnection } from "./connection";
import { readDevices, reopened, trustOf, type Device, type Trust } from "./devices-model";

// This device's trust and the box's device list (relay.devices.list), for Vault and Devices.
// Started by the first screen that reads it. Refreshed in place, never with a reload:
//   - when the stream comes back open: the box closes a browser's relay channel with
//     "trust changed", the relay client dials again, and the stream reopens on the new channel
//   - on any device.* event (paired, removed)
//   - after this device changes a trust, and after the box refuses this browser a secret

/** The proposed tool behind "Ask to trust" (TrustBrowser board note 3). Not built on the box yet. */
export const ASK_TRUST = "relay.devices.ask_trust";

type DevicesState = {
  devices: Device[] | null;
  /** This device's relay id, from its pairing; null for the native app off the relay, and the box-served app. */
  self: string | null;
  /** The box refused this browser a secret. */
  denied: boolean;
  loading: boolean;
  error: string | null;
  /** "Ask to trust" was sent from here. */
  asked: boolean;
};

const useStore = create<DevicesState>()(() => ({ devices: null, self: null, denied: false, loading: false, error: null, asked: false }));
const set = useStore.setState;
const get = useStore.getState;

let started = false;
let inflight: Promise<void> | null = null;

export function refreshDevices(): Promise<void> {
  return (inflight ??= (async () => {
    set({ loading: true });
    try {
      const r = await call<unknown>("relay.devices.list").catch((e: Error) => ({ error: { code: "offline", message: e.message } }) as const);
      if (r.error) set({ error: r.error.message || r.error.code });
      else {
        const devices = readDevices(r.data);
        const me = devices.find((d) => d.id === get().self);
        // A trust that landed clears the refusal; the list is the box's word.
        set({ devices, error: null, ...(me?.trusted ? { denied: false, asked: false } : {}) });
      }
    } finally {
      set({ loading: false });
      inflight = null;
    }
  })());
}

function start() {
  if (started) return;
  started = true;
  void loadPairing().then((p) => {
    set({ self: p?.device ?? null });
    void refreshDevices();
  });
  let was: string | null = null;
  onConnection((s) => {
    const now = s.stream?.state ?? null;
    if (reopened(was, now)) void refreshDevices();
    was = now;
  });
  listen((e) => {
    if (e.type.startsWith("device.")) void refreshDevices();
  });
}

/** The device list, started on first read. */
export function useDevices() {
  start();
  return useStore((s) => s.devices);
}

export const useDevicesError = () => useStore((s) => s.error);
export const useDevicesLoading = () => useStore((s) => s.loading);
export const useAsked = () => useStore((s) => s.asked);

/** This device's trust, recomputed from the list, its id and any refusal. */
export function useTrust(): Trust {
  start();
  return useStore((s) => trustOf({ kind: about.kind, self: s.self, devices: s.devices, denied: s.denied }));
}

/** This browser's name as the Mac's Devices lists it. */
export function useSelfName(): string {
  return useStore((s) => s.devices?.find((d) => d.id === s.self)?.name ?? deviceName());
}

/** The id of this device on the list, for "This browser" on its row. */
export const useSelf = () => useStore((s) => s.self);

/** The box refused this browser a secret: show the card now, and read the list again. */
export function markDenied(): void {
  set({ denied: true });
  void refreshDevices();
}

/**
 * Trust a browser, or stop trusting it. The box asks presence: the phone proves it with its
 * biometric key (the person session answers presence_required once), a browser shows the box's
 * refusal. Resolves with the refusal's words, or null when it went through.
 */
export async function setTrust(id: string, trusted: boolean): Promise<string | null> {
  const r = await call<{ id: string; trusted: boolean }>("relay.devices.trust", { id, trusted }).catch((e: Error) => ({ error: { code: "offline", message: e.message } }) as const);
  if (r.error) {
    if (r.error.code === "presence_required") return "The box asks for presence to change trust. Do it from your Mac or phone.";
    return r.error.message || r.error.code;
  }
  const list = get().devices;
  if (list) set({ devices: list.map((d) => (d.id === id ? { ...d, trusted: r.data.trusted } : d)) });
  void refreshDevices();
  return null;
}

/** Whether the box has the proposed ask tool: only once it answered it (chat core caps.js). */
export function canAskTrust(): boolean {
  return CAPS.has(ASK_TRUST) === true;
}

/** Ask the trusted devices to trust this browser (proposed tool; hidden until the box has it). */
export async function askTrust(): Promise<string | null> {
  const self = get().self;
  const r = await CAPS.use(ASK_TRUST, () => call(ASK_TRUST, self ? { id: self } : {}).catch((e: Error) => ({ error: { code: "offline", message: e.message } })));
  if (r.error) return r.missing ? null : r.error.message || r.error.code;
  set({ asked: true });
  return null;
}
