// Types for names/worker/id-messages.js (the bytes an identity entry signs for the directory), for the app's type check.
export const RECORD_TAG: string;
export const ALIAS_TAG: string;
export const ACT_TAG: string;
export function recordMessage(m: { name: string; id: string; by: string; via?: string; ts: number | string; sealedHash: string; vseq?: number; vhead?: string }): Uint8Array;
export function aliasMessage(m: { name: string; domain: string; id: string }): Uint8Array;
export function actMessage(m: { action: string; name: string; domain?: string; ts: number | string }): Uint8Array;
