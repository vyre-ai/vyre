// sight: the Capsule's side of screen context, the side view and voice (ADR 0015).
//
// Everything that reads or moves things on the Mac happens in vyred's modules (screen,
// sideview, voice), each behind its own helper and grant. This extension only asks for it, as
// the "capsule" caller, and shows what came back:
//   - "Side view" and "Side view with Glass" call sideview.open; "Close side view" calls
//     sideview.close. The words are the module's own, success or failure.
//   - "Ask about my screen" calls screen.context once, shows a summary in the side panel, and
//     puts "About <window>: " in the box. A blind place or a secure field is shown as such.
//   - The talk chord (Option-Return, while the Capsule is open and key) starts vyre-mic and
//     streams it to voice's listen stream; pressed again, it stops and leaves the words in the
//     box. Hiding the Capsule stops the mic.
// Nothing runs while the Capsule is hidden, and nothing here polls.

import Foundation
import SwiftUI

/// A screen.context answer, cut down to what the panel shows.
struct ScreenSummary: Equatable {
    var app: String
    var window: String
    var url: String?
    var lines: [String]
    var blind: String?
    var secure: Bool
    var truncated: Bool

    static let maxLines = 8

    init(app: String, window: String, url: String? = nil, lines: [String] = [], blind: String? = nil, secure: Bool = false, truncated: Bool = false) {
        self.app = app; self.window = window; self.url = url; self.lines = lines; self.blind = blind; self.secure = secure; self.truncated = truncated
    }

    static func from(_ data: Any?) -> ScreenSummary? {
        guard let d = data as? [String: Any] else { return nil }
        let app = (d["app"] as? [String: Any])?["name"] as? String ?? ""
        let window = (d["window"] as? [String: Any])?["title"] as? String ?? ""
        let text = d["text"] as? String ?? ""
        var lines: [String] = []
        for l in text.split(whereSeparator: \.isNewline) {
            let t = l.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { continue }
            lines.append(t)
            if lines.count == maxLines { break }
        }
        let url = (d["url"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let blind = (d["blind"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return ScreenSummary(app: app, window: window, url: url, lines: lines, blind: blind,
                             secure: d["secure"] as? Bool ?? false, truncated: d["truncated"] as? Bool ?? false)
    }

    /// What goes in the box, so the next words are a question about this window.
    var prompt: String {
        let name = window.isEmpty ? app : window
        return name.isEmpty ? "About my screen: " : "About \(name): "
    }
}

@MainActor
final class SightModel: ObservableObject {
    @Published var summary: ScreenSummary?
    @Published var talking = false
    @Published var heard = ""
    @Published var line: String?
}

// capsule-extension: SightExtension
@MainActor
final class SightExtension: CapsuleExtension {
    static let id = "sight"
    /// Option-Return: Option-Space is the Capsule's own hot key, and Return with Command or Shift
    /// is taken by its row actions.
    static let talkChord = KeyShortcut("return", option: true)

    private let host: CapsuleHost
    let model = SightModel()
    private var talker: Talker?
    private var preparing = false, stopWanted = false
    /// Bumped on hide, so a press still waiting on voice.status never starts the mic afterwards.
    private var generation = 0
    /// For tests: how the mic and the stream are made. Nil means vyre-mic and vyred's socket.
    var makeMic: (@Sendable (String) -> MicSource)?
    var openStream: Talker.Opener?
    var env: [String: String] = ProcessInfo.processInfo.environment
    var bundleURL: URL = Bundle.main.bundleURL

    init(host: CapsuleHost) { self.host = host }

    var commands: [CapsuleCommand] {
        [
            command("sideview", "Side view", ["split", "tile", "chrome", "session", "side by side"], "rectangle.split.2x1",
                    "This session on the left, Chrome filling the rest") { await $0.sideView(glass: false) },
            command("sideview-glass", "Side view with Glass", ["split", "tile", "glass", "box"], "rectangle.split.2x1.fill",
                    "This session on the left, the box's Glass filling the rest") { await $0.sideView(glass: true) },
            command("sideview-close", "Close side view", ["untile", "restore"], "rectangle",
                    "Put the windows back where they were") { await $0.closeSideView() },
            command("ask-screen", "Ask about my screen", ["screen", "window", "context", "what am i looking at"], "text.viewfinder",
                    "Read the window in front and ask about it") { await $0.askScreen() },
            command("talk", "Talk", ["voice", "dictate", "speak", "mic"], "mic",
                    "Say it instead of typing (Option-Return)") { await $0.talk() },
        ]
    }

    var keyChords: [KeyShortcut] { [Self.talkChord] }

    func handle(chord: KeyShortcut, query: Query) -> Bool {
        guard chord == Self.talkChord else { return false }
        toggleTalk()
        return true
    }

    func sidePanel(for item: ResultItem?) -> AnyView? {
        if let item, item.panel != Self.id { return nil }
        return AnyView(SightPanel(model: model))
    }

    func capsuleDidHide() {
        generation += 1
        preparing = false
        talker?.cancel()
        talker = nil
        model.talking = false
    }

    // MARK: - Side view

    func sideView(glass: Bool) async -> ActionOutcome {
        var input: [String: Any] = ["session": "front"]
        if glass { input["browser"] = "glass" }
        let r = await host.vyred.call("sideview.open", input, presence: false)
        if let e = r.error { return .failed(e) }
        let d = r.data as? [String: Any] ?? [:]
        let left = (d["left"] as? [String: Any])?["app"] as? String ?? "the session"
        let right = (d["right"] as? [String: Any])?["app"] as? String ?? (glass ? "Glass" : "Chrome")
        let exact = d["exact"] as? Bool ?? true
        return .close("\(left) on the left, \(right) on the right" + (exact ? "" : "; a window kept a size of its own"))
    }

    func closeSideView() async -> ActionOutcome {
        let r = await host.vyred.call("sideview.close", [:], presence: false)
        if let e = r.error { return .failed(e) }
        let n = (r.data as? [String: Any])?["restored"] as? Int ?? 0
        return n == 0 ? .said("No side view is open") : .close("Put \(n) window\(n == 1 ? "" : "s") back")
    }

    // MARK: - Ask about my screen

    func askScreen() async -> ActionOutcome {
        let r = await host.vyred.call("screen.context", ["text": true, "textMax": 4000], presence: false)
        if let e = r.error { return .failed(e) }
        guard let s = ScreenSummary.from(r.data) else { return .failed("screen.context answered with nothing to show") }
        model.summary = s
        model.line = nil
        host.showPanel(Self.id)
        if let why = s.blind { return .said("\(s.app.isEmpty ? "This window" : s.app) is off limits: \(why)") }
        return .replaceQuery(s.prompt)
    }

    // MARK: - Talk

    func talk() async -> ActionOutcome {
        toggleTalk()
        return .said(model.talking ? "Listening. Option-Return to stop" : "Stopping")
    }

    func toggleTalk() {
        if let t = talker { t.toggle(); return }
        if preparing { stopWanted = true; return }
        preparing = true; stopWanted = false
        model.talking = true
        model.heard = ""
        model.line = nil
        let gen = generation
        Task { @MainActor in
            // One voice.status first: it says where vyre-mic is and whether a key is saved, so a
            // missing key is said now rather than after the words are spoken.
            let st = await host.vyred.call("voice.status", [:], presence: false)
            guard gen == generation else { return }
            preparing = false
            let d = st.data as? [String: Any] ?? [:]
            if let why = Self.cannotTalk(st.error, d) {
                model.talking = false; model.line = why; host.say(why); return
            }
            let t = makeTalker(mic: d["mic"] as? String)
            talker = t
            t.toggle()
            if stopWanted { t.toggle() }
        }
    }

    /// Why voice cannot start, from voice.status, or nil when it can.
    nonisolated static func cannotTalk(_ error: String?, _ status: [String: Any]) -> String? {
        if let e = error { return e.contains("no_such_tool") || e.contains("no such tool") ? "vyred has no voice module; it needs a vyred with local/voice" : e }
        if status["key"] as? Bool == true { return nil }
        switch status["key_state"] as? String {
        case "not_granted": return "The speech key is saved but not granted to voice. Run: vyre voice key"
        case "no_vault": return "The vault is not available, so there is no speech key"
        default: return "No speech key is saved. Run: vyre voice key"
        }
    }

    private func makeTalker(mic fromStatus: String?) -> Talker {
        let bin = MicPath.resolve(env: env, fromStatus: fromStatus, bundle: bundleURL)
        let mic = makeMic ?? { ProcessMic(bin: $0) }
        let socket = vyredSocketPath(env)
        let open: Talker.Opener = openStream ?? { onMessage, onClose in
            ListenSocket.open(socket: socket, onMessage: onMessage, onClose: onClose).map { $0 as TalkStream }
        }
        return Talker(makeMic: { mic(bin) }, open: open) { [weak self] e in
            Task { @MainActor in self?.talkEvent(e) }
        }
    }

    private func talkEvent(_ e: Talker.Event) {
        switch e {
        case .listening:
            model.talking = true
        case .heard(let text):
            model.heard = text
            host.setQuery(text)
        case .done(let text):
            model.talking = false; talker = nil
            if text.isEmpty { host.say("Nothing heard") } else { model.heard = text; host.setQuery(text) }
        case .failed(let why):
            model.talking = false; talker = nil
            model.line = why
            host.say(why)
        }
    }

    // MARK: -

    private func command(_ id: String, _ title: String, _ keywords: [String], _ symbol: String, _ subtitle: String,
                         _ run: @escaping @MainActor (SightExtension) async -> ActionOutcome) -> CapsuleCommand {
        CapsuleCommand(id: "sight:\(id)", title: title, keywords: keywords, icon: .symbol(symbol, .stone), subtitle: subtitle,
                       actions: [ResultAction(id: "run", title: title, symbol: "return", shortcut: KeyShortcut("return")) { [weak self] _, _ in
                           guard let self else { return .failed("the Capsule is closing") }
                           return await run(self)
                       }])
    }
}
