import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// This phone's presence key (ADR 0018 section 3): ECDSA P-256 in the Secure Enclave, usable only
/// after Face ID or Touch ID with the currently enrolled biometrics. The private key never leaves
/// the Enclave; the Keychain holds only the Enclave's wrapped blob. The simulator has no Enclave, so
/// a DEBUG build there keeps a software P-256 key in the Keychain instead, with no biometric gate
/// (the rules forbid real OS dialogs on the Mac); a release build refuses to make one.
final class DeviceKey: Sendable {
    enum Backing: Sendable { case enclave(Data), software(Data) }

    static let account = "device-key"
    /// Signed message prefix, the same as the Capsule's.
    static let domain = "vyre-presence-v1"

    let backing: Backing
    /// x9.63 uncompressed public point, 65 bytes.
    let publicX963: Data

    var spki: Data { DeviceKey.spki(x963: publicX963) }
    var id: String { DeviceKey.keyId(spki: spki) }
    var isHardware: Bool { if case .enclave = backing { return true }; return false }

    init(backing: Backing) throws {
        self.backing = backing
        switch backing {
        case .enclave(let blob):
            publicX963 = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob).publicKey.x963Representation
        case .software(let raw):
            publicX963 = try P256.Signing.PrivateKey(rawRepresentation: raw).publicKey.x963Representation
        }
    }

    // MARK: storage

    static func load() -> DeviceKey? {
        guard let stored = Keychain.get(account), stored.count > 1 else { return nil }
        let body = stored.dropFirst()
        switch stored.first {
        case 0x01: return try? DeviceKey(backing: .enclave(Data(body)))
        case 0x02:
            #if DEBUG
            return try? DeviceKey(backing: .software(Data(body)))
            #else
            return nil
            #endif
        default: return nil
        }
    }

    /// Make and store a new key, replacing any old one.
    static func create() throws -> DeviceKey {
        // The simulator on Apple silicon reports an Enclave but refuses biometry-bound keys
        // (LocalAuthentication -1020), so it always takes the software key below.
        #if targetEnvironment(simulator)
        let enclave = false
        #else
        let enclave = SecureEnclave.isAvailable
        #endif
        if enclave {
            var err: Unmanaged<CFError>?
            guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                                                           [.privateKeyUsage, .biometryCurrentSet], &err) else {
                throw err!.takeRetainedValue() as Error
            }
            let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: ac)
            try Keychain.set(Data([0x01]) + key.dataRepresentation, for: account)
            return try DeviceKey(backing: .enclave(key.dataRepresentation))
        }
        #if DEBUG
        let key = P256.Signing.PrivateKey()
        try Keychain.set(Data([0x02]) + key.rawRepresentation, for: account)
        return try DeviceKey(backing: .software(key.rawRepresentation))
        #else
        throw DeviceKeyError.noEnclave
        #endif
    }

    static func delete() { Keychain.delete(account) }

    // MARK: encoding

    /// SubjectPublicKeyInfo DER for a P-256 key: the fixed header for id-ecPublicKey with
    /// prime256v1, then the BIT STRING holding the 65-byte point.
    static func spki(x963: Data) -> Data {
        // SEQUENCE(89) { SEQUENCE(19) { OID 1.2.840.10045.2.1, OID 1.2.840.10045.3.1.7 }, BIT STRING(66) 00 <point> }
        let header: [UInt8] = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
                               0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]
        return Data(header) + x963
    }

    /// First 22 characters of base64url(sha256(SPKI DER)), as core/presence names keys.
    static func keyId(spki: Data) -> String {
        String(Data(SHA256.hash(data: spki)).base64URL.prefix(22))
    }

    static func message(tool: String, hash: String, ts: Int64, nonce: String) -> Data {
        Data("\(domain)\n\(tool)\n\(hash)\n\(ts)\n\(nonce)".utf8)
    }

    static func nonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URL
    }

    // MARK: signing

    /// A DER ECDSA signature over `message`. On hardware this shows Face ID with `reason`.
    func sign(_ message: Data, reason: String) async throws -> Data {
        switch backing {
        case .software(let raw):
            return try P256.Signing.PrivateKey(rawRepresentation: raw).signature(for: message).derRepresentation
        case .enclave(let blob):
            let ctx = LAContext()
            ctx.localizedReason = reason
            ctx.localizedCancelTitle = "Cancel"
            var err: Unmanaged<CFError>?
            guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                                                           [.privateKeyUsage, .biometryCurrentSet], &err) else {
                throw err!.takeRetainedValue() as Error
            }
            do {
                _ = try await ctx.evaluateAccessControl(ac, operation: .useKeySign, localizedReason: reason)
            } catch let e as LAError where e.code == .userCancel || e.code == .appCancel || e.code == .systemCancel {
                throw VyreError.cancelled
            }
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
            return try key.signature(for: message).derRepresentation
        }
    }

    /// The `x-vyre-presence` value for one call: `device key=<id> ts=<ms> nonce=<n> sig=<b64url DER>`.
    func header(tool: String, input: JSON, reason: String, now: Date = Date()) async throws -> String {
        let ts = Int64((now.timeIntervalSince1970 * 1000).rounded())
        let nonce = DeviceKey.nonce()
        let msg = DeviceKey.message(tool: tool, hash: Canonical.inputHash(input), ts: ts, nonce: nonce)
        let sig = try await sign(msg, reason: reason)
        return "device key=\(id) ts=\(ts) nonce=\(nonce) sig=\(sig.base64URL)"
    }
}

enum DeviceKeyError: Error, LocalizedError {
    case noEnclave
    var errorDescription: String? { "This phone has no Secure Enclave, so it cannot hold a Vyre key." }
}

/// A `presence.session.open` session: several vault reveals in a row after one device proof.
/// Held in memory only, closed when the app leaves the screen.
actor PresenceSessions {
    struct Open: Sendable { let id: String; let secret: String; let expires: Date; let idle: TimeInterval; var used: Date }
    private var open: Open?

    func set(_ o: Open?) { open = o }
    func current(now: Date = Date()) -> Open? {
        guard var o = open else { return nil }
        if now >= o.expires || now.timeIntervalSince(o.used) >= o.idle { open = nil; return nil }
        o.used = now
        open = o
        return o
    }
    var isOpen: Bool { current() != nil }
}

/// The signer the client uses: the device key, and an open presence session when there is one.
struct DevicePresence: PresenceSigner {
    let key: DeviceKey
    let sessions: PresenceSessions

    func deviceHeader(tool: String, input: JSON, reason: String) async throws -> String {
        try await key.header(tool: tool, input: input, reason: reason)
    }

    func sessionHeader() async -> String? {
        guard let s = await sessions.current() else { return nil }
        return "session id=\(s.id) secret=\(s.secret)"
    }
}
