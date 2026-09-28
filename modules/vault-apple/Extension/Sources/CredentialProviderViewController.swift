// The Vyre AutoFill credential provider (ADR 0028, decision 6), UIKit on iOS and AppKit on macOS.
//
//   prepareCredentialList(for:)                   names for the page's exact origin, from `match`
//   prepareCredentialList(for:requestParameters:) the same, plus passkeys for the rpId (`passkeys`)
//   prepareOneTimeCodeCredentialList(for:)        iOS 18 / macOS 15: logins for the page, then `otp`
//   provideCredentialWithoutUserInteraction(for:) only with a live session in memory, else
//                                                 ASExtensionError.userInteractionRequired
//   prepareInterfaceToProvideCredential(for:)     unlock (challenge, Face ID / Touch ID, unlock),
//                                                 then `fill`, `passkey.assert` or `otp`
//   prepareInterfaceForExtensionConfiguration()   a short note and a sync button
//
// A password fill sends vyred the origin of the service identifier, and vyred fills only a
// login whose hosts include that origin exactly. Nothing here logs, prints or shows a value;
// the list shows item names and descriptions only.

import AuthenticationServices
import SwiftUI
#if os(iOS)
import UIKit
private typealias Hosting = UIHostingController<PickerView>
#else
import AppKit
private typealias Hosting = NSHostingController<PickerView>
#endif

final class CredentialProviderViewController: ASCredentialProviderViewController {
  private let store = VaultStore.shared
  private lazy var vyre = VyreSession(store: store)
  private let model = PickerModel()
  private var hosting: Hosting?
  /// The passkey request's clientDataHash and rpId while the list is up.
  private var passkeyParams: (rpId: String, clientDataHash: Data)?

  private static let unlockReason = "Unlock Vyre to fill"

  #if os(macOS)
  override func loadView() {
    view = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 420))
  }
  #endif

  override func viewDidLoad() {
    super.viewDidLoad()
    model.onCancel = { [weak self] in self?.cancel(.userCanceled) }
    model.onPick = { [weak self] row in self?.pick(row) }
    model.onDone = { [weak self] in self?.extensionContext.completeExtensionConfigurationRequest() }
    model.onSync = { [weak self] in self?.syncFromConfiguration() }
    let h = Hosting(rootView: PickerView(model: model))
    addChild(h)
    h.view.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(h.view)
    NSLayoutConstraint.activate([
      h.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      h.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      h.view.topAnchor.constraint(equalTo: view.topAnchor),
      h.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    hosting = h
  }

  // MARK: - lists

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    passkeyParams = nil
    loadList(serviceIdentifiers, passkeys: nil, codes: false)
  }

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier], requestParameters: ASPasskeyCredentialRequestParameters) {
    passkeyParams = nil
    loadList(serviceIdentifiers, passkeys: requestParameters, codes: false)
  }

  @available(iOS 18.0, macOS 15.0, *)
  override func prepareOneTimeCodeCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    passkeyParams = nil
    loadList(serviceIdentifiers, passkeys: nil, codes: true)
  }

  private func loadList(_ ids: [ASCredentialServiceIdentifier], passkeys params: ASPasskeyCredentialRequestParameters?, codes: Bool) {
    guard store.isPaired else { model.phase = .message(AutofillCore.say("not_paired")); return }
    model.phase = .working("Looking for logins")
    let origins = AutofillCore.origins(ids.compactMap { id in Self.kind(id.type).map { (id.identifier, $0) } })
    Task { @MainActor in
      do {
        let client = try store.client()
        var rows: [PickerRow] = []
        for o in origins {
          let m = try await client.match(url: o)
          for l in m.logins {
            let kind: PickerRow.Kind = codes ? .code(name: l.name, origin: o) : .login(name: l.name, origin: o)
            rows.append(PickerRow(id: "\(codes ? "code" : "login")|\(o)|\(l.name)", title: l.name, subtitle: l.description ?? "", kind: kind))
          }
        }
        if let p = params, let rp = AutofillCore.rpId(p.relyingPartyIdentifier) {
          passkeyParams = (rp, p.clientDataHash)
          let allow = p.allowedCredentials.map { [UInt8]($0) }
          let listed = try await client.passkeys(url: "https://" + rp, rpId: rp)
          for k in listed.passkeys where AutofillCore.allowed(credential: k.id, allow: allow) {
            rows.append(PickerRow(id: "passkey|\(k.id)", title: k.name, subtitle: k.description ?? "Passkey", kind: .passkey(credential: k.id, name: k.name, rpId: rp)))
          }
        }
        model.rows = rows
        model.phase = .list
      } catch {
        model.phase = .message(AutofillCore.say(Self.code(error)))
      }
    }
  }

  private func pick(_ row: PickerRow) {
    model.phase = .working("Unlocking")
    Task { @MainActor in
      do {
        switch row.kind {
        case let .login(name, origin):
          let v = try await vyre.run(interactive: true, reason: Self.unlockReason) { try await $0.fill(name: name, url: origin) }
          completePassword(v)
        case let .code(name, origin):
          let c = try await vyre.run(interactive: true, reason: Self.unlockReason) { try await $0.otp(name: name, url: origin) }
          completeCode(c)
        case let .passkey(credential, _, rpId):
          guard let p = passkeyParams, p.rpId == rpId else { throw FillError("bad_input") }
          let a = try await vyre.run(interactive: true, reason: Self.unlockReason) {
            try await $0.passkeyAssert(rpId: rpId, clientDataHash: p.clientDataHash, credential: credential)
          }
          try completePasskey(a, rpId: rpId, clientDataHash: p.clientDataHash, credential: credential)
        }
      } catch let e as FillError where e.code == "cancelled" {
        model.phase = .list
      } catch {
        model.phase = .message(AutofillCore.say(Self.code(error)))
      }
    }
  }

  // MARK: - one tap from QuickType or the passkey sheet

  override func provideCredentialWithoutUserInteraction(for credentialRequest: any ASCredentialRequest) {
    guard store.isPaired, store.liveSession() != nil else { cancel(.userInteractionRequired); return }
    Task { @MainActor in
      do { try await provide(credentialRequest, interactive: false) }
      catch let e as FillError where e.needsUnlock { cancel(.userInteractionRequired) }
      catch { cancel(Self.extensionCode(error)) }
    }
  }

  override func prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest) {
    guard store.isPaired else { model.phase = .message(AutofillCore.say("not_paired")); return }
    model.phase = .working("Unlocking")
    Task { @MainActor in
      do { try await provide(credentialRequest, interactive: true) }
      catch { cancel(Self.extensionCode(error)) }
    }
  }

  override func prepareInterface(forPasskeyRegistration registrationRequest: any ASCredentialRequest) {
    // Making a passkey from the system sheet needs a server route that takes a clientDataHash
    // (README, "Needs from the vault team"). Until then the OS falls back to another provider.
    cancel(.failed)
  }

  private func provide(_ request: any ASCredentialRequest, interactive: Bool) async throws {
    let reason = Self.unlockReason
    if #available(iOS 18.0, macOS 15.0, *), request.type == .oneTimeCode {
      guard let id = request.credentialIdentity as? ASOneTimeCodeCredentialIdentity, let name = id.recordIdentifier,
            let origin = Self.origin(id.serviceIdentifier) else {
        throw FillError("not_found")
      }
      let c = try await vyre.run(interactive: interactive, reason: reason) { try await $0.otp(name: name, url: origin) }
      completeCode(c)
      return
    }
    switch request.type {
    case .password:
      guard let id = request.credentialIdentity as? ASPasswordCredentialIdentity, let name = id.recordIdentifier,
            let origin = Self.origin(id.serviceIdentifier) else {
        throw FillError("not_found")
      }
      let v = try await vyre.run(interactive: interactive, reason: reason) { try await $0.fill(name: name, url: origin) }
      completePassword(v)
    case .passkeyAssertion:
      guard let r = request as? ASPasskeyCredentialRequest, let id = r.credentialIdentity as? ASPasskeyCredentialIdentity,
            let rpId = AutofillCore.rpId(id.relyingPartyIdentifier) else {
        throw FillError("not_found")
      }
      let credential = AutofillCore.base64url([UInt8](id.credentialID))
      let a = try await vyre.run(interactive: interactive, reason: reason) {
        try await $0.passkeyAssert(rpId: rpId, clientDataHash: r.clientDataHash, credential: credential)
      }
      try completePasskey(a, rpId: rpId, clientDataHash: r.clientDataHash, credential: credential)
    default:
      throw FillError("unsupported")
    }
  }

  // MARK: - configuration

  override func prepareInterfaceForExtensionConfiguration() {
    model.phase = .configure(store.isPaired
      ? "Vyre is on. Sync to list your logins and passkeys in AutoFill."
      : "Vyre is on. Open the Vyre app and pair this device to fill from your vault.")
  }

  private func syncFromConfiguration() {
    model.phase = .working("Syncing")
    Task { @MainActor in
      do {
        let s = try await vyre.run(interactive: true, reason: "Unlock Vyre to list your logins") { try await IdentitySync.run(client: $0) }
        model.phase = .configure(s.enabled ? "\(s.passwords) logins, \(s.passkeys) passkeys in AutoFill." : AutofillCore.say("not_enabled"))
      } catch {
        model.phase = .configure(AutofillCore.say(Self.code(error)))
      }
    }
  }

  // MARK: - completion

  private func completePassword(_ v: LoginValue) {
    extensionContext.completeRequest(withSelectedCredential: ASPasswordCredential(user: v.username, password: v.password), completionHandler: nil)
  }

  private func completeCode(_ c: OneTimeCode) {
    if #available(iOS 18.0, macOS 15.0, *) {
      extensionContext.completeOneTimeCodeRequest(using: ASOneTimeCodeCredential(code: c.code), completionHandler: nil)
    } else {
      cancel(.failed)
    }
  }

  private func completePasskey(_ a: PasskeyAssertion, rpId: String, clientDataHash: Data, credential: String) throws {
    guard let auth = AutofillCore.base64urlDecode(a.authenticatorData), let sig = AutofillCore.base64urlDecode(a.signature),
          let handle = AutofillCore.base64urlDecode(a.userHandle), let cid = AutofillCore.base64urlDecode(credential) else {
      throw FillError("bad_response")
    }
    let cred = ASPasskeyAssertionCredential(userHandle: Data(handle), relyingParty: rpId, signature: Data(sig),
                                            clientDataHash: clientDataHash, authenticatorData: Data(auth), credentialID: Data(cid))
    extensionContext.completeAssertionRequest(using: cred, completionHandler: nil)
  }

  private func cancel(_ code: ASExtensionError.Code) {
    extensionContext.cancelRequest(withError: NSError(domain: ASExtensionError.errorDomain, code: code.rawValue))
  }

  // MARK: - mapping

  /// Only .URL and .domain identifiers name a web origin. Any other type (an app, say) gives nil.
  private static func kind(_ t: ASCredentialServiceIdentifier.IdentifierType) -> AutofillCore.ServiceKind? {
    switch t {
    case .URL: return .url
    case .domain: return .domain
    default: return nil
    }
  }

  private static func origin(_ id: ASCredentialServiceIdentifier) -> String? {
    guard let k = kind(id.type) else { return nil }
    return AutofillCore.origin(serviceIdentifier: id.identifier, kind: k)
  }

  private static func code(_ error: Error) -> String {
    (error as? FillError)?.code ?? "internal"
  }

  private static func extensionCode(_ error: Error) -> ASExtensionError.Code {
    switch code(error) {
    case "cancelled": return .userCanceled
    case "session_required", "session_expired": return .userInteractionRequired
    case "not_found", "wrong_origin", "no_totp", "NotAllowedError": return .credentialIdentityNotFound
    default: return .failed
    }
  }
}
