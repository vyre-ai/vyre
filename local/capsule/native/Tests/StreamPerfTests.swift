// capsule-suite: streamSuite
// An answer streaming into the Capsule, measured against native-core's budgets
// (docs/design/native-bar.md): event to paint, first token, steady streaming (characters per frame
// and the gap between visible updates), no size change while streaming, and Esc to "stopped".
// A panel of our own, far off screen and never key. The stream is bursty on purpose, as the SDK's
// is: runs of small deltas, pauses, then a large chunk, with tool calls starting and ending
// between them. Events go through VyState.applyReply exactly as the live follower's do.

import AppKit
import Foundation

struct StreamReport {
    var paint: [Double] = []
    var firstToken: Double = 0
    /// Visible characters added in each 16 ms frame while the answer streamed.
    var perFrame: [Double] = []
    /// Gaps between frames in which the visible text changed, in ms.
    var gaps: [Double] = []
    var sizeChanges = 0
    var stopMs: Double = 0
    var busy: [Double] = []

    static func pct(_ xs: [Double], _ q: Double) -> Double { let s = xs.sorted(); return s.isEmpty ? 0 : s[min(s.count - 1, Int(Double(s.count) * q))] }
    var p95: Double { Self.pct(paint, 0.95) }
    var gapP95: Double { Self.pct(gaps, 0.95) }
    /// Coefficient of variation of characters per frame, over the frames from the first visible
    /// character to the last (Paseo's gate).
    var cv: Double {
        guard perFrame.count > 1 else { return 0 }
        let m = perFrame.reduce(0, +) / Double(perFrame.count)
        guard m > 0 else { return 0 }
        let v = perFrame.reduce(0) { $0 + ($1 - m) * ($1 - m) } / Double(perFrame.count)
        return v.squareRoot() / m
    }
    var line: String {
        String(format: "event-to-paint p95 %.2f ms (max %.2f); first token %.2f ms; chars per frame CV %.2f; visible-update gap p95 %.0f ms; size changes %d; Esc to stopped %.2f ms; longest main-thread pass %.2f ms",
               p95, paint.max() ?? 0, firstToken, cv, gapP95, sizeChanges, stopMs, busy.max() ?? 0)
    }
}

/// The bursty fake stream: (ms after start, event type, payload).
func burstyStream(thread: String = "t1", turn: String = "t1:1") -> [(Double, String, [String: Any])] {
    var out: [(Double, String, [String: Any])] = []
    var t = 40.0
    let words = "The Northwind Bakery menu has twelve items. Prices went up by ten percent on the pastries and stayed flat on bread. Two items are new this week: a rye sourdough and a cardamom bun. ".split(separator: " ").map(String.init)
    var w = 0
    out.append((0, "thread.turn", ["turn": turn, "uuid": "u1", "text": "summarize the menu"]))
    out.append((5, "thread.state", ["turn": turn, "state": "running"]))
    for round in 0..<8 {
        out.append((t, "thread.tool", ["turn": turn, "id": "c\(round)", "call": "c\(round)", "name": "Read", "summary": "Read menu-\(round).md", "phase": "start", "status": "running"]))
        t += 60
        // A run of small deltas, 20 ms apart.
        for _ in 0..<10 { out.append((t, "thread.text", ["turn": turn, "message": "m1", "delta": words[w % words.count] + " "])); w += 1; t += 20 }
        out.append((t, "thread.tool", ["turn": turn, "id": "c\(round)", "call": "c\(round)", "phase": "done", "status": round == 5 ? "failed" : "completed"]))
        // A pause, then one large chunk.
        t += 180
        out.append((t, "thread.text", ["turn": turn, "message": "m1", "delta": (0..<14).map { words[($0 + w) % words.count] }.joined(separator: " ") + " "])); w += 14
        t += 30
    }
    out.append((t, "thread.usage", ["turn": turn, "cost_usd": 0.004, "total_cost_usd": 0.03]))
    return out
}

@MainActor func streamOnce(pace: Bool = true) -> StreamReport {
    let v = VyredClient(socket: vyScratch("stream") + "/none.sock")
    let model = CapsuleModel(home: vyScratch("stream-home"), vyred: v, providers: [])
    let pc = PanelController(model: model)
    pc.showOffscreen()
    var report = StreamReport()
    var woke: UInt64 = 0
    var spans: [Double] = []
    let obs = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { _, act in
        let now = DispatchTime.now().uptimeNanoseconds
        if act == .afterWaiting { woke = now } else if woke != 0 { spans.append(Double(now - woke) / 1e6); woke = 0 }
    }
    CFRunLoopAddObserver(CFRunLoopGetMain(), obs, .commonModes)
    defer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), obs, .commonModes) }
    func pump(_ ms: Double) { RunLoop.main.run(until: Date().addingTimeInterval(ms / 1000)) }
    func paintNow() { pc.host.layoutSubtreeIfNeeded(); pc.panel.displayIfNeeded() }

    model.text = "summarize the menu"
    model.asked = "summarize the menu"
    model.reply = Reply(thread: "t1")
    paintNow()
    pump(50)
    let startFrames = pc.frameChanges
    let events = burstyStream()
    let t0 = Date()
    var i = 0, lastLen = 0, firstSeen = false, lastChange: Date?
    var streaming = true
    while streaming {
        let now = Date().timeIntervalSince(t0) * 1000
        // Everything due by now arrives, as the follower would hand it over.
        while i < events.count, events[i].0 <= now {
            let (_, type, payload) = events[i]
            let e = VyredEvent(id: i + 1, type: type, source: "box", thread: "t1", project: nil, at: 0, payload: payload)
            let a = DispatchTime.now().uptimeNanoseconds
            if let r = model.reply { model.reply = VyState.applyReply(r, e) }
            paintNow()
            let ms = Double(DispatchTime.now().uptimeNanoseconds - a) / 1e6
            report.paint.append(ms)
            if type == "thread.text" && !firstSeen { firstSeen = true; report.firstToken = ms }
            i += 1
        }
        pump(16)
        // One frame: what is on screen now.
        let len = model.visibleReplyCount
        if firstSeen {
            report.perFrame.append(Double(len - lastLen))
            if len != lastLen { let d = Date(); if let l = lastChange { report.gaps.append(d.timeIntervalSince(l) * 1000) }; lastChange = d }
        }
        lastLen = len
        streaming = i < events.count || len < model.replyText.count
        if Date().timeIntervalSince(t0) > 15 { break }
    }
    // Trailing zero frames after the last character are not part of the stream.
    while report.perFrame.last == 0 { report.perFrame.removeLast() }
    report.sizeChanges = max(0, pc.frameChanges - startFrames)
    // Esc: the state line says stopped in the same pass.
    model.reply?.finished = false
    let s0 = DispatchTime.now().uptimeNanoseconds
    model.stopReply()
    paintNow()
    report.stopMs = Double(DispatchTime.now().uptimeNanoseconds - s0) / 1e6
    report.busy = spans
    pc.hide()
    pc.panel.orderOut(nil)
    return report
}

let streamSuite = Suite("stream") { t in
    t.test("a bursty answer streams smoothly: native-core's budgets") {
        let r = MainActor.assumeIsolated { () -> StreamReport in
            _ = streamOnce()
            return streamOnce()
        }
        print("stream\(ProcessInfo.processInfo.environment["VYRE_CAPSULE_OPT"] == "1" ? " (optimised)" : " (debug build)"): " + r.line)
        let env = ProcessInfo.processInfo.environment
        let onCI = env["CI"] != nil || env["GITHUB_ACTIONS"] != nil
        let timed = env["VYRE_CAPSULE_OPT"] == "1" && !onCI
        if timed {
            t.ok(r.firstToken < 100, "first token \(r.firstToken) ms (budget 2)")
            t.ok(r.p95 < 16, "event to paint p95 \(r.p95) ms")
            t.ok(r.stopMs < 100, "Esc to stopped \(r.stopMs) ms (budget 10)")
        }
        // Shape, not speed: checked on every build.
        t.ok(r.cv < 2, "characters per frame CV \(r.cv) (budget 4)")
        t.ok(r.gapP95 < 250, "visible-update gap p95 \(r.gapP95) ms (budget 4)")
        t.eq(r.sizeChanges, 0, "size changes while streaming (budget 5)")
    }
}
