// VaultPasswordView: "Unlock the vault on this Mac" with the vault password, for a Mac with no Touch ID
// reader (Host/ViewMode.swift). One secure field; Return unlocks, Esc leaves. The password lives in the
// field and the one call and is cleared as it is sent.

import SwiftUI

struct VaultPasswordView: View {
    @ObservedObject var ask: VaultPasswordAsk
    @FocusState private var focused: Bool
    var onSubmit: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "lock.open").font(Theme.type(Tokens.TypeScale.base, .semibold)).foregroundColor(Theme.signal)
                Text("Unlock the vault on this Mac").font(Theme.type(Tokens.TypeScale.read, .semibold)).foregroundColor(Theme.bone)
                Spacer()
            }
            Text("This Mac has no Touch ID, so type your vault password. It goes straight to the vault and is not kept.")
                .font(Theme.title).foregroundColor(Theme.stone)
            SecureField("Vault password", text: $ask.password)
                .textFieldStyle(.plain)
                .font(Theme.type(Tokens.TypeScale.read))
                .foregroundColor(Theme.bone)
                .focused($focused)
                .onSubmit(onSubmit)
                .padding(.horizontal, 12).frame(height: Tokens.Control.sm)
                .background(RoundedRectangle(cornerRadius: Tokens.Radius.field, style: .continuous).fill(Theme.raised))
                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.field, style: .continuous).strokeBorder(Theme.ruleStrong, lineWidth: 1))
                .accessibilityLabel("Vault password")
                .accessibilityHint("Return unlocks the vault")
            if ask.busy { Text("Unlocking").font(Theme.subtitle).foregroundColor(Theme.stone) }
            if let e = ask.error { Label(e, systemImage: "xmark.circle").font(Theme.subtitle).foregroundColor(Theme.stone) }
            Text("Return unlocks \u{00B7} Esc goes back").font(Theme.subtitle).foregroundColor(Theme.ash)
        }
        .padding(Theme.inset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear { focused = true }
    }
}
