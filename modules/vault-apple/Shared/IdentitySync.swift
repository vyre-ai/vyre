// IdentitySync: put the vault's logins and passkeys into the system's AutoFill list.
//
// The OS must know (site, user) before anyone unlocks, or QuickType shows nothing (ADR 0028,
// threat model: "The operating system's autofill store holds usernames"). identities needs a
// live session, so a sync runs inside a fill window. Every entry's recordIdentifier is the vault
// item's name, which is what the extension sends back to fill. Passwords never go in the store.
//
// With `users: "names"` from vyred, the item name stands in for every username (AutofillCore.plan).

import AuthenticationServices
import Foundation

public enum IdentitySync {
  public struct Summary: Equatable {
    public var passwords = 0
    public var passkeys = 0
    public var codes = 0
    /// False when Vyre is not turned on in AutoFill settings: the store refuses writes then.
    public var enabled = true
  }

  /// Fetch identities and replace the whole store with them.
  @discardableResult
  public static func run(client: FillClient) async throws -> Summary {
    let store = ASCredentialIdentityStore.shared
    let state = await store.state()
    guard state.isEnabled else { return Summary(enabled: false) }
    let list = try await client.identities()
    var summary = Summary()
    var entries: [any ASCredentialIdentity] = []
    for p in AutofillCore.plan(list) {
      switch p {
      case let .password(site, user, record):
        entries.append(ASPasswordCredentialIdentity(serviceIdentifier: ASCredentialServiceIdentifier(identifier: site, type: .URL), user: user, recordIdentifier: record))
        summary.passwords += 1
      case let .passkey(rpId, userName, credentialID, userHandle, record):
        entries.append(ASPasskeyCredentialIdentity(relyingPartyIdentifier: rpId, userName: userName, credentialID: Data(credentialID), userHandle: Data(userHandle), recordIdentifier: record))
        summary.passkeys += 1
      case let .oneTimeCode(site, label, record):
        if #available(iOS 18.0, macOS 15.0, *) {
          entries.append(ASOneTimeCodeCredentialIdentity(serviceIdentifier: ASCredentialServiceIdentifier(identifier: site, type: .URL), label: label, recordIdentifier: record))
          summary.codes += 1
        }
      }
    }
    do { try await store.replaceCredentialIdentities(entries) } catch { throw FillError("store") }
    return summary
  }

  /// Empty the store, on unpairing.
  public static func clear() async {
    try? await ASCredentialIdentityStore.shared.removeAllCredentialIdentities()
  }
}
