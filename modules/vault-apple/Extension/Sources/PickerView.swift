// PickerView: the extension's one screen. A short list of names that match the page (never a
// value), a line of status, and Cancel. Shared by iOS and macOS.

import SwiftUI

struct PickerRow: Identifiable, Equatable {
  enum Kind: Equatable {
    case login(name: String, origin: String)
    case code(name: String, origin: String)
    case passkey(credential: String, name: String, rpId: String)
  }
  let id: String
  let title: String
  let subtitle: String
  let kind: Kind
}

@MainActor
final class PickerModel: ObservableObject {
  enum Phase: Equatable {
    case working(String)
    case list
    case message(String)
    case configure(String)
  }
  @Published var phase: Phase = .working("Loading")
  @Published var rows: [PickerRow] = []
  var onPick: (PickerRow) -> Void = { _ in }
  var onCancel: () -> Void = {}
  var onDone: () -> Void = {}
  var onSync: () -> Void = {}
}

struct PickerView: View {
  @ObservedObject var model: PickerModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Vyre").font(.headline)
        Spacer()
        if case .configure = model.phase {
          Button("Done") { model.onDone() }
        } else {
          Button("Cancel") { model.onCancel() }
        }
      }
      switch model.phase {
      case .working(let what):
        HStack(spacing: 8) { ProgressView(); Text(what).foregroundStyle(.secondary) }
        Spacer()
      case .message(let text):
        Text(text).foregroundStyle(.secondary)
        Spacer()
      case .configure(let text):
        Text(text).foregroundStyle(.secondary)
        Button("Sync logins now") { model.onSync() }
        Spacer()
      case .list:
        if model.rows.isEmpty {
          Text("No matching logins in the vault.").foregroundStyle(.secondary)
          Spacer()
        } else {
          List(model.rows) { row in
            Button { model.onPick(row) } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                if !row.subtitle.isEmpty { Text(row.subtitle).font(.caption).foregroundStyle(.secondary) }
              }
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
    .padding(16)
    .frame(minWidth: 320, minHeight: 280)
  }
}
