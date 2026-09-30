// VyreSession: open a fill window with the device key, and run a request inside one.
//
//   challenge -> AutofillCore.messageToSign -> DeviceKey.signUnlock (Face ID / Touch ID) -> unlock
//
// The session token goes into VaultStore's memory only. A request that finds its session gone
// (session_required, session_expired) unlocks once more and retries once.

import Foundation

public struct VyreSession {
  public let store: VaultStore

  public init(store: VaultStore = .shared) { self.store = store }

  /// A client with a live session, without any prompt. Throws session_required when there is none.
  public func liveClient() throws -> FillClient {
    let c = try store.client()
    guard c.session != nil else { throw FillError("session_required") }
    return c
  }

  /// A client with a live session, prompting for Face ID or Touch ID when the window is closed.
  public func unlockedClient(reason: String) async throws -> FillClient {
    let c = try store.client()
    if c.session != nil { return c }
    let ch = try await c.challenge()
    let sig = try await DeviceKey.signUnlock(challenge: ch.challenge, message: ch.message, reason: reason, accessGroup: store.accessGroup)
    let u = try await c.unlock(signature: sig)
    store.setSession(u.session, expires: u.expires)
    return c.with(session: u.session)
  }

  /// Run `body` inside a fill window. With `interactive` false it never prompts: no live session
  /// throws session_required. With `interactive` true a closed window asks for a proof, and an
  /// expired one is proven again once.
  public func run<T>(interactive: Bool, reason: String, _ body: (FillClient) async throws -> T) async throws -> T {
    let first = interactive ? try await unlockedClient(reason: reason) : try liveClient()
    do {
      return try await body(first)
    } catch let e as FillError where e.needsUnlock {
      store.endSession()
      guard interactive else { throw e }
      return try await body(try await unlockedClient(reason: reason))
    }
  }
}
