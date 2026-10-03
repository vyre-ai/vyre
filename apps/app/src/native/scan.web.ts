// The web build of scan.ts. A browser can read a code from a photo with BarcodeDetector where it
// has one (Chrome, Edge, Android); otherwise the screen says to paste the link instead. No live
// camera view here: ScanCamera is null and scanProps does nothing.

import { onceEach, support, type ScanSupport, type ScannedCode } from "./scan-model.ts";

export type { ScannedCode, ScanSupport, CameraState } from "./scan-model.ts";
export { readCode } from "./scan-model.ts";

export const ScanCamera = null;
export const canScanLive = false;

type Detector = { detect(img: ImageBitmapSource): Promise<{ rawValue: string }[]> };
const detector = (): Detector | null => {
  const D = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  return D ? new D({ formats: ["qr_code"] }) : null;
};

export async function cameraSupport(): Promise<ScanSupport> {
  return support("unavailable");
}
export const requestCamera = cameraSupport;

export function scanProps(_onCode: (c: ScannedCode) => void) {
  return {};
}

/** True when this browser can read a code from a picture. */
export const canReadPhoto = (): boolean => detector() !== null;

/** Read a code from a picture the person chose (an <input type="file" accept="image/*">). Null when there is none to read. */
export async function readPhoto(file: Blob, handle: (c: ScannedCode) => void): Promise<boolean> {
  const d = detector();
  if (!d) return false;
  const found = await d.detect(await createImageBitmap(file));
  const once = onceEach(handle);
  for (const f of found) once(f.rawValue);
  return found.length > 0;
}
