// What the app uses of relay/client/avatarcode.js: the typed Wink code a drawn avatar carries (the camera reader's 8 bytes, WINK-NNPP-PPPP).
export function avatarBytesToCode(bytes: ArrayLike<number>): string | null;
export function codeToAvatarBytes(code: string): Uint8Array | null;
