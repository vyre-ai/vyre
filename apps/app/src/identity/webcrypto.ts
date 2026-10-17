// The browser has WebCrypto. The phone's file of the same name (webcrypto.native.ts) fills the part of it the identity code uses.
// On the web the one gap is Ed25519 in an older browser (Chrome before 137, Safari before 17, Firefox before 129): the browser's own is used when it has it, and the same @noble verify the phone uses answers when it does not.
import { installEd25519Fallback } from "./webcrypto-web.js";

installEd25519Fallback(globalThis);
