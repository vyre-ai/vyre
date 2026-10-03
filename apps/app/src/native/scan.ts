// Scanning a Wink code with the phone's camera (expo-camera). The screen draws <ScanCamera/> with
// scanProps(onCode) and asks for access with requestCamera() first. Web has scan.web.ts.

import { Camera, CameraView } from "expo-camera";
import { onceEach, support, type CameraState, type ScanSupport, type ScannedCode } from "./scan-model.ts";

export type { ScannedCode, ScanSupport, CameraState } from "./scan-model.ts";
export { readCode } from "./scan-model.ts";

/** The camera view; give it scanProps(onCode). */
export const ScanCamera = CameraView;

const stateOf = (r: { granted: boolean; canAskAgain: boolean; status: string }): CameraState =>
  r.granted ? "granted" : r.status === "undetermined" || r.canAskAgain ? "ask" : "denied";

/** Where camera access stands, without asking. */
export async function cameraSupport(): Promise<ScanSupport> {
  try {
    return support(stateOf(await Camera.getCameraPermissionsAsync()));
  } catch {
    return support("unavailable");
  }
}

/** Ask for the camera (the system prompt shows only when the person has not decided). */
export async function requestCamera(): Promise<ScanSupport> {
  try {
    return support(stateOf(await Camera.requestCameraPermissionsAsync()));
  } catch {
    return support("unavailable");
  }
}

/** Props for ScanCamera: QR only, each code handed over once. */
export function scanProps(onCode: (c: ScannedCode) => void) {
  const once = onceEach(onCode);
  return {
    facing: "back" as const,
    barcodeScannerSettings: { barcodeTypes: ["qr" as const] },
    onBarcodeScanned: (e: { data: string }) => once(e.data),
  };
}

/** The camera path exists on this build. */
export const canScanLive = true;
