// history: "Import my history" in the Capsule. The person opens it from the list, sees what this Mac
// holds in Claude Code, Codex and Grok, ticks the projects to bring in and sends them to their own Vyre
// over the paired link (#26, docs/design/import.md). It reads and asks only when the person opens it,
// follows one event (import.progress) only while the panel is open, and keeps nothing running hidden.

import AppKit
import Foundation
import SwiftUI

// capsule-extension: HistoryImportExtension
@MainActor
final class HistoryImportExtension: CapsuleExtension {
    static let id = "history"

    private let host: CapsuleHost
    let model: HistoryImportModel
    private var sub: VyredSubscription?

    init(host: CapsuleHost) {
        self.host = host
        model = HistoryImportModel(vyred: host.vyred)
    }

    var commands: [CapsuleCommand] {
        [CapsuleCommand(id: "history:import", title: "Import my history",
                        keywords: ["import", "history", "sessions", "claude code", "codex", "grok", "bring in"], icon: .symbol("tray.and.arrow.down", .stone),
                        subtitle: "Bring this Mac's sessions into your Vyre",
                        actions: [ResultAction(id: "open", title: "Import my history", symbol: "return", shortcut: KeyShortcut("return")) { [weak self] _, _ in
                            guard let self else { return .failed("Lumen is closing") }
                            return await self.open()
                        }])]
    }

    /// Open the panel and look: nothing is read before the person asks.
    func open() async -> ActionOutcome {
        sub?.cancel()
        sub = host.vyred.on("import.progress") { [weak self] e in self?.model.apply(e) }
        host.showPanel(Self.id)
        if model.step == .idle || model.step == .unpaired || model.step == .nothing { await model.scan() }
        else if model.step == .sending { await model.refresh() } // events missed while Lumen was hidden
        return .openPanel
    }

    func sidePanel(for item: ResultItem?) -> AnyView? { AnyView(HistoryImportView(model: model)) }

    func capsuleWillShow(front: FrontApp?) {}
    func capsuleDidHide() { sub?.cancel(); sub = nil }
}
