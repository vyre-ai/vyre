import CryptoKit
import Foundation
import Security

/// The push key this phone gave the box at `push.subscribe`: 32 random bytes, kept in the shared
/// Keychain so the notification service extension can open the sealed part (ADR 0018 section 4).
enum PushKeyStore {
    static let account = "push-key"

    static func load() -> SymmetricKey? {
        guard let d = Keychain.get(account, shared: true), d.count == 32 else { return nil }
        return SymmetricKey(data: d)
    }

    /// A new random key, stored readable after first unlock (a push can arrive while locked).
    static func make() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw KeychainError(status: -1) }
        let d = Data(bytes)
        try Keychain.set(d, for: account, shared: true, access: .afterFirstUnlock)
        return d
    }

    static func delete() { Keychain.delete(account, shared: true) }
}

/// The sealed part of a native push: AES-256-GCM over the JSON `{path, tag, at}`, sent as
/// `sealed` = base64url(nonce 12 bytes | ciphertext | tag 16 bytes) beside the fixed `aps` alert.
/// Apple sees the kind and a fixed sentence, never an id.
enum PushSeal {
    struct Opened: Equatable, Sendable { let path: String; let tag: String?; let at: Double? }

    static func open(_ sealed: String, key: SymmetricKey) -> Opened? {
        guard let data = Data(base64URL: sealed), data.count > 28,
              let box = try? AES.GCM.SealedBox(combined: data),
              let plain = try? AES.GCM.open(box, using: key),
              let obj = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
              let path = obj["path"] as? String, path.hasPrefix("/") else { return nil }
        return Opened(path: path, tag: obj["tag"] as? String, at: (obj["at"] as? NSNumber)?.doubleValue)
    }

    /// The box's side, for tests: seal `{path, tag, at}` under the key.
    static func seal(path: String, tag: String, at: Double, key: SymmetricKey) throws -> String {
        let plain = try JSONSerialization.data(withJSONObject: ["path": path, "tag": tag, "at": at])
        return try AES.GCM.seal(plain, using: key).combined!.base64URL
    }
}
