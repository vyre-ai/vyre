// What the app uses of relay/client/qr.js: the module matrix of a QR code for printable ASCII text of at most 200 characters (it throws for anything else).
export function qrMatrix(text: string): boolean[][];
