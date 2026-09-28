// VaultStore: what this device keeps about its pairing.
//
// - The vyred address, the device token, the device id and name: generic-password items in the
//   Keychain, in the access group the host app and the extension share. The group comes from
//   the Info.plist key VyreKeychainGroup, "$(AppIdentifierPrefix)sh.vyre.shared", which only
//   expands in a build signed by a team. Unsigned (simulator, CI) it is left out and each target
//   gets its own default group, so pairing in the host does not reach the extension there.
// - The session (the fill window): memory only, in this process. The extension's process ends
//   soon after each request, so a new request usually starts locked and asks for Face ID.
//   Ended early when the device locks.

import Foundation
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

public final class VaultStore {
  public static let shared = VaultStore()

  public let accessGroup: String?
  private let service = "sh.vyre.autofill"
  private let lock = NSLock()
  private var session: (token: String, expires: Double)?
  private var observers: [NSObjectProtocol] = []

  public init(bundle: Bundle = .main) {
    accessGroup = AutofillCore.keychainGroup(bundle.object(forInfoDictionaryKey: "VyreKeychainGroup") as? String)
    observeLock()
  }

  deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }

  // MARK: - pairing

  public var server: String? { read("server") }
  public var token: String? { read("device-token") }
  public var deviceName: String? { read("device-name") }
  public var isPaired: Bool { server != nil && token != nil }

  public func savePairing(server: String, paired: Paired) throws {
    try write("server", server)
    try write("device-token", paired.token)
    try write("device-id", paired.device)
    try write("device-name", paired.name)
  }

  /// Forget the pairing: the token, the address, the device key and the session.
  public func forget() {
    for a in ["server", "device-token", "device-id", "device-name"] { remove(a) }
    DeviceKey.delete(accessGroup: accessGroup)
    endSession()
  }

  /// A client for the paired vyred, with the live session if there is one.
  public func client() throws -> FillClient {
    guard let s = server, let t = token, let c = FillClient(server: s, token: t, session: liveSession()) else { throw FillError("not_paired") }
    return c
  }

  // MARK: - the session, in memory

  public func liveSession(nowMs: Double = Date().timeIntervalSince1970 * 1000) -> String? {
    lock.lock(); defer { lock.unlock() }
    guard let s = session else { return nil }
    if AutofillCore.isLive(expiresMs: s.expires, nowMs: nowMs) { return s.token }
    session = nil
    return nil
  }

  public func setSession(_ token: String, expires: Double) {
    lock.lock(); session = (token, expires); lock.unlock()
  }

  public func endSession() {
    lock.lock(); session = nil; lock.unlock()
  }

  private func observeLock() {
    #if os(iOS)
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: nil) { [weak self] _ in
      self?.endSession()
    })
    #elseif os(macOS)
    let ws = NSWorkspace.shared.notificationCenter
    observers.append(ws.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: nil) { [weak self] _ in self?.endSession() })
    observers.append(ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { [weak self] _ in self?.endSession() })
    observers.append(DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: nil) { [weak self] _ in
      self?.endSession()
    })
    #endif
  }

  // MARK: - keychain

  private func base(_ account: String) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecUseDataProtectionKeychain as String: true,
    ]
    if let g = accessGroup { q[kSecAttrAccessGroup as String] = g }
    return q
  }

  private func read(_ account: String) -> String? {
    var q = base(account)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }

  private func write(_ account: String, _ value: String) throws {
    remove(account)
    var q = base(account)
    q[kSecValueData as String] = Data(value.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw FillError("keychain") }
  }

  private func remove(_ account: String) {
    SecItemDelete(base(account) as CFDictionary)
  }
}
