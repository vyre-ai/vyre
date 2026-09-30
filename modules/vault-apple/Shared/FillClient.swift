// FillClient: the fill listener's HTTP client (core/vault/fill.js, routes under /v1/fill/).
//
// - https to any host, or http://127.0.0.1 only (AutofillCore.serverURL).
// - Authorization: Bearer <device token>; X-Vyre-Session: <session> when one is open.
// - 10 second timeout, an ephemeral session: no cache, no cookies, no redirects followed, so a
//   token never travels to a host it was not meant for.
// - No Origin header. vyred refuses a request whose Origin is not the browser extension, and a
//   phone pairs without one because it sends a device key.
// - Errors carry vyred's code and the HTTP status only. vyred's messages can name an item, so
//   they are dropped here. Values are redacted from every description.

import Foundation

/// A failure with a code and nothing else. Codes are vyred's own (bad_code, session_expired,
/// wrong_origin...) or this client's: network, bad_server, bad_response, not_paired, cancelled,
/// no_biometrics, keygen, keychain, bad_challenge, no_key.
public struct FillError: Error, Equatable, CustomStringConvertible {
  public let code: String
  public let status: Int

  public init(_ code: String, status: Int = 0) { self.code = code; self.status = status }

  public var description: String { "FillError(\(code), \(status))" }
  public var needsUnlock: Bool { code == "session_required" || code == "session_expired" }
}

/// A login's values from `fill`. Never printed: every description is redacted.
public struct LoginValue: Decodable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public let username: String
  public let password: String
  public let totp: String?
  public var description: String { "LoginValue(redacted)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// A one-time code from `otp`. Redacted like LoginValue.
public struct OneTimeCode: Decodable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public let code: String
  public let remaining: Int?
  public let period: Int?
  public var description: String { "OneTimeCode(redacted)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// A passkey assertion from `passkey.assert` (not on the server yet: see the README). Base64url fields.
public struct PasskeyAssertion: Decodable, CustomStringConvertible, CustomReflectable {
  public let authenticatorData: String
  public let signature: String
  public let userHandle: String
  public var description: String { "PasskeyAssertion(redacted)" }
  public var customMirror: Mirror { Mirror(self, children: [:]) }
}

public struct Paired: Decodable { public let device: String; public let name: String; public let token: String }
public struct Challenge: Decodable { public let challenge: String; public let message: String; public let expires: Double }
public struct Unlocked: Decodable { public let session: String; public let expires: Double }
public struct MatchedLogin: Decodable, Equatable { public let name: String; public let description: String?; public let url: String? }
public struct Matched: Decodable { public let origin: String?; public let logins: [MatchedLogin] }
public struct ListedPasskey: Decodable, Equatable { public let id: String; public let name: String; public let description: String? }
public struct ListedPasskeys: Decodable { public let passkeys: [ListedPasskey] }

public struct FillClient {
  public let server: String
  public let token: String?
  public let session: String?

  /// Nil when the server address is refused.
  public init?(server: String, token: String?, session: String? = nil) {
    guard let s = AutofillCore.serverURL(server) else { return nil }
    self.server = s
    self.token = token
    self.session = session
  }

  public func with(session: String?) -> FillClient {
    FillClient(checked: server, token: token, session: session)
  }

  private init(checked server: String, token: String?, session: String?) {
    self.server = server; self.token = token; self.session = session
  }

  // MARK: - routes

  /// POST pair { code, name, key }: key is the device key's SPKI DER, base64url. Needs a phone code (vyre vault pair --phone).
  public func pair(code: String, name: String, key: String) async throws -> Paired {
    try await post("pair", ["code": code, "name": name, "key": key], auth: false)
  }

  public func challenge() async throws -> Challenge { try await post("challenge", [String: String]()) }

  public func unlock(signature: String) async throws -> Unlocked { try await post("unlock", ["signature": signature]) }

  public func lock() async throws { let _: Empty = try await post("lock", [String: String]()) }

  /// Every login's sites and every passkey's rp, with usernames or item names. Needs a session.
  public func identities() async throws -> AutofillCore.IdentityList { try await post("identities", [String: String]()) }

  /// Names of the logins for an exact origin. A device token is enough; no values come back.
  public func match(url: String) async throws -> Matched { try await post("match", ["url": url]) }

  public func fill(name: String, url: String) async throws -> LoginValue { try await post("fill", ["name": name, "url": url]) }

  public func otp(name: String, url: String) async throws -> OneTimeCode { try await post("otp", ["name": name, "url": url]) }

  /// Passkeys for an rpId, names only. A device token is enough.
  public func passkeys(url: String, rpId: String) async throws -> ListedPasskeys { try await post("passkeys", ["url": url, "rpId": rpId]) }

  /// POST passkey.assert { rpId, clientDataHash, credential }: the OS gives a clientDataHash, not
  /// a challenge, so this route signs authenticatorData || clientDataHash as given.
  public func passkeyAssert(rpId: String, clientDataHash: Data, credential: String) async throws -> PasskeyAssertion {
    try await post("passkey.assert", ["rpId": rpId, "clientDataHash": AutofillCore.base64url([UInt8](clientDataHash)), "credential": credential])
  }

  // MARK: - transport

  private struct Empty: Decodable {}
  private struct ErrorBody: Decodable { let code: String? }
  private struct Envelope<T: Decodable>: Decodable { let data: T?; let error: ErrorBody? }

  private static let transport: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 10
    c.timeoutIntervalForResource = 10
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.urlCache = nil
    c.httpCookieStorage = nil
    c.httpShouldSetCookies = false
    c.httpCookieAcceptPolicy = .never
    return URLSession(configuration: c, delegate: NoRedirects(), delegateQueue: nil)
  }()

  private func post<T: Decodable>(_ route: String, _ body: [String: String], auth: Bool = true) async throws -> T {
    guard let url = URL(string: AutofillCore.routeURL(server, route)) else { throw FillError("bad_server") }
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if auth {
      guard let t = token, !t.isEmpty else { throw FillError("not_paired") }
      req.setValue("Bearer " + t, forHTTPHeaderField: "Authorization")
      if let s = session, !s.isEmpty { req.setValue(s, forHTTPHeaderField: "X-Vyre-Session") }
    }
    do { req.httpBody = try JSONEncoder().encode(body) } catch { throw FillError("bad_input") }
    let data: Data
    let response: URLResponse
    do { (data, response) = try await Self.transport.data(for: req) } catch { throw FillError("network") }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let env: Envelope<T>
    do { env = try JSONDecoder().decode(Envelope<T>.self, from: data) } catch {
      throw FillError(status >= 200 && status < 300 ? "bad_response" : "http_\(status)", status: status)
    }
    if let e = env.error { throw FillError(e.code ?? "error", status: status) }
    guard (200..<300).contains(status), let d = env.data else { throw FillError("bad_response", status: status) }
    return d
  }
}

/// Refuses every redirect: vyred never sends one, and following one could carry the token elsewhere.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
