// The sight extension against a fake vyred and a fake host: no real mic, no window, no dialog.
// The listen stream goes through the host's VyredLink.stream, whose socket and framing are
// capsule-pro's and tested there; here a fake link hands back a fake stream.

import AppKit
import Foundation
import SwiftUI

private final class SightLink: VyredLink, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [String: ([String: Any]) -> VyredResult] = [:]
    private var log: [(String, [String: Any])] = []
    var isUp: Bool { true }
    func answer(_ tool: String, _ fn: @escaping ([String: Any]) -> VyredResult) { lock.lock(); answers[tool] = fn; lock.unlock() }
    func has(_ tool: String) -> Bool { lock.lock(); defer { lock.unlock() }; return answers[tool] != nil }
    func call(_ tool: String, _ input: [String: Any], presence: Bool) async -> VyredResult {
        record(tool, input)?(input) ?? .failure(code: "no_such_tool", message: "no such tool: \(tool)")
    }
    private func record(_ tool: String, _ input: [String: Any]) -> (([String: Any]) -> VyredResult)? {
        lock.lock(); defer { lock.unlock() }; log.append((tool, input)); return answers[tool]
    }
    func on(_ pattern: String, _ handler: @escaping @MainActor (VyredEvent) -> Void) -> VyredSubscription { Sub() }
    func calls(_ tool: String) -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return log.filter { $0.0 == tool }.map(\.1) }
    var streamResult: Result<VyredStream, VyredStreamFailure> = .failure(VyredStreamFailure(code: "refused", message: "no stream in this test"))
    private var paths: [String] = []
    var streamPaths: [String] { lock.lock(); defer { lock.unlock() }; return paths }
    func stream(_ path: String, onMessage: @escaping @Sendable ([String: Any]) -> Void,
                onClose: @escaping @Sendable () -> Void) async -> Result<VyredStream, VyredStreamFailure> {
        opened(path)
    }
    private func opened(_ path: String) -> Result<VyredStream, VyredStreamFailure> {
        lock.lock(); defer { lock.unlock() }; paths.append(path); return streamResult
    }
    final class Sub: VyredSubscription { func cancel() {} }
}

@MainActor
private final class SightHost: CapsuleHost {
    let vyred: VyredLink
    var front: FrontApp? = FrontApp(bundle: "com.apple.Terminal", pid: 4242, name: "Terminal")
    var isShown = true
    var panels: [String] = []
    var queries: [String] = []
    var said: [String] = []
    var submits = 0
    var cancels: [String] = []
    /// What toggleTalk()'s baseline capture reads: set by a test before starting, as if typed.
    var box = ""
    init(_ link: VyredLink) { vyred = link }
    func permission(_ p: Permission) -> PermissionState { .notAsked }
    func request(_ p: Permission, reason: String) async -> Bool { false }
    func showPanel(_ extensionID: String) { panels.append(extensionID) }
    func hidePanel() {}
    func setQuery(_ text: String) { queries.append(text); box = text }
    func currentQuery() -> String { box }
    // dictate(_:final:) keeps the protocol's own default (setQuery), same as production.
    func submitDictation() { submits += 1 }
    func cancelDictation(_ restore: String) { cancels.append(restore); box = restore }
    func say(_ line: String) { said.append(line) }
    var needs: [CredentialNeed] = []
    var onSaved: (@MainActor () -> Void)?
    func askCredential(_ need: CredentialNeed, saved: @escaping @MainActor () -> Void) { needs.append(need); onSaved = saved }
    func stepAside() async -> Bool { false }
    func notify(title: String, body: String) { said.append(title) }
    func log(_ message: String) {}
    func sessionWindow(owner: String) -> SessionWindow { SightWindow() }
}

@MainActor
private final class SightWindow: SessionWindow {
    var isOpen = false
    var frame: NSRect = .zero
    func show(_ content: AnyView, frame: NSRect) { isOpen = true; self.frame = frame }
    func setFrame(_ frame: NSRect, duration: TimeInterval) { self.frame = frame }
    func close() { isOpen = false }
}

private final class FakeMic: MicSource, @unchecked Sendable {
    let lock = NSLock()
    var onData: (@Sendable (Data) -> Void)?
    var onExit: (@Sendable (Int32, String) -> Void)?
    var stops = 0
    var refuse: String?
    func start(onData: @escaping @Sendable (Data) -> Void, onExit: @escaping @Sendable (Int32, String) -> Void) -> String? {
        if let r = refuse { return r }
        lock.lock(); self.onData = onData; self.onExit = onExit; lock.unlock(); return nil
    }
    func stop() { lock.lock(); stops += 1; lock.unlock() }
    func say(_ d: Data) { lock.lock(); let f = onData; lock.unlock(); f?(d) }
    func exit(_ code: Int32, _ err: String = "") { lock.lock(); let f = onExit; lock.unlock(); f?(code, err) }
    var stopped: Int { lock.lock(); defer { lock.unlock() }; return stops }
}

private final class FakeStream: TalkStream, @unchecked Sendable {
    let lock = NSLock()
    var sent: [String] = []
    var closed = false
    func sendBinary(_ d: Data) { lock.lock(); sent.append("pcm:\(d.count)"); lock.unlock() }
    func sendJSON(_ obj: [String: Any]) { lock.lock(); sent.append("json:\(obj["type"] ?? "")"); lock.unlock() }
    func close() { lock.lock(); closed = true; lock.unlock() }
    var log: [String] { lock.lock(); defer { lock.unlock() }; return sent }
    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }
}

private final class Events: @unchecked Sendable {
    let lock = NSLock()
    var all: [Talker.Event] = []
    func add(_ e: Talker.Event) { lock.lock(); all.append(e); lock.unlock() }
    var list: [Talker.Event] { lock.lock(); defer { lock.unlock() }; return all }
}

/// Block on a semaphore off the cooperative pool, so an async opener can be held open by a test.
private func hold(_ gate: DispatchSemaphore) async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        DispatchQueue.global().async { gate.wait(); c.resume() }
    }
}

/// Poll until cond holds (up to 3 s), from async test code that is off the main actor.
private func until(_ cond: @Sendable () async -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(3)
    while !(await cond()) {
        if Date() > end { return false }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return true
}

/// Spin until cond holds (up to 3 s), keeping the main run loop turning.
private func settle(_ cond: () -> Bool) -> Bool {
    let until = Date().addingTimeInterval(3)
    while !cond() {
        if Date() > until { return false }
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
    }
    return true
}

private let NORTHWIND: [String: Any] = [
    "app": ["name": "Notes", "bundle": "com.apple.Notes", "pid": 4242],
    "window": ["title": "Northwind Bakery order"],
    "url": NSNull(),
    "text": "Northwind Bakery order\n\n  two dozen rolls  \nfor alex at Harlow Legal",
    "secure": false, "truncated": false,
]

// capsule-suite: sightSuite
let sightSuite = Suite("sight") { t in
    t.test("summary: app, window, first lines, and the prompt it puts in the box") {
        let s = ScreenSummary.from(NORTHWIND)
        t.eq(s?.app, "Notes"); t.eq(s?.window, "Northwind Bakery order"); t.eq(s?.url, nil)
        t.eq(s?.lines, ["Northwind Bakery order", "two dozen rolls", "for alex at Harlow Legal"])
        t.eq(s?.prompt, "About Northwind Bakery order: ")
        let many = ScreenSummary.from(["app": ["name": "kit"], "text": (1...20).map { "line \($0)" }.joined(separator: "\n")])
        t.eq(many?.lines.count, ScreenSummary.maxLines); t.eq(many?.prompt, "About kit: ")
        let blind = ScreenSummary.from(["app": ["name": "Passwords"], "window": ["title": "Passwords"], "blind": "a password manager"])
        t.eq(blind?.blind, "a password manager"); t.eq(blind?.lines, [])
        t.ok(ScreenSummary.from("nope") == nil)
    }

    t.test("side view: opens through sideview.open, Glass on the variant, and says the module's words") {
        let link = SightLink()
        link.answer("sideview.open") { input in
            .success(["open": true, "exact": true, "left": ["app": "Terminal"], "right": ["app": input["browser"] == nil ? "Google Chrome" : "Google Chrome"]])
        }
        link.answer("sideview.close") { _ in .success(["open": false, "restored": 2]) }
        let r = t.wait { @MainActor () -> [ActionOutcome] in
            let ext = SightExtension(host: SightHost(link))
            return [await ext.sideView(glass: false), await ext.sideView(glass: true), await ext.closeSideView()]
        }
        t.eq(r?[0], .close("Terminal on the left, Google Chrome on the right"))
        t.eq(r?[2], .close("Put 2 windows back"))
        let calls = link.calls("sideview.open")
        t.eq(calls.count, 2)
        t.eq(calls.first?["session"] as? String, "front"); t.ok(calls.first?["browser"] == nil)
        t.eq(calls.last?["browser"] as? String, "glass")
    }

    t.test("side view: a failure is the module's words, never a success") {
        let link = SightLink()
        link.answer("sideview.open") { _ in .failure(code: "not_trusted", message: "grant Accessibility to Terminal in System Settings") }
        let r = t.wait { @MainActor in await SightExtension(host: SightHost(link)).sideView(glass: false) }
        t.eq(r, .failed("grant Accessibility to Terminal in System Settings"))
        let none = t.wait { @MainActor in await SightExtension(host: SightHost(SightLink())).closeSideView() }
        t.eq(none, .failed("no such tool: sideview.close"))
    }

    t.test("ask: reads once, shows the panel, and puts the window in the box") {
        let link = SightLink()
        link.answer("screen.context") { _ in .success(NORTHWIND) }
        let r = t.wait { @MainActor () -> (ActionOutcome, [String], ScreenSummary?) in
            let host = SightHost(link)
            let ext = SightExtension(host: host)
            let o = await ext.askScreen()
            return (o, host.panels, ext.model.summary)
        }
        t.eq(r?.0, .replaceQuery("About Northwind Bakery order: "))
        t.eq(r?.1, ["sight"]); t.eq(r?.2?.lines.count, 3)
        t.eq(link.calls("screen.context").first?["text"] as? Bool, true)
    }

    t.test("ask: a blind place is said as off limits and puts nothing in the box") {
        let link = SightLink()
        link.answer("screen.context") { _ in .success(["app": ["name": "Passwords"], "window": ["title": "Passwords"], "blind": "a password manager"]) }
        let r = t.wait { @MainActor in await SightExtension(host: SightHost(link)).askScreen() }
        t.eq(r, .said("Passwords is off limits: a password manager"))
    }

    t.test("panel and chord: its own panel only, Option-Return only") {
        let ok = MainActor.assumeIsolated { () -> [Bool] in
            let ext = SightExtension(host: SightHost(SightLink()))
            let other = ResultItem(id: "x", kind: "file", title: "x", panel: "files")
            let mine = ResultItem(id: "y", kind: "sight", title: "y", panel: "sight")
            return [ext.sidePanel(for: nil) != nil, ext.sidePanel(for: other) == nil, ext.sidePanel(for: mine) != nil,
                    ext.keyChords == [KeyShortcut("return", option: true)], !ext.handle(chord: KeyShortcut("space", option: true), query: Query("")),
                    ext.runsHidden == nil]
        }
        t.eq(ok, [true, true, true, true, true, true])
    }

    t.test("talk: no key asks for it in the panel (never a terminal command); no voice module is said") {
        t.eq(SightExtension.cannotTalk(nil, ["key": true]), nil)
        t.eq(SightExtension.cannotTalk(nil, ["key": false, "key_state": "missing"]), "No speech key is saved yet.")
        t.eq(SightExtension.cannotTalk(nil, ["key": false, "key_state": "not_granted"]), "The speech key is saved but voice may not use it yet. Allow it in the vault.")
        t.ok(SightExtension.keyNeed(["key_state": "not_granted"]) == nil && SightExtension.keyNeed(["key_state": "no_vault"]) == nil)
        t.eq(SightExtension.keyNeed(["key_state": "missing", "provider": "deepgram", "item": "voice-deepgram-key", "need": ["module": "voice", "need": "deepgram"]])?.item, "voice-deepgram-key")
        t.eq(SightExtension.cannotTalk("no such tool: voice.status", [:]), "vyred has no voice module; it needs a vyred with local/voice")
        let mic = FakeMic()
        let said = t.wait { () -> [String] in
            let link = SightLink()
            link.answer("voice.status") { _ in .success(["key": false, "key_state": "missing"]) }
            let (host, ext) = await MainActor.run { () -> (SightHost, SightExtension) in
                let host = SightHost(link)
                let ext = SightExtension(host: host)
                ext.makeMic = { _ in mic }
                ext.toggleTalk()
                return (host, ext)
            }
            _ = await until { await MainActor.run { !host.needs.isEmpty } }
            _ = ext
            return await MainActor.run { host.needs.map { "\($0.module) \($0.need) \($0.label) \($0.item ?? "")" } + host.said }
        }
        t.eq(said, ["voice deepgram Deepgram key voice-deepgram-key"], "the key row, and nothing said about a terminal")
        t.ok(mic.onData == nil, "the mic never started")
    }

    t.test("talk: early audio is held until the stream opens, end follows the mic, words land in the box") {
        let mic = FakeMic(), stream = FakeStream()
        let box = ResultBox<@Sendable ([String: Any]) -> Void>()
        let gate = DispatchSemaphore(value: 0)
        let r = t.wait { () -> ([String], Bool, Bool) in
            let link = SightLink()
            link.answer("voice.status") { _ in .success(["key": true, "mic": "/nowhere/vyre-mic"]) }
            let bins = ResultBox<String>()
            let (host, ext) = await MainActor.run { () -> (SightHost, SightExtension) in
                let host = SightHost(link)
                let ext = SightExtension(host: host)
                ext.env = [:]
                ext.makeMic = { bin in bins.value = bin; return mic }
                ext.openStream = { onMessage, _ in box.value = onMessage; await hold(gate); return .success(stream) }
                ext.toggleTalk()
                return (host, ext)
            }
            _ = await until { mic.onData != nil }
            mic.say(Data(count: 3200)); mic.say(Data(count: 3200))
            gate.signal()
            _ = await until { stream.log.count == 2 }
            box.value?(["type": "partial", "text": "two dozen"])
            _ = await until { await MainActor.run { host.queries == ["two dozen"] } }
            await MainActor.run { ext.toggleTalk() }
            _ = await until { mic.stopped == 1 }
            mic.exit(0)
            _ = await until { stream.log.last == "json:end" }
            box.value?(["type": "final", "text": "two dozen rolls"])
            box.value?(["type": "done", "text": "two dozen rolls"])
            _ = await until { await MainActor.run { !ext.model.talking } }
            let q = await MainActor.run { host.queries }
            return (q, stream.isClosed, bins.value == "/nowhere/vyre-mic")
        }
        t.eq(stream.log, ["pcm:3200", "pcm:3200", "json:end"])
        t.eq(r?.0.last, "two dozen rolls"); t.eq(r?.1, true); t.eq(r?.2, true, "the mic path came from voice.status")
    }

    t.test("talk: words land after what the box already held, and \"send it\" submits at once") {
        let mic = FakeMic(), stream = FakeStream()
        let box = ResultBox<@Sendable ([String: Any]) -> Void>()
        let r = t.wait { () -> ([String], Int, Bool) in
            let link = SightLink()
            link.answer("voice.status") { _ in .success(["key": true, "mic": "/nowhere/vyre-mic"]) }
            let (host, ext) = await MainActor.run { () -> (SightHost, SightExtension) in
                let host = SightHost(link)
                host.box = "Email Dana: "
                let ext = SightExtension(host: host)
                ext.makeMic = { _ in mic }
                ext.openStream = { onMessage, _ in box.value = onMessage; return .success(stream) }
                ext.toggleTalk()
                return (host, ext)
            }
            _ = await until { mic.onData != nil && box.value != nil }
            box.value?(["type": "partial", "text": "two dozen"])
            _ = await until { await MainActor.run { host.queries.last == "Email Dana: two dozen" } }
            box.value?(["type": "final", "text": "two dozen rolls send it"])
            _ = await until { await MainActor.run { host.submits == 1 } }
            return await MainActor.run { (host.queries, host.submits, mic.stopped == 1) }
        }
        t.eq(r?.0.last, "Email Dana: two dozen rolls")
        t.eq(r?.1, 1, "submitDictation() ran exactly once")
        t.ok(r?.2 == true, "the mic stops once \"send it\" fires, without waiting for its own done")
    }

    t.test("talk: \"scratch that\" undoes only the phrase this final just added") {
        let mic = FakeMic(), stream = FakeStream()
        let box = ResultBox<@Sendable ([String: Any]) -> Void>()
        let r = t.wait { () -> [String] in
            let link = SightLink()
            link.answer("voice.status") { _ in .success(["key": true, "mic": "/nowhere/vyre-mic"]) }
            let (host, ext) = await MainActor.run { () -> (SightHost, SightExtension) in
                let host = SightHost(link)
                let ext = SightExtension(host: host)
                ext.makeMic = { _ in mic }
                ext.openStream = { onMessage, _ in box.value = onMessage; return .success(stream) }
                ext.toggleTalk()
                return (host, ext)
            }
            _ = await until { mic.onData != nil && box.value != nil }
            box.value?(["type": "final", "text": "two dozen rolls"])
            _ = await until { await MainActor.run { host.queries.last == "two dozen rolls" } }
            // The server's own "final" is cumulative: the words just spoken ("for alex") plus the
            // command phrase itself, appended to what was already committed.
            box.value?(["type": "final", "text": "two dozen rolls for alex scratch that"])
            _ = await until { await MainActor.run { host.queries.last == "two dozen rolls" && host.said.contains { $0.contains("scratch that") } } }
            return await MainActor.run { host.queries }
        }
        t.eq(r?.last, "two dozen rolls", "\"for alex\" is undone; the earlier phrase stays")
    }

    t.test("talk: \"new line\" strips the words and adds one") {
        let mic = FakeMic(), stream = FakeStream()
        let box = ResultBox<@Sendable ([String: Any]) -> Void>()
        let r = t.wait { () -> [String] in
            let link = SightLink()
            link.answer("voice.status") { _ in .success(["key": true, "mic": "/nowhere/vyre-mic"]) }
            let (host, ext) = await MainActor.run { () -> (SightHost, SightExtension) in
                let host = SightHost(link)
                let ext = SightExtension(host: host)
                ext.makeMic = { _ in mic }
                ext.openStream = { onMessage, _ in box.value = onMessage; return .success(stream) }
                ext.toggleTalk()
                return (host, ext)
            }
            _ = await until { mic.onData != nil && box.value != nil }
            box.value?(["type": "final", "text": "line one new line"])
            _ = await until { await MainActor.run { host.queries.last == "line one\n" } }
            return await MainActor.run { host.queries }
        }
        t.eq(r?.last, "line one\n")
    }

    t.test("talk: Esc cancels and restores exactly what the box held; the mic is dropped, not asked") {
        let mic = FakeMic(), stream = FakeStream()
        let box = ResultBox<@Sendable ([String: Any]) -> Void>()
        let r = t.wait { () -> ([String], [String], Bool) in
            let link = SightLink()
            link.answer("voice.status") { _ in .success(["key": true, "mic": "/nowhere/vyre-mic"]) }
            let (host, ext) = await MainActor.run { () -> (SightHost, SightExtension) in
                let host = SightHost(link)
                host.box = "About Northwind: "
                let ext = SightExtension(host: host)
                ext.makeMic = { _ in mic }
                ext.openStream = { onMessage, _ in box.value = onMessage; return .success(stream) }
                ext.toggleTalk()
                return (host, ext)
            }
            _ = await until { mic.onData != nil && box.value != nil }
            box.value?(["type": "partial", "text": "two dozen"])
            _ = await until { await MainActor.run { host.queries.last == "About Northwind: two dozen" } }
            let cancelled = await MainActor.run { ext.cancelTalking() }
            _ = await until { mic.stopped == 1 }
            return await MainActor.run { (host.cancels, host.queries, cancelled) }
        }
        t.eq(r?.0, ["About Northwind: "], "restored to exactly the pre-dictation baseline")
        t.eq(r?.1.last, "About Northwind: two dozen", "the last live partial is untouched -- cancelDictation is a separate call")
        t.eq(r?.2, true)
        t.ok(mic.stopped == 1, "cancel() stops the mic straight away, never sending its audio on")
    }

    t.test("talk: an ordinary Return stops the mic (keeping the words) without submitting on its own") {
        let mic = FakeMic(), stream = FakeStream()
        let box = ResultBox<@Sendable ([String: Any]) -> Void>()
        let r = t.wait { () -> (Int, Bool, Bool) in
            let link = SightLink()
            link.answer("voice.status") { _ in .success(["key": true, "mic": "/nowhere/vyre-mic"]) }
            let (host, ext) = await MainActor.run { () -> (SightHost, SightExtension) in
                let host = SightHost(link)
                let ext = SightExtension(host: host)
                ext.makeMic = { _ in mic }
                ext.openStream = { onMessage, _ in box.value = onMessage; return .success(stream) }
                ext.toggleTalk()
                return (host, ext)
            }
            _ = await until { mic.onData != nil && box.value != nil }
            box.value?(["type": "partial", "text": "two dozen rolls"])
            _ = await until { await MainActor.run { host.queries.last == "two dozen rolls" } }
            let stopped = await MainActor.run { ext.stopTalking() } // what Panel.swift's plain-Return case calls
            _ = await until { mic.stopped == 1 }
            return await MainActor.run { (host.submits, stopped, !ext.model.talking) }
        }
        t.eq(r?.0, 0, "stopTalking() never submits by itself -- the caller (⏎'s own handleReturn) does that")
        t.eq(r?.1, true)
        t.eq(r?.2, true, "the Listening state ends at once, not only once the mic's own .done arrives")
    }

    t.test("talk: 2 minutes with nothing new nudges once; 5 minutes stops (never sends)") {
        let mic = FakeMic(), stream = FakeStream()
        let box = ResultBox<@Sendable ([String: Any]) -> Void>()
        let clock = ManualClock()
        let r = t.wait { () -> (Bool, Int, Bool) in
            let link = SightLink()
            link.answer("voice.status") { _ in .success(["key": true, "mic": "/nowhere/vyre-mic"]) }
            let (host, ext) = await MainActor.run { () -> (SightHost, SightExtension) in
                let host = SightHost(link)
                let ext = SightExtension(host: host)
                ext.makeMic = { _ in mic }
                ext.openStream = { onMessage, _ in box.value = onMessage; return .success(stream) }
                ext.clock = clock
                ext.toggleTalk()
                return (host, ext)
            }
            _ = await until { mic.onData != nil && box.value != nil }
            // Listening began: the two timers wait at 120 s and 300 s.
            _ = await until { await MainActor.run { clock.pending.count == 2 } }
            await MainActor.run { clock.advance(119) }
            let early = await MainActor.run { host.said.contains { $0.contains("Still listening?") } }
            await MainActor.run { clock.advance(2) }
            let nudged = await MainActor.run { host.said.contains { $0.contains("Still listening?") } }
            let stillOn = await MainActor.run { ext.model.talking }
            await MainActor.run { clock.advance(200) }
            _ = await until { mic.stopped == 1 }
            return await MainActor.run { (!early && nudged && stillOn, host.submits, !ext.model.talking) }
        }
        t.eq(r?.0, true)
        t.eq(r?.1, 0, "the auto-stop never sends")
        t.eq(r?.2, true)
    }

    t.test("talk: a mic that fails says its own words; hiding stops the mic and says nothing") {
        let events = Events()
        let mic = FakeMic(), stream = FakeStream()
        let talker = Talker(makeMic: { mic }, open: { _, _ in .success(stream) }, emit: { events.add($0) })
        talker.toggle()
        t.ok(settle { mic.onExit != nil && events.list.count == 1 })
        mic.exit(1, "{\"code\":\"not_granted\",\"error\":\"grant the Microphone to vyre-mic\"}\n")
        t.ok(settle { events.list.count == 2 })
        t.eq(events.list, [.listening, .failed("grant the Microphone to vyre-mic")])
        t.ok(settle { stream.isClosed })

        let quiet = Events()
        let mic2 = FakeMic(), stream2 = FakeStream()
        let t2 = Talker(makeMic: { mic2 }, open: { _, _ in .success(stream2) }, emit: { quiet.add($0) })
        t2.toggle()
        t.ok(settle { quiet.list.count == 1 && mic2.onData != nil })
        t2.cancel()
        t.ok(settle { stream2.isClosed && mic2.stopped == 1 })
        t.eq(quiet.list, [.listening]); t.eq(t2.isLive, false)

        let refused = Events()
        let mic3 = FakeMic(); mic3.refuse = MicPath.notBuilt("/repo/local/voice/bin/vyre-mic")
        let t3 = Talker(makeMic: { mic3 }, open: { _, _ in .success(FakeStream()) }, emit: { refused.add($0) })
        t3.toggle()
        t.ok(settle { refused.list.count == 2 })
        t.eq(refused.list.last, .failed("vyre-mic is not built. Build it with: sh /repo/local/voice/build.sh"))
    }

    t.test("talk: onLevel is the frame's RMS (scaled), throttled, and 0 once it finishes") {
        let mic = FakeMic(), stream = FakeStream()
        let levels = ResultBox<[Double]>(); levels.value = []
        let talker = Talker(makeMic: { mic }, open: { _, _ in .success(stream) }, emit: { _ in },
                            onLevel: { l in levels.value = (levels.value ?? []) + [l] })
        talker.toggle()
        t.ok(settle { mic.onData != nil })
        // Full-scale square wave: RMS is 1 exactly, so the *4 scaling clamps to 1, not blows past it.
        var loud = Data(count: 3200)
        loud.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            for i in stride(from: 0, to: raw.count, by: 2) { raw[i] = 0xff; raw[i + 1] = 0x7f } // Int16.max, little-endian
        }
        mic.say(loud)
        t.ok(settle { (levels.value?.count ?? 0) >= 1 })
        t.eq(levels.value?.last, 1.0)
        // A second frame inside the same ~90 ms window is throttled away, not a second reading.
        mic.say(Data(count: 3200))
        t.eq(levels.value?.count, 1, "throttled: still just the one reading")
        talker.cancel()
        t.ok(settle { levels.value?.last == 0 }, "finish() reports the level back to 0")
    }

    t.test("mic path: env, then voice.status, then next to the app in the repo") {
        let app = URL(fileURLWithPath: "/r/local/capsule/native/.build/Vyre.app")
        t.eq(MicPath.resolve(env: ["VYRE_MIC_BIN": "/x/mic"], fromStatus: "/s/mic", bundle: app), "/x/mic")
        t.eq(MicPath.resolve(env: [:], fromStatus: "/s/mic", bundle: app), "/s/mic")
        t.eq(MicPath.resolve(env: [:], fromStatus: nil, bundle: app), "/r/local/voice/bin/vyre-mic")
    }

    t.test("listen: the opener goes through VyredLink.stream, and a 404 names the voice module") {
        let link = SightLink()
        let stream = FakeStream()
        let open = Listen.opener(link)
        let r = t.wait { () -> (Result<TalkStream, TalkFailure>, Result<TalkStream, TalkFailure>, Result<TalkStream, TalkFailure>) in
            link.streamResult = .success(stream)
            let ok = await open({ _ in }, {})
            link.streamResult = .failure(VyredStreamFailure(code: "not_found", message: "vyred has no stream at /v1/streams/voice/listen"))
            let missing = await open({ _ in }, {})
            link.streamResult = .failure(VyredStreamFailure(code: "unreachable", message: "vyred is not running; vyre up to start it"))
            return (ok, missing, await open({ _ in }, {}))
        }
        guard let (ok, missing, down) = r else { t.ok(false, "the opener did not answer"); return }
        if case .success(let s) = ok { t.ok(s === stream, "the link's stream is used as is") } else { t.ok(false, "open failed: \(ok)") }
        t.eq(link.streamPaths, ["/v1/streams/voice/listen", "/v1/streams/voice/listen", "/v1/streams/voice/listen"])
        if case .failure(let f) = missing {
            t.eq(f, TalkFailure(code: "no_voice", message: "vyred has no voice module; it needs a vyred with local/voice"))
        } else { t.ok(false, "a 404 must fail") }
        if case .failure(let f) = down { t.eq(f.code, "unreachable") } else { t.ok(false, "a missing vyred must fail") }
    }
}
