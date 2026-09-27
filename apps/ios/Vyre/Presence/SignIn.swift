import AuthenticationServices
import Foundation
import UIKit

/// Signing in enrolls this phone's device key with the box, approved by the Deck's passkey
/// (ADR 0018 section 3). The app opens the box's own `/onboard/device` page in the system's
/// authentication browser, so WebAuthn runs against the box's origin with the passkeys the Deck
/// enrolled; the page calls `presence.enroll` and returns to `vyre://enrolled?id=<key id>`.
enum SignIn {
    static let callbackScheme = "vyre"

    /// `https://<address>/onboard/device#k=<SPKI b64url>&n=<name>&r=vyre`. The key rides in the
    /// fragment, so it never reaches a server log.
    static func url(address: BoxAddress, key: DeviceKey, name: String) -> URL {
        var c = URLComponents(url: address.url, resolvingAgainstBaseURL: false)!
        c.path = "/onboard/device"
        var f = URLComponents()
        f.queryItems = [URLQueryItem(name: "k", value: key.spki.base64URL), URLQueryItem(name: "n", value: name),
                        URLQueryItem(name: "r", value: callbackScheme)]
        c.percentEncodedFragment = f.percentEncodedQuery
        return c.url!
    }

    enum Outcome: Equatable { case enrolled(String), refused(String) }

    /// `vyre://enrolled?id=<id>`, or `vyre://enrolled?error=<why>`.
    static func parse(callback: URL) -> Outcome? {
        guard callback.scheme == callbackScheme, callback.host == "enrolled",
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        if let id = items.first(where: { $0.name == "id" })?.value, !id.isEmpty { return .enrolled(id) }
        if let e = items.first(where: { $0.name == "error" })?.value { return .refused(e) }
        return nil
    }

    /// The name the box lists this phone under.
    @MainActor static var deviceName: String {
        let n = UIDevice.current.name
        return n.isEmpty ? "iPhone" : n
    }

    /// Run the browser sign-in. Returns the enrolled key id.
    @MainActor
    static func run(address: BoxAddress, key: DeviceKey) async throws -> String {
        let url = url(address: address, key: key, name: deviceName)
        let anchor = Anchor()
        let callback: URL = try await withCheckedThrowingContinuation { cont in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { url, error in
                if let url { cont.resume(returning: url); return }
                if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    cont.resume(throwing: VyreError.cancelled); return
                }
                cont.resume(throwing: error ?? VyreError.cancelled)
            }
            session.presentationContextProvider = anchor
            session.prefersEphemeralWebBrowserSession = false // the synced passkeys live in the shared browser
            if !session.start() { cont.resume(throwing: VyreError.failed(code: "sign_in", message: "Could not open the sign-in page.")) }
        }
        _ = anchor
        switch parse(callback: callback) {
        case .enrolled(let id):
            guard id == key.id else { throw VyreError.failed(code: "sign_in", message: "The box enrolled a different key.") }
            return id
        case .refused(let why): throw VyreError.denied(why)
        case nil: throw VyreError.failed(code: "sign_in", message: "The sign-in page returned nothing.")
        }
    }

    /// `presence.enroll` for the device key with a one-time code (`vyre presence code`). The page
    /// uses this when the box has no passkey yet; DEBUG builds use it directly for the test world.
    static func enroll(client: VyreClient, key: DeviceKey, name: String, code: String) async throws -> String {
        let input: JSON = ["kind": "device", "public_key": .string(key.spki.base64URL), "alg": -7, "name": .string(name)]
        let out = try await client.call("presence.enroll", input, proof: .code(code))
        guard let id = out["id"].string else { throw VyreError.failed(code: "bad_response", message: "The box did not name the key.") }
        return id
    }

    @MainActor
    final class Anchor: NSObject, ASWebAuthenticationPresentationContextProviding {
        nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            MainActor.assumeIsolated {
                UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
            }
        }
    }
}
