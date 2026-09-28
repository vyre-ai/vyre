// The pure half of Vyre autofill on iOS and macOS: Swift standard library only, no Foundation,
// no Apple frameworks, so Tests/ covers it without a device and it could build on Linux. It is
// the sibling of modules/vault-android/.../AutofillCore.kt. Everything that decides something
// lives here:
//
//   - origin(serviceIdentifier:kind:): the one string a password fill is held to (ADR 0028,
//     threat model and decision 6). A .domain or .URL service identifier becomes
//     https://<host>, with a non-default port kept. Exact origins only: the server matches the
//     whole origin and nothing here ever widens it to a parent domain.
//   - plan(_:): the identities route's list mapped to what goes into ASCredentialIdentityStore,
//     honouring `users: "names"`.
//   - unlockMessage(_:) and messageToSign(challenge:message:): the device-key challenge. The key
//     signs only a message of the exact shape vyred's challenge route makes, whatever a server
//     sends.
//   - serverURL(_:): the vyred address, https only, or http://127.0.0.1.
//   - base64url, SPKI wrapping of a raw P-256 public key, and the session clock.
//
// Nothing in this file ever sees a password, a code or a key.

public enum AutofillCore {

  // MARK: - origins

  /// What kind of service identifier the OS handed over (ASCredentialServiceIdentifier.type).
  public enum ServiceKind: Equatable {
    case url
    case domain
  }

  /// The origin a fill is held to, or nil when the identifier is not one Vyre fills.
  ///
  /// - `.domain` "portal.harlow.test" becomes "https://portal.harlow.test".
  /// - `.url` "https://portal.harlow.test/login?next=1" becomes "https://portal.harlow.test".
  ///   An https URL keeps a port other than 443. An http URL gets nil: a page on plain http is
  ///   never given a login saved for https, and Vyre does not fill plain http on Apple devices.
  /// - A URL identifier with no scheme is read as a domain with an optional path.
  /// - User info, IPv6 literals, bad ports and anything that is not a host name get nil.
  public static func origin(serviceIdentifier raw: String, kind: ServiceKind) -> String? {
    let s = trim(raw)
    if s.isEmpty { return nil }
    let lower = s.lowercased()
    switch kind {
    case .domain:
      var host = lower
      if host.hasSuffix(".") { host.removeLast() }
      guard isHostName(host) else { return nil }
      return "https://" + host
    case .url:
      var rest: Substring
      if lower.hasPrefix("https://") {
        rest = lower.dropFirst(8)
      } else if lower.contains("://") {
        return nil
      } else {
        rest = Substring(lower)
      }
      if let cut = rest.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) { rest = rest[..<cut] }
      guard let (host, port) = splitAuthority(String(rest)) else { return nil }
      guard isHostName(host) || isIPv4(host) else { return nil }
      if let p = port, p != 443 { return "https://\(host):\(p)" }
      return "https://" + host
    }
  }

  /// Unique origins from a list of service identifiers, in order. Identifiers that give no origin are dropped.
  public static func origins(_ identifiers: [(String, ServiceKind)]) -> [String] {
    var seen: [String] = []
    for (id, kind) in identifiers {
      if let o = origin(serviceIdentifier: id, kind: kind), !seen.contains(o) { seen.append(o) }
    }
    return seen
  }

  /// A relying party id as the OS gives it: a host name, lower case, no port. Nil otherwise.
  public static func rpId(_ raw: String) -> String? {
    var h = trim(raw).lowercased()
    if h.hasSuffix(".") { h.removeLast() }
    return isHostName(h) ? h : nil
  }

  /// A DNS host name: labels of a-z, 0-9 and "-", 1 to 63 long, not starting or ending with "-".
  public static func isHostName(_ h: String) -> Bool {
    if h.isEmpty || h.utf8.count > 253 { return false }
    let labels = h.split(separator: ".", omittingEmptySubsequences: false)
    for label in labels {
      let u = Array(label.utf8)
      if u.isEmpty || u.count > 63 { return false }
      if u.first == 45 || u.last == 45 { return false }
      for c in u where !((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 45) { return false }
    }
    return true
  }

  static func isIPv4(_ h: String) -> Bool {
    let parts = h.split(separator: ".", omittingEmptySubsequences: false)
    if parts.count != 4 { return false }
    for p in parts {
      guard !p.isEmpty, p.count <= 3, p.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(p), n <= 255 else { return false }
    }
    return true
  }

  /// "host" or "host:port" to its parts. Nil for user info, IPv6 brackets or a bad port.
  static func splitAuthority(_ a: String) -> (String, Int?)? {
    if a.isEmpty || a.contains("@") || a.hasPrefix("[") { return nil }
    let parts = a.split(separator: ":", omittingEmptySubsequences: false)
    if parts.count == 1 {
      var h = String(parts[0])
      if h.hasSuffix(".") { h.removeLast() }
      return h.isEmpty ? nil : (h, nil)
    }
    if parts.count != 2 { return nil }
    let ps = parts[1]
    guard !ps.isEmpty, ps.count <= 5, ps.allSatisfy({ $0.isASCII && $0.isNumber }), let port = Int(ps), port >= 1, port <= 65535 else { return nil }
    var h = String(parts[0])
    if h.hasSuffix(".") { h.removeLast() }
    return h.isEmpty ? nil : (h, port)
  }

  // MARK: - identities

  /// One entry of `POST /v1/fill/identities` (core/vault/fill-cards.js, identitiesRoute).
  /// `userHandle` and `totp` are not sent by the server yet (see the README, "Needs from the vault team").
  public struct VaultIdentity: Decodable, Equatable {
    public var name: String
    public var kind: String
    public var sites: [String]?
    public var apps: [String]?
    public var user: String?
    public var rp: String?
    public var credential: String?
    public var userHandle: String?
    public var totp: Bool?

    public init(name: String, kind: String, sites: [String]? = nil, apps: [String]? = nil, user: String? = nil,
                rp: String? = nil, credential: String? = nil, userHandle: String? = nil, totp: Bool? = nil) {
      self.name = name; self.kind = kind; self.sites = sites; self.apps = apps; self.user = user
      self.rp = rp; self.credential = credential; self.userHandle = userHandle; self.totp = totp
    }
  }

  /// The identities route's whole reply: the list and whether `user` is a username or an item name.
  public struct IdentityList: Decodable, Equatable {
    public var identities: [VaultIdentity]
    public var users: String?

    public init(identities: [VaultIdentity], users: String?) { self.identities = identities; self.users = users }

    /// Only an explicit "usernames" shows usernames. Anything else, or nothing, shows item names.
    public var namesOnly: Bool { users != "usernames" }
  }

  /// What goes into ASCredentialIdentityStore. `record` is always the vault item's name.
  public enum PlannedIdentity: Equatable {
    case password(site: String, user: String, record: String)
    case passkey(rpId: String, userName: String, credentialID: [UInt8], userHandle: [UInt8], record: String)
    case oneTimeCode(site: String, label: String, record: String)
  }

  /// Map the identities list to store entries.
  ///
  /// - A login becomes one password identity per https site, as a .URL identifier holding the
  ///   exact origin, so the OS has no domain to widen. http sites and android: apps are skipped.
  /// - A passkey becomes a passkey identity when its rp is a host name and its credential id is
  ///   base64url. A missing user handle is stored empty (the assertion carries the real one).
  /// - A login flagged `totp: true` also gets a one-time code identity per site (iOS 18, macOS 15).
  /// - With `users` other than "usernames", the item's name stands in for every username, for
  ///   passkeys as well as logins, whatever the entry's `user` says.
  public static func plan(_ list: IdentityList) -> [PlannedIdentity] {
    let names = list.namesOnly
    var out: [PlannedIdentity] = []
    for i in list.identities where !i.name.isEmpty {
      let shown = names ? i.name : (nonEmpty(i.user) ?? i.name)
      switch i.kind {
      case "login":
        var sites: [String] = []
        for s in i.sites ?? [] {
          if let o = origin(serviceIdentifier: s, kind: .url), !sites.contains(o) { sites.append(o) }
        }
        for s in sites {
          let p = PlannedIdentity.password(site: s, user: shown, record: i.name)
          if !out.contains(p) { out.append(p) }
          if i.totp == true { out.append(.oneTimeCode(site: s, label: shown, record: i.name)) }
        }
      case "passkey":
        guard let rp = i.rp.flatMap(rpId), let c = i.credential, let id = base64urlDecode(c), !id.isEmpty else { continue }
        let handle = i.userHandle.flatMap(base64urlDecode) ?? []
        out.append(.passkey(rpId: rp, userName: shown, credentialID: id, userHandle: handle, record: i.name))
      default:
        continue
      }
    }
    return out
  }

  /// Whether a passkey's credential id (base64url) is one the relying party allows. An empty allow list allows all.
  public static func allowed(credential: String, allow: [[UInt8]]) -> Bool {
    if allow.isEmpty { return true }
    guard let id = base64urlDecode(credential) else { return false }
    return allow.contains(id)
  }

  // MARK: - the device-key challenge

  /// What vyred's challenge route asks the device key to sign (core/vault/fill.js, unlockMessage).
  public static func unlockMessage(_ nonce: String) -> String { "vyre:fill-unlock:v1:" + nonce }

  /// The message to sign, or nil when the reply is not a well-formed challenge.
  public static func messageToSign(challenge: String?, message: String?) -> String? {
    guard let c = challenge, let m = message, isNonce(c) else { return nil }
    return m == unlockMessage(c) ? m : nil
  }

  static func isNonce(_ s: String) -> Bool {
    let u = Array(s.utf8)
    if u.count < 16 || u.count > 200 { return false }
    return u.allSatisfy(isBase64urlByte)
  }

  // MARK: - the vyred address

  /// The fill listener's base URL, normalised (no trailing slash), or nil when it is refused:
  /// https to any host, http only to 127.0.0.1. No user info, query or fragment.
  public static func serverURL(_ raw: String) -> String? {
    let s = trim(raw)
    let lower = s.lowercased()
    let scheme: String
    let rest: Substring
    if lower.hasPrefix("https://") { scheme = "https"; rest = s.dropFirst(8) }
    else if lower.hasPrefix("http://") { scheme = "http"; rest = s.dropFirst(7) }
    else { return nil }
    if rest.contains(where: { $0 == "?" || $0 == "#" || $0 == "@" || $0 == "\\" || $0.isWhitespace }) { return nil }
    let slash = rest.firstIndex(of: "/") ?? rest.endIndex
    guard let (hostRaw, port) = splitAuthority(String(rest[..<slash])) else { return nil }
    let host = hostRaw.lowercased()
    guard isHostName(host) || isIPv4(host) else { return nil }
    if scheme == "http" && host != "127.0.0.1" { return nil }
    var path = String(rest[slash...])
    while path.hasSuffix("/") { path.removeLast() }
    var portPart = ""
    if let p = port, !(scheme == "https" && p == 443), !(scheme == "http" && p == 80) { portPart = ":\(p)" }
    return "\(scheme)://\(host)\(portPart)\(path)"
  }

  /// A route under the fill listener.
  public static func routeURL(_ server: String, _ route: String) -> String { server + "/v1/fill/" + route }

  // MARK: - keychain group

  /// The shared keychain access group from the Info.plist value, or nil when the build was not
  /// signed by a team (the prefix did not expand, so asking for the group would only fail).
  public static func keychainGroup(_ plistValue: String?) -> String? {
    guard let v = plistValue.map(trim), !v.isEmpty, !v.contains("$(") else { return nil }
    let parts = v.split(separator: ".", maxSplits: 1)
    guard parts.count == 2, parts[0].count == 10, parts[0].allSatisfy({ $0.isASCII && ($0.isUppercase || $0.isNumber) }) else { return nil }
    return v
  }

  // MARK: - the session clock

  /// Whether a fill window is still open, with a margin so a request does not start as it closes.
  /// Times are milliseconds since 1970, as vyred sends `expires`.
  public static func isLive(expiresMs: Double, nowMs: Double, marginMs: Double = 5_000) -> Bool {
    nowMs + marginMs < expiresMs
  }

  // MARK: - errors, in words

  /// A short line for a person, from an error code. Never carries a value or an item name.
  public static func say(_ code: String) -> String {
    switch code {
    case "not_paired": return "Not paired. Open Vyre and pair this device."
    case "unauthorized", "revoked": return "This device is no longer paired. Pair it again in Vyre."
    case "bad_code": return "That pairing code did not work. Run vyre vault pair --phone for a new one."
    case "locked_out": return "Too many tries. Wait 15 minutes."
    case "vault_locked": return "The vault is locked on the Mac."
    case "no_key": return "This device has no device key. Pair it again."
    case "bad_signature": return "The unlock did not check. Try again."
    case "session_required", "session_expired": return "Unlock again."
    case "cancelled": return "Cancelled."
    case "no_biometrics": return "Face ID or Touch ID is not set up."
    case "keygen": return "Could not make a device key on this device."
    case "keychain": return "Could not use the keychain."
    case "network": return "Could not reach vyred."
    case "bad_server": return "Use an https address, or http://127.0.0.1."
    case "not_found", "wrong_origin": return "No matching login in the vault."
    case "no_totp": return "That login has no one-time code."
    case "not_enabled": return "Turn on Vyre in AutoFill settings."
    case "store": return "Could not update the AutoFill list."
    case "bad_challenge": return "vyred sent a challenge this device will not sign."
    default: return "Something went wrong (\(code))."
    }
  }

  // MARK: - bytes

  private static let alphabet: [UInt8] = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)

  static func isBase64urlByte(_ c: UInt8) -> Bool {
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 45 || c == 95
  }

  /// Base64url without padding.
  public static func base64url(_ bytes: [UInt8]) -> String {
    var out: [UInt8] = []
    out.reserveCapacity((bytes.count + 2) / 3 * 4)
    var i = 0
    while i + 3 <= bytes.count {
      let n = (UInt32(bytes[i]) << 16) | (UInt32(bytes[i + 1]) << 8) | UInt32(bytes[i + 2])
      out.append(alphabet[Int((n >> 18) & 63)]); out.append(alphabet[Int((n >> 12) & 63)])
      out.append(alphabet[Int((n >> 6) & 63)]); out.append(alphabet[Int(n & 63)])
      i += 3
    }
    let rest = bytes.count - i
    if rest == 1 {
      let n = UInt32(bytes[i]) << 16
      out.append(alphabet[Int((n >> 18) & 63)]); out.append(alphabet[Int((n >> 12) & 63)])
    } else if rest == 2 {
      let n = (UInt32(bytes[i]) << 16) | (UInt32(bytes[i + 1]) << 8)
      out.append(alphabet[Int((n >> 18) & 63)]); out.append(alphabet[Int((n >> 12) & 63)]); out.append(alphabet[Int((n >> 6) & 63)])
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// Base64url (or base64 with "=" padding at the end) to bytes, or nil.
  public static func base64urlDecode(_ s: String) -> [UInt8]? {
    var u = Array(s.utf8)
    while u.last == 61 { u.removeLast() }
    if u.count % 4 == 1 { return nil }
    var vals: [UInt32] = []
    vals.reserveCapacity(u.count)
    for c in u {
      switch c {
      case 65...90: vals.append(UInt32(c - 65))
      case 97...122: vals.append(UInt32(c - 71))
      case 48...57: vals.append(UInt32(c + 4))
      case 45, 43: vals.append(62)
      case 95, 47: vals.append(63)
      default: return nil
      }
    }
    var out: [UInt8] = []
    out.reserveCapacity(vals.count * 3 / 4)
    var i = 0
    while i + 4 <= vals.count {
      let n = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3]
      out.append(UInt8((n >> 16) & 255)); out.append(UInt8((n >> 8) & 255)); out.append(UInt8(n & 255))
      i += 4
    }
    let rest = vals.count - i
    if rest == 2 {
      let n = (vals[i] << 18) | (vals[i + 1] << 12)
      out.append(UInt8((n >> 16) & 255))
    } else if rest == 3 {
      let n = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6)
      out.append(UInt8((n >> 16) & 255)); out.append(UInt8((n >> 8) & 255))
    }
    return out
  }

  /// The DER prefix of a P-256 SubjectPublicKeyInfo: SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING }.
  public static let p256SPKIPrefix: [UInt8] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ]

  /// SPKI DER for a raw uncompressed P-256 public key (X9.63: 0x04 || X || Y, 65 bytes), as
  /// SecKeyCopyExternalRepresentation gives it. vyred's pair route takes this, base64url.
  public static func spki(fromX963 raw: [UInt8]) -> [UInt8]? {
    guard raw.count == 65, raw[0] == 0x04 else { return nil }
    return p256SPKIPrefix + raw
  }

  // MARK: - text

  static func trim(_ s: String) -> String {
    var sub = Substring(s)
    while let f = sub.first, f.isWhitespace { sub.removeFirst() }
    while let l = sub.last, l.isWhitespace { sub.removeLast() }
    return String(sub)
  }

  static func nonEmpty(_ s: String?) -> String? {
    guard let s = s else { return nil }
    let t = trim(s)
    return t.isEmpty ? nil : t
  }
}
