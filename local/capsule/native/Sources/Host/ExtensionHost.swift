// ExtensionHost: the Capsule side of the seam in Kit/Extension.swift. It makes one instance of
// every extension build.sh registered, gives each this host, and routes to them: their providers
// and commands into the list, their chords while the panel is key, their side panels, and
// show/hide. Extensions never see the panel, the model or the app delegate.

import AppKit
import ApplicationServices
import CoreGraphics
import SwiftUI

/// One `@` target an extension named, as the model lists it: which extension, the row, the target.
struct ExtensionMention {
    var ext: String
    var candidate: VyreCandidate
    var target: MentionTarget
}

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
        reread()
        model.extensionMentions = { [weak self] q, parent in self?.mentions(q, parent: parent) ?? [] }
        refreshing = Set(extensions.filter(\.refreshesMentions).map { type(of: $0).id })
        model.extensionRefreshers = { [weak self] q, parent in self?.refreshers(q, parent: parent) ?? [] }
        model.extensionPicked = { [weak self] c, parent in self?.picked(c, parent: parent) }
        model.sendToExtension = { [weak self] text, c, parent, query in
            guard let self, let (e, t) = self.targets[c.id] else { return .failed("\(c.label) is not there any more.") }
            // A child goes with the chip it was picked under ("juno" in "WhatsApp").
            return await e.send(text, to: t, in: parent.flatMap { self.targets[$0.id]?.1 }, query: query)
        }
        model.panelFor = { [weak self] item in self?.sidePanel(for: item) }
    }

    /// Read every extension's providers and commands again.
    private func reread() {
        model.extensionProviders = extensions.flatMap(\.providers)
        model.extensionCommands = extensions.flatMap(\.commands)
    }

    func commandsChanged() {
        reread()
        if isShown && !model.text.isEmpty { model.refresh() }
    }

    /// Targets named in the last `@` list, by candidate id, for the send that follows.
    private var targets: [String: (CapsuleExtension, MentionTarget)] = [:]
    /// Extensions that said they have a slower second answer (refreshesMentions), read at load.
    private var refreshing = Set<String>()

    /// The extensions a `@` asks, with what each is told. No chip (`parent` nil): all of them, as
    /// before nesting. A nesting chip: only the extension it came from, with the chip as parent.
    private func asked(_ parent: VyreCandidate?) -> [(CapsuleExtension, MentionContext)] {
        guard let p = parent else { return extensions.map { ($0, .top) } }
        guard let (e, t) = targets[p.id] else { return [] }
        return [(e, MentionContext(parent: t, extensionID: type(of: e).id))]
    }

    /// One target as a candidate row. A child's id carries its chip's (CapsuleModel.childID), so
    /// "juno" in WhatsApp and "juno" in Slack stay two targets.
    private func candidate(_ e: CapsuleExtension, _ t: MentionTarget, _ parent: VyreCandidate?) -> ExtensionMention {
        let id = type(of: e).id
        let c = VyreCandidate(kind: .app, id: parent.map { CapsuleModel.childID($0.id, t.id) } ?? "ext:\(id):\(t.id)",
                              label: t.label, sub: t.sub, last: 0)
        targets[c.id] = (e, t)
        return ExtensionMention(ext: id, candidate: c, target: t)
    }

    /// What the extensions name for the words, answered from memory, on every keystroke.
    func mentions(_ q: String, parent: VyreCandidate? = nil) -> [ExtensionMention] {
        asked(parent).flatMap { e, ctx in e.mentions(matching: q, context: ctx).map { candidate(e, $0, parent) } }
    }

    /// The slower second answer (refreshMentions), one call per extension that has one, for the
    /// model to run side by side and apply as each lands. A call answers nil for nothing new, or
    /// when its task was cancelled while the extension worked.
    func refreshers(_ q: String, parent: VyreCandidate?) -> [@MainActor () async -> (String, [ExtensionMention])?] {
        asked(parent).filter { refreshing.contains(type(of: $0.0).id) }.map { e, ctx in
            { [weak self] in
                guard !Task.isCancelled, let rows = await e.refreshMentions(matching: q, context: ctx),
                      !Task.isCancelled, let self else { return nil }
                return (type(of: e).id, rows.map { self.candidate(e, $0, parent) })
            }
        }
    }

    /// A target became the chip: tell the extension it came from, once.
    func picked(_ c: VyreCandidate, parent: VyreCandidate?) {
        guard let (e, t) = targets[c.id] else { return }
        let under = parent.flatMap { targets[$0.id]?.1 }
        e.mentionPicked(t, context: MentionContext(parent: under, extensionID: under == nil ? nil : type(of: e).id))
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
/// Space, animated by the Capsule. It draws nothing of its own under the extension's view, so a
/// vibrancy material there shows through, and it becomes key when clicked so its fields type.
@MainActor
final class CapsuleSessionWindow: SessionWindow {
    final class Panel: NSPanel {
        override var canBecomeKey: Bool { true }
        override var canBecomeMain: Bool { false }
    }
    private var panel: Panel?

    var isOpen: Bool { panel?.isVisible ?? false }
    var frame: NSRect { panel?.frame ?? .zero }

    func show(_ content: AnyView, frame: NSRect) {
        let p = panel ?? {
            let p = Panel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: true)
            p.level = .normal
            p.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = true
            p.isReleasedWhenClosed = false
            // Key when a click lands on something that takes typing (the prompt field).
            p.becomesKeyOnlyIfNeeded = true
            return p
        }()
        panel = p
        p.contentView = NSHostingView(rootView: content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)))
        p.setFrame(frame, display: true)
        p.orderFrontRegardless()
    }

    func setFrame(_ frame: NSRect, duration: TimeInterval) { setFrame(frame, duration: duration, curve: .easeInOut) }

    func setFrame(_ frame: NSRect, duration: TimeInterval, curve: SessionWindowCurve) {
        guard let p = panel else { return }
        if duration <= 0 { p.setFrame(frame, display: true); return }
        let name: CAMediaTimingFunctionName = switch curve {
        case .easeInOut: .easeInEaseOut
        case .easeOut: .easeOut
        case .easeIn: .easeIn
        case .linear: .linear
        }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = duration
            ctx.timingFunction = CAMediaTimingFunction(name: name)
            p.animator().setFrame(frame, display: true)
        }
    }

    func close() { panel?.orderOut(nil); panel?.contentView = nil }
}
