// The Android build of scan.ts: modules/vyre-scan (CameraX and ZXing) instead of expo-camera, which
// needs ML Kit and Google Play services. Same exports as scan.ts.

import { createElement } from "react";
import { VyreScan, VyreScanView } from "../../modules/vyre-scan";
import { onceEach, support, type CameraState, type ScanSupport, type ScannedCode } from "./scan-model.ts";

export type { ScannedCode, ScanSupport, CameraState } from "./scan-model.ts";
export { readCode } from "./scan-model.ts";

type ViewProps = { style?: unknown; onBarcodeScanned?: (e: { data: string }) => void };

/** The camera view; give it scanProps(onCode). */
export const ScanCamera = (p: ViewProps) =>
  VyreScanView ? createElement(VyreScanView as never, { style: p.style, onCode: (e: { nativeEvent: { data: string } }) => p.onBarcodeScanned?.({ data: e.nativeEvent.data }) } as never) : null;

const stateOf = (r: { granted: boolean; canAskAgain: boolean; status: string }): CameraState =>
  r.granted ? "granted" : r.status === "undetermined" || r.canAskAgain ? "ask" : "denied";

/** Where camera access stands, without asking. */
export async function cameraSupport(): Promise<ScanSupport> {
  try {
    return support(stateOf(await VyreScan!.getPermission()));
  } catch {
    return support("unavailable");
  }
}

/** Ask for the camera (the system prompt shows only when the person has not decided). */
export async function requestCamera(): Promise<ScanSupport> {
  try {
    return support(stateOf(await VyreScan!.requestPermission()));
  } catch {
    return support("unavailable");
  }
}

/** Props for ScanCamera: QR only, each code handed over once. */
export function scanProps(onCode: (c: ScannedCode) => void) {
  const once = onceEach(onCode);
  return { onBarcodeScanned: (e: { data: string }) => once(e.data) };
}

/** The camera path exists on this build. */
export const canScanLive = true;
