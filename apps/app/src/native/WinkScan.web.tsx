import type { WinkScanEvent } from "./wink-scan-model";

/** A browser reads the drawn code with the Deck's own camera page (web/js/scan.js), not this component: nothing to draw here. */
export const canReadDrawnCode = false;

export function WinkScan(_: { onEvent: (e: WinkScanEvent) => void; style?: object }) {
  return null;
}
