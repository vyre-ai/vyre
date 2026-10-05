// The Mac app's shell, seen from the page: Lumen's window (local/capsule/native/Sources/Host/VyreAppWindow.swift) puts window.__vyreShell on the page
// it hosts. Where it is not there (a browser, a phone) every function here answers null and the app carries on with its own way.
import { shellCommand } from "./shell-model.js";

export type MacShell = {
  kind: "mac";
  /** The Mac app's window runs this page with no vyred of its own (On a server): the page pairs to the server by code. */
  boxless?: boolean;
  /** This Mac's identity key (Host/MacIdentity.swift): an Ed25519 key whose seed stays in the Mac's Keychain. The page gets the public key and signatures, never the seed. Values are base64url. */
  identity?: {
    public(create?: boolean): Promise<string>;
    sign(message: string): Promise<string>;
    has(): Promise<boolean>;
    forget(): Promise<void>;
    /** Settings' "Make this Mac a server": the Mac app runs its own setup (an explicit choice, never automatic). */
    makeServer?(): Promise<void>;
    /** The Secure Enclave key of this Mac's entry (Touch ID per signature): its raw uncompressed point, and a raw r||s signature. Absent or rejecting on a Mac with no Secure Enclave. */
    enclavePublic?(create?: boolean): Promise<string>;
    enclaveSign?(message: string, prompt: string): Promise<string>;
    /** This computer's agreement key (ECDH P-256, never leaves the OS keystore or hardware): its raw uncompressed point, and the 32-byte shared secret with a peer's point (both base64url). No prompt per use. */
    agreePublic?(create?: boolean): Promise<string>;
    agree?(epk: string): Promise<string>;
  };
  /** The version of this app, when the bridge says (a release candidate shows its own install line). */
  version?: string;
  /** The x-vyre-presence header for one call, from Touch ID (the person's own prompt). Rejects with plain words when it is refused. */
  presence(tool: string, input: Record<string, unknown>, summary?: string): Promise<string>;
  notify(title: string, body: string): Promise<unknown>;
  open(url: string): Promise<unknown>;
  /** Menu commands: a route, or "back" and "forward". Returns the stop. */
  onCommand(fn: (name: string) => void): () => void;
};

/** The identity key of the shell the page runs in, on a Mac (the app's window) or on Windows (the app's panel): the same four calls, a seed that never reaches the page. null in a browser or a phone. */
export type ShellIdentity = NonNullable<MacShell["identity"]>;
export function shellIdentity(): ShellIdentity | null {
  const w = typeof window === "undefined" ? null : (window as unknown as { __vyreShell?: { kind?: string; identity?: ShellIdentity } });
  const s = w?.__vyreShell;
  return s && (s.kind === "mac" || s.kind === "windows") && s.identity ? s.identity : null;
}

/** Is this page the Windows app's panel? It is a client: pairing, chats, the app, Windows Hello for the yes moments and its device key. Lending the computer and running agents on it are a later update. */
export function isWindowsShell(): boolean {
  return typeof window !== "undefined" && (window as unknown as { __vyreShell?: { kind?: string } }).__vyreShell?.kind === "windows";
}

/** What the person reads where lending this computer or running agents on it would be offered, in the Windows app. */
export const WINDOWS_LATER = "Lending this computer comes in a later update.";

/** The shell the page runs in, or null. (The Mac app's window: the one with a menu bar, Touch ID presence and notices. The Windows panel has none of those, only the identity key: `shellIdentity`.) */
export function shell(): MacShell | null {
  const w = typeof window === "undefined" ? null : (window as unknown as { __vyreShell?: MacShell });
  return w?.__vyreShell?.kind === "mac" ? w.__vyreShell : null;
}

/** Hook a menu command up to the router: a route goes to it, "back" and "forward" move through history. Returns the stop (a no-op outside the shell). */
export function listenCommands(go: (route: string) => void, back: () => void, forward: () => void): () => void {
  const s = shell();
  if (!s) return () => {};
  return s.onCommand((name) => {
    const c = shellCommand(name);
    if (c.kind === "route") go(c.route);
    else if (c.kind === "back") back();
    else if (c.kind === "forward") forward();
  });
}
