// CredentialView: "Add your Deepgram key" in the panel (Host/Credentials.swift). One secure field
// per field the need has, focused at once; ⏎ saves through the vault, Esc leaves it.

import SwiftUI

struct CredentialView: View {
    @ObservedObject var ask: CredentialAsk
    @FocusState private var focused: String?
    var onSubmit: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "key").font(Theme.type(Tokens.TypeScale.base, .semibold)).foregroundColor(Theme.signal)
                Text("Add your \(ask.need.label)").font(Theme.type(Tokens.TypeScale.read, .semibold)).foregroundColor(Theme.bone)
                Spacer()
            }
            Text("\(ask.need.module.prefix(1).uppercased() + ask.need.module.dropFirst()) needs it. It goes straight into your vault, and only \(ask.need.module) may use it.")
                .font(Theme.title).foregroundColor(Theme.stone)
            ForEach(ask.need.fields, id: \.name) { f in
                let text = Binding(get: { ask.values[f.name] ?? "" }, set: { ask.values[f.name] = $0 })
                Group {
                    if f.secret { SecureField(f.label, text: text) } else { TextField(f.label, text: text) }
                }
                .textFieldStyle(.plain)
                .font(Theme.type(Tokens.TypeScale.read))
                .foregroundColor(Theme.bone)
                .focused($focused, equals: f.name)
                .onSubmit(onSubmit)
                .padding(.horizontal, 12).frame(height: Tokens.Control.sm)
                .background(RoundedRectangle(cornerRadius: Tokens.Radius.field, style: .continuous).fill(Theme.raised))
                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.field, style: .continuous).strokeBorder(Theme.ruleStrong, lineWidth: 1))
                .accessibilityLabel(f.label)
                .accessibilityHint("Return saves it in the vault")
            }
            if let h = ask.need.help { Text(h).font(Theme.subtitle).foregroundColor(Theme.ash) }
            if ask.saving { Text("Saving in the vault").font(Theme.subtitle).foregroundColor(Theme.stone) }
            if let e = ask.error { Label(e, systemImage: "xmark.circle").font(Theme.subtitle).foregroundColor(Theme.stone) }
        }
        .padding(Theme.inset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear { focused = ask.need.fields.first?.name }
    }
}
