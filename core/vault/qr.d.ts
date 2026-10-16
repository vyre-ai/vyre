/** Types for the plain encoder in qr.js. The app paints the modules; this file only types the door. */
export function encode(input: string | Uint8Array, o?: { mask?: number; version?: number }): { version: number; mask: number; size: number; modules: boolean[][] };
export function functionMask(version: number): boolean[][];
export function toSvg(modules: boolean[][], o?: { quiet?: number; px?: number; color?: string }): string;
