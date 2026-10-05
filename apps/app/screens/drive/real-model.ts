// Bytes and text from a Drive file's base64 (the Space's own Drive: SpaceDrive.tsx). No runtime function the phone's JS engine may lack.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** base64 to bytes, with no runtime function the phone's JS engine may lack. */
export function bytesOf(b64: string): number[] {
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const c of b64.replace(/=+$/, "")) {
    const v = B64.indexOf(c);
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return out;
}
/** UTF-8 text from bytes; bytes that are not valid UTF-8 come out as the replacement mark, never as an error. */
export function textOf(bytes: number[]): string {
  let s = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    const n = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
    if (!n || i + n > bytes.length) { s += "�"; i += 1; continue; }
    let cp = n === 1 ? b : b & (0xff >> (n + 1));
    let ok = true;
    for (let k = 1; k < n; k++) { const x = bytes[i + k]; if ((x & 0xc0) !== 0x80) { ok = false; break; } cp = (cp << 6) | (x & 0x3f); }
    s += ok ? String.fromCodePoint(cp) : "�";
    i += ok ? n : 1;
  }
  return s;
}
