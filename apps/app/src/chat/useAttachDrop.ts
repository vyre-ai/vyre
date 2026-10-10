import type { Picked } from "./attach-pick";
/** On a phone there is no paste or drop of files: nothing to listen for. The browser's is useAttachDrop.web.ts. */
export function useAttachDrop(_add: (files: Picked[]) => void | Promise<void>): void {}
