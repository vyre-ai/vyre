// SightPanel: the side panel for "Ask about my screen" and talking. What was read, in the
// Capsule's tokens: which app and window, the page, and the first lines of what is visible.

import SwiftUI

struct SightPanel: View {
    @ObservedObject var model: SightModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.talking || !model.heard.isEmpty {
                label(model.talking ? "LISTENING" : "HEARD")
                Text(model.heard.isEmpty ? "Say it now. Option-Return to stop." : model.heard)
                    .font(Theme.reply).foregroundColor(model.heard.isEmpty ? Theme.ash : Theme.bone)
            }
            if let s = model.summary {
                label("ON SCREEN")
                Text(s.window.isEmpty ? s.app : s.window).font(Theme.title).foregroundColor(Theme.bone).lineLimit(2)
                if !s.window.isEmpty && !s.app.isEmpty { Text(s.app).font(Theme.subtitle).foregroundColor(Theme.stone) }
                if let url = s.url { Text(url).font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(1).truncationMode(.middle) }
                if let why = s.blind {
                    note("eye.slash", "Off limits: \(why). Only the app and window are read here.")
                } else {
                    if s.secure { note("lock", "A password field is in focus; its value is left out.") }
                    ForEach(Array(s.lines.enumerated()), id: \.offset) { _, l in
                        Text(l).font(Theme.subtitle).foregroundColor(Theme.stone).lineLimit(2)
                    }
                    if s.lines.isEmpty { Text("No visible text").font(Theme.subtitle).foregroundColor(Theme.ash) }
                }
            }
            if let line = model.line { Text(line).font(Theme.subtitle).foregroundColor(Theme.beacon) }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func label(_ s: String) -> some View {
        Text(s).font(Theme.label).foregroundColor(Theme.ash)
    }

    private func note(_ symbol: String, _ s: String) -> some View {
        Label(s, systemImage: symbol).font(Theme.subtitle).foregroundColor(Theme.recall)
    }
}
