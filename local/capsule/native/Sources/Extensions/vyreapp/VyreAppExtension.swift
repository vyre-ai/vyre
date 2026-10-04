// vyreapp: "Open Vyre" in the Capsule's list, which opens the Vyre app window (Host/VyreAppWindow.swift). It starts nothing in the background.

import AppKit
import Foundation

// capsule-extension: VyreAppExtension
@MainActor
final class VyreAppExtension: CapsuleExtension {
    static let id = "vyreapp"
    private let host: CapsuleHost
    init(host: CapsuleHost) { self.host = host }

    var commands: [CapsuleCommand] {
        [CapsuleCommand(id: "vyreapp:open", title: "Open Vyre",
                        keywords: ["vyre", "app", "window", "now", "chat", "projects", "open"], icon: .symbol("macwindow", .stone),
                        subtitle: "Now, chat, projects and everything else, in a window",
                        actions: [ResultAction(id: "open", title: "Open Vyre", symbol: "return", shortcut: KeyShortcut("return")) { _, _ in
                            await MainActor.run { VyreAppWindow.shared.show() }
                            return .close("Opened Vyre.")
                        }])]
    }

    func capsuleWillShow(front: FrontApp?) {}
    func capsuleDidHide() {}
}
