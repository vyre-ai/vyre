// MacRelayKey: this Mac app's relay device key, the X25519 static key its window dials its servers with (relay/client: the Noise handshake, and the id a server knows this device by). The window's
// page used to keep it as a CryptoKey in IndexedDB, and the WKWebView gives a stored CryptoKey back as nothing, so every dial made a new key and a server never knew the app it had just paired (0.5.2).
// The key lives in the Mac's key bundle (KeyBundle.swift, slot `relay`, the login Keychain) and never reaches the page: the page asks for the public key and for the Diffie-Hellman with a peer's key,
// and the shell does both. There is no prompt per use: the app dials its servers all day, and a dial is not one of the yes moments. Software only: the Secure Enclave has no X25519.

import CryptoKit
import Foundation

final class MacRelayKey: @unchecked Sendable {
    let store: PresenceKeyStore
    init(store: PresenceKeyStore) { self.store = store }

    private func key() -> Curve25519.KeyAgreement.PrivateKey? {
        guard let raw = store.loadHandle(), raw.count == 32 else { return nil }
        return try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
    }

    /// The 32-byte public key. Made on first use with `create`; nil when there is none and `create` is false, or the Keychain would not keep a new one (a key that was not kept is never used).
    func publicKey(create: Bool) -> Data? {
        if let k = key() { return k.publicKey.rawRepresentation }
        guard create else { return nil }
        let k = Curve25519.KeyAgreement.PrivateKey()
        guard store.save(k.rawRepresentation), let kept = key() else { return nil }
        return kept.publicKey.rawRepresentation
    }

    /// X25519 with a peer's 32-byte public key: the raw 32-byte shared secret, as WebCrypto's deriveBits gives it. nil with no key, or for a peer key that is not 32 bytes or gives no secret.
    func dh(peer: Data) -> Data? {
        guard peer.count == 32, let k = key(), let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: peer),
              let shared = try? k.sharedSecretFromKeyAgreement(with: pub) else { return nil }
        return shared.withUnsafeBytes { Data($0) }
    }

    func forget() { store.delete() }
}
