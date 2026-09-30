// The host app for the Vyre AutoFill extension, iOS and macOS. It pairs this device with vyred,
// syncs the AutoFill list, and opens the system AutoFill settings. mobile's iOS app and the
// Capsule replace it later (README, "Where it plugs in").

import AuthenticationServices
import SwiftUI

@main
struct VyreAutofillHostApp: App {
  @StateObject private var model = HostModel()

  var body: some Scene {
    WindowGroup {
      PairingView(model: model)
        .task { await model.launch() }
    }
  }
}

@MainActor
final class HostModel: ObservableObject {
  @Published var server = ""
  @Published var code = ""
  @Published var name = ""
  @Published var status = "Not paired"
  @Published var busy = false
  @Published var paired = false

  private let store = VaultStore.shared
  private var vyre: VyreSession { VyreSession(store: store) }

  /// On each launch: say what is paired, then sync the AutoFill list (one Face ID or Touch ID).
  func launch() async {
    paired = store.isPaired
    guard paired else { status = "Not paired"; return }
    server = store.server ?? ""
    status = "Paired as \(store.deviceName ?? "this device")"
    await sync()
  }

  func pair() async {
    guard let base = AutofillCore.serverURL(server) else { status = AutofillCore.say("bad_server"); return }
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    busy = true
    defer { busy = false }
    do {
      let key = try DeviceKey.create(accessGroup: store.accessGroup)
      guard let client = FillClient(server: base, token: nil) else { throw FillError("bad_server") }
      let p = try await client.pair(code: code, name: trimmedName.isEmpty ? "Vyre AutoFill" : trimmedName, key: key)
      try store.savePairing(server: base, paired: p)
      code = ""
      paired = true
      status = "Paired as \(p.name)"
      await sync()
    } catch {
      DeviceKey.delete(accessGroup: store.accessGroup)
      status = AutofillCore.say((error as? FillError)?.code ?? "internal")
    }
  }

  func sync() async {
    busy = true
    defer { busy = false }
    do {
      let s = try await vyre.run(interactive: true, reason: "Unlock Vyre to list your logins for AutoFill") { try await IdentitySync.run(client: $0) }
      status = s.enabled ? "Synced \(s.passwords) logins and \(s.passkeys) passkeys" : AutofillCore.say("not_enabled")
    } catch {
      status = AutofillCore.say((error as? FillError)?.code ?? "internal")
    }
  }

  func openSettings() async {
    do { try await ASSettingsHelper.openCredentialProviderAppSettings() }
    catch { status = "Open Settings, then Passwords, then Password Options, and turn on Vyre." }
  }

  func unpair() async {
    if let c = try? store.client() { try? await c.lock() }
    store.forget()
    await IdentitySync.clear()
    paired = false
    status = "Not paired"
  }
}
