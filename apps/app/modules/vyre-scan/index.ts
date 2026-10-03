// The camera and the QR view on Android (see android/). expo-camera is not linked there.
import { requireOptionalNativeModule, requireNativeViewManager } from "expo";

export type PermissionState = { granted: boolean; canAskAgain: boolean; status: string };

type Native = { getPermission(): Promise<PermissionState>; requestPermission(): Promise<PermissionState> };

/** Null where there is no native side. */
export const VyreScan = requireOptionalNativeModule<Native>("VyreScan");
export const VyreScanView = VyreScan ? requireNativeViewManager("VyreScan") : null;
