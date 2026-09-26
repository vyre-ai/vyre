// ExtensionHost: the Capsule side of the seam in Kit/Extension.swift. It makes one instance of
// every extension build.sh registered, gives each this host, and routes to them: their providers
// and commands into the list, their chords while the panel is key, their side panels, and
// show/hide. Extensions never see the panel, the model or the app delegate.

import AppKit
import ApplicationServices
import CoreGraphics
import SwiftUI

@MainActor
final class ExtensionHost: CapsuleHost {
    let model: CapsuleModel
    weak var panel: PanelController?
    private(set) var extensions: [CapsuleExtension] = []
    /// The extension whose own panel is shown (host.showPanel), until hidePanel or the next hide.
    private(set) var shownPanel: String?
    private var window: CapsuleSessionWindow?

    init(model: CapsuleModel) { self.model = model }

    /// Make every registered extension once. `types` is Registry.generated.swift's list.
    func load(_ types: [CapsuleExtension.Type]) {
        var seen = Set<String>()
        for t in types where seen.insert(t.id).inserted {
            let e = t.init(host: self)
            extensions.append(e)
            if let why = e.runsHidden { log("\(t.id) runs while hidden: \(why)") }
        }
        model.extensionProviders = extensions.flatMap(\.providers)
        model.extensionCommands = extensions.flatMap(\.commands)
        model.panelFor = { [weak self] item in self?.sidePanel(for: item) }
    }

    func willShow(front: FrontApp?) { extensions.forEach { $0.capsuleWillShow(front: front) } }

    func didHide() {
        shownPanel = nil
        extensions.forEach { $0.capsuleDidHide() }
    }

    /// A chord while the panel is key: the first extension that claims it. The Capsule's own keys
    /// are checked before this, so they win a clash.
    func handle(chord: KeyShortcut) -> Bool {
        for e in extensions where e.keyChords.contains(chord) {
            if e.handle(chord: chord, query: Query(model.text, front: model.front)) { return true }
        }
        return false
    }

    func sidePanel(for item: ResultItem?) -> AnyView? {
        if let id = item?.panel, let e = extensions.first(where: { type(of: $0).id == id }), let v = e.sidePanel(for: item) { return v }
        if let id = shownPanel, let e = extensions.first(where: { type(of: $0).id == id }) { return e.sidePanel(for: nil) }
        return nil
    }

    // MARK: CapsuleHost

    var vyred: VyredLink { model.vyred }
    var front: FrontApp? { model.front }
    var isShown: Bool { panel?.isShown ?? false }

    func permission(_ p: Permission) -> PermissionState {
        switch p {
        case .accessibility: return AXIsProcessTrusted() ? .granted : .notAsked
        case .screenRecording: return CGPreflightScreenCaptureAccess() ? .granted : .notAsked
        case .inputMonitoring: return CGPreflightListenEventAccess() ? .granted : .notAsked
        default: return .notAsked
        }
    }

    func request(_ p: Permission, reason: String) async -> Bool {
        if permission(p) == .granted { return true }
        say(reason)
        guard dialogsAllowed() else { return false }
        switch p {
        case .accessibility:
            return AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        case .screenRecording: return CGRequestScreenCaptureAccess()
        case .inputMonitoring: return CGRequestListenEventAccess()
        default: return false
        }
    }

    func showPanel(_ extensionID: String) { shownPanel = extensionID; model.panelTick += 1 }
    func hidePanel() { shownPanel = nil; model.panelTick += 1 }
    func setQuery(_ text: String) { model.text = text }
    func say(_ line: String) { model.line = line }
    func stepAside() async -> Bool { await panel?.stepAside() ?? false }

    func notify(title: String, body: String) {
        if isShown { say(body) } else { Notifier.shared.post(title: title, body: body) }
    }

    func log(_ message: String) { FileHandle.standardError.write(Data("capsule: \(message)\n".utf8)) }

    func sessionWindow(owner: String) -> SessionWindow {
        if let w = window { return w }
        let w = CapsuleSessionWindow()
        window = w
        return w
    }
}

/// The session panel: a borderless, non-activating panel at normal window level on the user's
/// Space, drawn with the Capsule's tokens, animated by the Capsule.
@MainActor
final class CapsuleSessionWindow: SessionWindow {
    private var panel: NSPanel?

    var isOpen: Bool { panel?.isVisible ?? false }
    var frame: NSRect { panel?.frame ?? .zero }

    func show(_ content: AnyView, frame: NSRect) {
        let p = panel ?? {
            let p = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel, .resizable, .fullSizeContentView],
                            backing: .buffered, defer: true)
            p.level = .normal
            p.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = true
            p.isReleasedWhenClosed = false
            p.becomesKeyOnlyIfNeeded = true
            return p
        }()
        panel = p
        p.contentView = NSHostingView(rootView: content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.carbon)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)))
        p.setFrame(frame, display: true)
        p.orderFrontRegardless()
    }

    func setFrame(_ frame: NSRect, duration: TimeInterval) {
        guard let p = panel else { return }
        if duration <= 0 { p.setFrame(frame, display: true); return }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = duration
            ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            p.animator().setFrame(frame, display: true)
        }
    }

    func close() { panel?.orderOut(nil); panel?.contentView = nil }
}
