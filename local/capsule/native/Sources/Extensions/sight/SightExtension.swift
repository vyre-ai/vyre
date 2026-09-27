// sight: the Capsule's side of screen context, the side view and voice (ADR 0015).
//
// Everything that reads or moves things on the Mac happens in vyred's modules (screen,
// sideview, voice), each behind its own helper and grant. This extension only asks for it, as
// the "capsule" caller, and shows what came back:
//   - "Side view" slides the session panel (SessionPanel.swift, in the Capsule's own window) in
//     at the display's left edge with the assistant in it, then has sideview.open fit Chrome
//     (or the box's Glass) beside it; "Side view: <name>" does the same with another session.
//     "Close side view" slides it out and sideview.close puts Chrome back. The module's words
//     are shown as they are, success or failure.
//   - "Ask about my screen" calls screen.context once, shows a summary in the side panel, and
//     puts "About <window>: " in the box. A blind place or a secure field is shown as such.
//   - Words that point at the screen ("summarize this"), or a selection in the app in front,
//     get screen context attached as a chip the user sees and can remove (ScreenAttach.swift).
//     The Capsule's send path asks attachment(for:to:) (SendAttaching) and owns the chip; the
//     session panel does the same for its own prompt.
//   - The talk chord (Option-Return, while the Capsule is open and key) starts vyre-mic and
//     streams it to voice's listen stream; pressed again, it stops and leaves the words in the
//     box. Hiding the Capsule stops the mic.
// Nothing polls. While the session panel is open it follows its session's events with the
// Capsule hidden (runsHidden says so); nothing else runs while the Capsule is hidden.

import AppKit
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
final class SightExtension: CapsuleExtension, SendAttaching {
    static let id = "sight"
    /// Option-Return: Option-Space is the Capsule's own hot key, and Return with Command or Shift
    /// is taken by its row actions.
    static let talkChord = KeyShortcut("return", option: true)

    private let host: CapsuleHost
    let model = SightModel()
    private var talker: Talker?
    private var holdStart: Date?
    private var preparing = false, stopWanted = false
    /// Bumped on hide, so a press still waiting on voice.status never starts the mic afterwards.
    private var generation = 0
    /// For tests: how the mic and the stream are made. Nil means vyre-mic and vyred's socket.
    var makeMic: (@Sendable (String) -> MicSource)?
    var openStream: Talker.Opener?
    var env: [String: String] = ProcessInfo.processInfo.environment
    var bundleURL: URL = Bundle.main.bundleURL
    /// For tests: the display's visible frame and the main display's frame.maxY. Nil means the
    /// screen under the mouse.
    var screen: (() -> (visible: NSRect, primaryMaxY: CGFloat)?)?
    /// How long the slide takes to land before Chrome is fitted beside it. Tests make it zero.
    var settle: Duration = .milliseconds(Int(SideGeometry.duration * 1000) + 20)

    let panel: SessionPanelModel
    private var window: SessionWindow?
    /// Sessions seen at the last show, for the "Side view: <name>" rows.
    private(set) var known: [PanelSession] = []
    /// Following session starts and stops, so the rows (and the panel's tabs) stay current.
    private var sessionSubs: [VyredSubscription] = []
    private var sessionRefresh: Task<Void, Never>?
    /// Where spoken words go: the Capsule's box, or the panel's prompt.
    private var talkToPanel = false

    /// How long the words must rest before the screen is asked about them. Tests shorten it.
    var attachDebounce: Duration = .milliseconds(150)
    /// The newest attachment question: an older one answers with the newest one's answer.
    private var attachSeq = 0
    private var attachLatest: Task<SendAttachment?, Never>?

    /// Screen context for the Capsule's box: read once per show, cleared on hide.
    private(set) lazy var attacher = ScreenAttacher(vyred: host.vyred) { [weak self] in self?.host.log($0) }

    init(host: CapsuleHost) {
        self.host = host
        panel = SessionPanelModel(vyred: host.vyred)
        panel.attacher = ScreenAttacher(vyred: host.vyred) { [weak host] in host?.log($0) }
        panel.onTalk = { [weak self] in self?.toggleTalk(toPanel: true) }
    }

    var panelOpen: Bool { window?.isOpen ?? false }

    var runsHidden: String? {
        panelOpen ? "the session panel is open beside Chrome and follows its session's events until it closes" : nil
    }

    func capsuleWillShow(front: FrontApp?) {
        // Once per show, for the rows below; then only when a session starts or stops. Never on a timer.
        followSessions()
        refreshSessions()
        // The light read, for a selection in the app in front. Nothing is sent from it.
        attacher.prime()
    }

    /// What an Ask from the Capsule's box carries about the screen, or nil. The host shows `chip`
    /// before sending, lets one key remove it, and appends `body` to the words only if it stayed.
    func screenAttachment(for words: String) async -> (id: String, chip: String, bundle: String?, body: String)? {
        guard let c = await attacher.attachment(for: words) else { return nil }
        return (ScreenChip.id, c.chip, c.bundle, c.body)
    }

    /// SendAttaching: the host asks as the words change. Waits for them to rest, then answers from
    /// the snapshot; a newer question supersedes an older one, which gets the newer answer. The
    /// same chip for every kind of send.
    func attachment(for words: String, to: SendTargetKind) async -> SendAttachment? {
        attachSeq += 1
        let mine = attachSeq, wait = attachDebounce
        let task = Task { @MainActor [weak self] () -> SendAttachment? in
            try? await Task.sleep(for: wait)
            guard let self, !Task.isCancelled, mine == self.attachSeq else { return nil }
            guard let a = await self.screenAttachment(for: words), mine == self.attachSeq else { return nil }
            return SendAttachment(id: a.id, chip: a.chip, icon: a.bundle.map { IconSpec.bundle($0) }, body: a.body)
        }
        attachLatest = task
        var answer = await task.value
        // Superseded while waiting: answer with the newest question's answer, until none is newer.
        while mine != attachSeq, let latest = attachLatest, latest != task {
            let seen = attachSeq
            answer = await latest.value
            if seen == attachSeq { break }
        }
        return answer
    }

    var commands: [CapsuleCommand] {
        var list = [
            command("sideview", "Side view", ["split", "tile", "chrome", "session", "side by side", "assistant"], "rectangle.split.2x1",
                    "Your assistant on the left, Chrome filling the rest") { await $0.openPanel(nil, glass: false) },
            command("sideview-glass", "Side view with Glass", ["split", "tile", "glass", "box"], "rectangle.split.2x1.fill",
                    "Your assistant on the left, the box's Glass filling the rest") { await $0.openPanel(nil, glass: true) },
            command("sideview-close", "Close side view", ["untile", "restore"], "rectangle",
                    "Put the windows back where they were") { await $0.closeSideView() },
            command("sideview-terminal", "Side view with this terminal", ["split", "tile", "terminal", "claude code"], "terminal",
                    "The terminal in front on the left, Chrome filling the rest") { await $0.sideView(glass: false) },
        ]
        for s in known where !s.isAssistant {
            list.append(command("sideview-\(s.id)", "Side view: \(s.label)", ["split", "tile", "session", s.label], "rectangle.split.2x1",
                                "\(s.label) on the left, Chrome filling the rest") { await $0.openPanel(s, glass: false) })
        }
        list += [
            command("ask-screen", "Ask about my screen", ["screen", "window", "context", "what am i looking at"], "text.viewfinder",
                    "Read the window in front and ask about it") { await $0.askScreen() },
            command("talk", "Talk", ["voice", "dictate", "speak", "mic"], "mic",
                    "Say it instead of typing (Option-Return)") { await $0.talk() },
        ]
        return list
    }

    var keyChords: [KeyShortcut] { [Self.talkChord] }

    func handle(chord: KeyShortcut, query: Query) -> Bool {
        guard chord == Self.talkChord else { return false }
        // Held: talk while it is down (hold-to-talk). Tapped: talk until the next tap.
        if talker == nil && !preparing { holdStart = Date() } else { holdStart = nil }
        toggleTalk()
        return true
    }

    /// Return came up: a press held longer than a tap stops talking, as a walkie-talkie does.
    func handleUp(key: String) -> Bool {
        guard key == "return", let t0 = holdStart else { return false }
        holdStart = nil
        guard Date().timeIntervalSince(t0) >= Self.holdAfter, model.talking else { return false }
        toggleTalk()
        return true
    }

    /// Longer than this, the talk chord was held rather than tapped.
    static let holdAfter: TimeInterval = 0.35

    func sidePanel(for item: ResultItem?) -> AnyView? {
        if let item, item.panel != Self.id { return nil }
        return AnyView(SightPanel(model: model))
    }

    func capsuleDidHide() {
        attachSeq += 1
        attachLatest?.cancel(); attachLatest = nil
        attacher.reset()
        // The panel's tabs keep following while it is open; otherwise nothing runs hidden.
        if !panelOpen { unfollowSessions() }
        // Talk started from the panel keeps going: the panel is where its words land.
        if talkToPanel && panelOpen { return }
        stopTalk()
    }

    private func stopTalk() {
        generation += 1
        preparing = false
        talker?.cancel()
        talker = nil
        model.talking = false
        panel.talking = false
    }

    // MARK: - The session panel

    func loadSessions() async -> [PanelSession] {
        async let a = host.vyred.has("agents.list") ? host.vyred.call("agents.list", [:], presence: false) : nil
        async let t = host.vyred.has("threads.list") ? host.vyred.call("threads.list", [:], presence: false) : nil
        async let c = host.vyred.has("projects.catalog") ? host.vyred.call("projects.catalog", ["limit": 30, "human": true], presence: false) : nil
        let (agents, threads, catalog) = await (a, t, c)
        return PanelSession.load(agents: agents?.data, threads: threads?.data, catalog: catalog?.data)
    }

    /// Session starts and stops, from vyred's events. A terminal session vyred does not run shows
    /// up on the next show (the index has no event of its own).
    func followSessions() {
        guard sessionSubs.isEmpty else { return }
        for pattern in ["thread.started", "thread.stopped"] {
            sessionSubs.append(host.vyred.on(pattern) { [weak self] _ in self?.refreshSessions() })
        }
    }

    func unfollowSessions() {
        sessionSubs.forEach { $0.cancel() }
        sessionSubs = []
        sessionRefresh?.cancel(); sessionRefresh = nil
    }

    var followingSessions: Bool { !sessionSubs.isEmpty }

    /// Read the sessions again and, if the list changed, tell the Capsule its rows changed and
    /// give the panel its new tabs.
    func refreshSessions() {
        sessionRefresh?.cancel()
        sessionRefresh = Task { @MainActor [weak self] in
            guard let self else { return }
            let next = await loadSessions()
            guard !Task.isCancelled else { return }
            let changed = next.map { "\($0.id) \($0.label)" } != known.map { "\($0.id) \($0.label)" }
            known = next
            if panelOpen { panel.sessions = next }
            if changed { host.commandsChanged() }
        }
    }

    /// Waits for a refresh started by an event or a show, for tests.
    func sessionsSettled() async { await sessionRefresh?.value }

    private func currentScreen() -> (visible: NSRect, primaryMaxY: CGFloat)? {
        if let screen { return screen() }
        let mouse = NSEvent.mouseLocation
        guard let s = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main,
              let primary = NSScreen.screens.first else { return nil }
        return (s.visibleFrame, primary.frame.maxY)
    }

    /// Slide the panel in with a session (the assistant when nil), then fit Chrome beside it.
    func openPanel(_ session: PanelSession?, glass: Bool) async -> ActionOutcome {
        let sessions = await loadSessions()
        known = sessions
        guard let pick = session.flatMap({ s in sessions.first { $0.id == s.id } ?? s }) ?? sessions.first(where: \.isAssistant) ?? sessions.first else {
            return .failed("No session to show yet: make your assistant in Vyre, or start a session")
        }
        guard let geo = currentScreen() else { return .failed("No display to put the side view on") }
        let target = SideGeometry.panel(geo.visible)
        let w = window ?? host.sessionWindow(owner: Self.id)
        window = w
        panel.sessions = sessions
        panel.start()
        followSessions()
        if w.isOpen {
            w.setFrame(target, duration: SideGeometry.duration, curve: .easeOut)
        } else {
            w.show(AnyView(SessionPanelView(model: panel) { [weak self] in Task { @MainActor in _ = await self?.closeSideView() } }),
                   frame: SideGeometry.offscreen(target))
            w.setFrame(target, duration: SideGeometry.duration, curve: .easeOut)
        }
        let history = Task { @MainActor in await panel.show(pick) }
        if settle > .zero { try? await Task.sleep(for: settle) }
        var input: [String: Any] = ["panel": SideGeometry.axFrame(target, primaryMaxY: geo.primaryMaxY)]
        if glass { input["browser"] = "glass" }
        let r = await host.vyred.call("sideview.open", input, presence: false)
        await history.value
        if let e = r.error { panel.line = e; return .failed("\(pick.label) is on the left; Chrome could not be fitted: \(e)") }
        let d = r.data as? [String: Any] ?? [:]
        let right = (d["right"] as? [String: Any])?["app"] as? String ?? (glass ? "Glass" : "Chrome")
        return .close("\(pick.label) on the left, \(right) on the right")
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
        var hadPanel = false
        if let w = window, w.isOpen {
            hadPanel = true
            if talkToPanel { stopTalk() }
            w.setFrame(SideGeometry.offscreen(w.frame), duration: SideGeometry.duration, curve: .easeIn)
            panel.stop()
            if settle > .zero { try? await Task.sleep(for: settle) }
            w.close()
            if !host.isShown { unfollowSessions() }
        }
        let r = await host.vyred.call("sideview.close", [:], presence: false)
        if let e = r.error { return .failed(e) }
        let n = (r.data as? [String: Any])?["restored"] as? Int ?? 0
        if n == 0 && !hadPanel { return .said("No side view is open") }
        return .close(n == 0 ? "Closed the side view" : "Put \(n) window\(n == 1 ? "" : "s") back")
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

    func toggleTalk(toPanel: Bool = false) {
        if let t = talker { t.toggle(); return }
        if preparing { stopWanted = true; return }
        preparing = true; stopWanted = false
        talkToPanel = toPanel && panelOpen
        model.talking = true
        panel.talking = talkToPanel
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
                model.talking = false; panel.talking = false
                if talkToPanel { panel.line = why } else { model.line = why; host.say(why) }
                return
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
        let open: Talker.Opener = openStream ?? Listen.opener(host.vyred)
        return Talker(makeMic: { mic(bin) }, open: open) { [weak self] e in
            Task { @MainActor in self?.talkEvent(e) }
        }
    }

    private func talkEvent(_ e: Talker.Event) {
        switch e {
        case .listening:
            model.talking = true
            panel.talking = talkToPanel
        case .heard(let text):
            model.heard = text
            put(text, final: false)
        case .done(let text):
            model.talking = false; panel.talking = false; talker = nil
            if text.isEmpty { say("Nothing heard"); if !talkToPanel { host.dictate("", final: true) } } else { model.heard = text; put(text, final: true) }
        case .failed(let why):
            model.talking = false; panel.talking = false; talker = nil
            model.line = why
            say(why)
        }
    }

    private func put(_ text: String, final: Bool) { if talkToPanel { panel.draft = text } else { host.dictate(text, final: final) } }
    private func say(_ line: String) { if talkToPanel { panel.line = line } else { host.say(line) } }

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
