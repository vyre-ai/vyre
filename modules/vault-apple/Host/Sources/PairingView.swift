// The pairing screen: vyred's address, the code from `vyre vault pair --phone`, a name for this
// device. Then a status line and the AutoFill settings button.

import SwiftUI

struct PairingView: View {
  @ObservedObject var model: HostModel

  var body: some View {
    Form {
      Section("Pair with Vyre") {
        TextField("Server, such as https://vault.harlow.test", text: $model.server)
          .autocorrectionDisabled()
          #if os(iOS)
          .textInputAutocapitalization(.never)
          .keyboardType(.URL)
          #endif
        TextField("Pairing code", text: $model.code)
          .autocorrectionDisabled()
          #if os(iOS)
          .textInputAutocapitalization(.characters)
          #endif
        TextField("Name, such as alex's iPhone", text: $model.name)
        Button(model.paired ? "Pair again" : "Pair") { Task { await model.pair() } }
          .disabled(model.busy || model.server.isEmpty || model.code.isEmpty)
      }
      Section("Status") {
        Text(model.status).foregroundStyle(.secondary)
        Button("Sync now") { Task { await model.sync() } }
          .disabled(model.busy || !model.paired)
        Button("Open AutoFill settings") { Task { await model.openSettings() } }
        if model.paired {
          Button("Unpair", role: .destructive) { Task { await model.unpair() } }
            .disabled(model.busy)
        }
      }
    }
    #if os(macOS)
    .formStyle(.grouped)
    .frame(minWidth: 420, minHeight: 360)
    #endif
  }
}
