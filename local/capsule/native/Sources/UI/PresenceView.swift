// PresenceView: "Confirm it's you" inside the panel, with Touch ID drawn in place
// (LAAuthenticationView), so approving a held email never throws a system dialog over the
// user's work. Where the Mac has no Touch ID, the Mac's own password sheet is the fallback.

import LocalAuthentication
import LocalAuthenticationEmbeddedUI
import SwiftUI

struct TouchIDGlyph: NSViewRepresentable {
    let context: LAContext
    func makeNSView(context ctx: Context) -> LAAuthenticationView { LAAuthenticationView(context: context, controlSize: .regular) }
    func updateNSView(_ v: LAAuthenticationView, context: Context) {}
}

struct PresenceView: View {
    @ObservedObject var ask: PresenceAsk
    let hasTouchID: Bool

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "lock.shield").font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.signal)
                Text("Confirm it's you").font(.system(size: 15, weight: .semibold)).foregroundColor(Theme.bone)
                Spacer()
            }
            Text(ask.summary)
                .font(.system(size: 13.5)).foregroundColor(Theme.bone).lineSpacing(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.raised))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.rule, lineWidth: 1))
            HStack(spacing: 12) {
                if hasTouchID { TouchIDGlyph(context: ask.context).frame(width: 44, height: 44) }
                Text(hasTouchID ? "Touch ID to approve exactly this." : "Your Mac's password approves exactly this.")
                    .font(.system(size: 12.5)).foregroundColor(Theme.stone)
                Spacer()
                KeyHint(title: "Cancel", keys: ["esc"])
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.carbon)
        // After the glyph is in the window, so the prompt is drawn in it.
        .onAppear { DispatchQueue.main.async { ask.begin() } }
    }
}
