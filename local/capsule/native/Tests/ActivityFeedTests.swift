// capsule-suite: activityFeedSuite
// The conversation view's fold and its stills (SPEC-0.3.0 11.5): a thinking line that opens, steps that tick from running to done, a hand-off with
// the teammate's steps nested under it and its report-back, a replay that repeats nothing. Stills of four moments (dark and light) go to
// VYRE_CAPSULE_SNAP for the CI artifact.

import AppKit
import SwiftUI

private func frame(_ cur: Int, _ kind: String, _ data: [String: Any], author: String? = nil, message: String? = nil) -> [String: Any] {
    var f: [String: Any] = ["v": 1, "cur": cur, "type": "chat.\(kind)", "data": data]
    if let author { f["author"] = author }
    if let message { f["message"] = message }
    return f
}
private func handoff(_ cur: Int, _ state: String, thread: String? = nil, result: String? = nil) -> [String: Any] {
    var d: [String: Any] = ["request": "r_1", "to": ["agent": "kit-billing", "role": "billing", "name": "kit", "project": "northwind"], "text": "chase the overdue invoices this week", "state": state, "at": 1]
    if let thread { d["thread"] = thread }
    if let result { d["result"] = result }
    return frame(cur, "handoff", d, author: "assistant:juno")
}
private func via(_ cur: Int, _ kind: String, _ data: [String: Any], message: String? = nil) -> [String: Any] {
    var d = data; d["via"] = "r_1"
    return frame(cur, kind, d, author: "assistant:kit-billing", message: message)
}

/// The conversation up to a moment: 1 thinking and a step running, 2 steps done and a hand-off queued, 3 the teammate working, 4 the report-back and the reply.
private func feed(upTo moment: Int) -> ActivityFeed {
    var f = ActivityFeed()
    var frames: [[String: Any]] = [
        frame(1, "status", ["state": "working"]),
        frame(2, "user-message", ["text": "Chase the overdue invoices, and tell me what Northwind owes.", "message": "u1"]),
        frame(3, "text-delta", ["text": "Three invoices are over thirty days.\nBilling should chase them; I will look at Northwind first.", "reasoning": true, "index": 0], author: "assistant:juno", message: "m1"),
        frame(4, "tool-started", ["tool_id": "t1", "tool": "records.search", "summary": "Looking up overdue invoices"], author: "assistant:juno"),
    ]
    if moment >= 2 {
        frames += [
            frame(5, "tool-finished", ["tool_id": "t1", "ok": true], author: "assistant:juno"),
            handoff(6, "queued"),
        ]
    }
    if moment >= 3 {
        frames += [
            handoff(7, "running", thread: "ses_kit"),
            via(8, "tool-started", ["tool_id": "k1", "tool": "mail.draft", "summary": "Drafting three reminders"]),
            via(9, "tool-finished", ["tool_id": "k1", "ok": true]),
            via(10, "tool-started", ["tool_id": "k2", "tool": "records.log", "summary": "Logging each on its client"]),
        ]
    }
    if moment >= 4 {
        frames += [
            via(11, "tool-finished", ["tool_id": "k2", "ok": true]),
            handoff(12, "done", thread: "ses_kit", result: "Three reminders drafted for Northwind, Oakline and Brightwell. Each waits for your yes."),
            frame(13, "text-delta", ["text": "Kit drafted three reminders. Northwind owes $4,200 across two invoices."], author: "assistant:juno", message: "m2"),
            frame(14, "text-done", [:], author: "assistant:juno", message: "m2"),
            frame(15, "text-done", [:], author: "assistant:juno", message: "m1"),
            frame(16, "status", ["state": "finished"]),
        ]
    }
    for fr in frames { f.apply(fr) }
    return f
}

@MainActor private func activityStill<V: View>(_ v: V, size: CGSize, dark: Bool, _ name: String, dir: String?) -> Bool {
    let host = NSHostingView(rootView: v.frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(dark ? Color(red: 0.094, green: 0.086, blue: 0.075) : Color(red: 0.98, green: 0.976, blue: 0.96)))
    host.frame = NSRect(origin: .zero, size: size)
    host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    host.layoutSubtreeIfNeeded()
    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return false }
    host.cacheDisplay(in: host.bounds, to: rep)
    if let dir, let png = rep.representation(using: .png, properties: [:]) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
    }
    return rep.pixelsWide > 0
}

let activityFeedSuite = Suite("activity feed") { t in
    t.test("the header state follows the status frames and the work in flight") {
        var f = ActivityFeed()
        t.eq(f.headerState, "")
        f.apply(frame(1, "status", ["state": "working"]))
        t.eq(f.headerState, "working")
        f.apply(frame(2, "text-delta", ["text": "Let me look.", "reasoning": true, "index": 0], author: "assistant:juno", message: "m1"))
        t.eq(f.headerState, "thinking")
        f.apply(frame(3, "ask", ["ask_id": "a1", "title": "Send three emails"]))
        f.apply(frame(4, "status", ["state": "asking"]))
        t.eq(f.headerState, "waiting for you")
        f.apply(frame(5, "status", ["state": "finished"]))
        t.eq(f.headerState, "", "finished, with nothing running, says nothing")
    }

    t.test("the thinking line is the latest line of the latest thought, and the whole of it is kept") {
        var f = ActivityFeed()
        f.apply(frame(1, "text-delta", ["text": "First thought.\nSecond line", "reasoning": true, "index": 0], author: "assistant:juno", message: "m1"))
        t.eq(f.thinkingLine, "Second line")
        f.apply(frame(2, "text-delta", ["text": " continues", "reasoning": true, "index": 0], author: "assistant:juno", message: "m1"))
        t.eq(f.thinkingLine, "Second line continues")
        f.apply(frame(3, "text-delta", ["text": "Another.", "reasoning": true, "index": 1], author: "assistant:juno", message: "m1"))
        t.eq(f.thinkingAll, "First thought.\nSecond line continues\n\nAnother.")
        t.ok(f.thinkingNow)
        f.apply(frame(4, "text-done", [:], author: "assistant:juno", message: "m1"))
        t.ok(!f.thinkingNow)
    }

    t.test("a step ticks from running to done, or fails; a frame that repeats changes nothing") {
        var f = ActivityFeed()
        f.apply(frame(1, "tool-started", ["tool_id": "t1", "tool": "records.search", "summary": "Looking up invoices"]))
        t.eq(f.runningSteps, 1)
        t.ok(!f.apply(frame(1, "tool-started", ["tool_id": "t1", "tool": "records.search"])), "the same cursor is dropped")
        f.apply(frame(2, "tool-finished", ["tool_id": "t1", "ok": true]))
        f.apply(frame(3, "tool-started", ["tool_id": "t2", "tool": "mail.send", "summary": "Sending"]))
        f.apply(frame(4, "tool-finished", ["tool_id": "t2", "ok": false]))
        let steps = f.rows.compactMap { r -> ActivityFeed.Step? in if case .step(let s) = r { return s } else { return nil } }
        t.eq(steps.map(\.status.rawValue), ["done", "failed"])
        t.eq(f.runningSteps, 0)
        t.eq(f.cursor, 4)
    }

    t.test("a hand-off is one row whose state is replaced, the teammate's frames nest under it, and the report-back is its result") {
        let f = feed(upTo: 4)
        let hand = f.rows.compactMap { r -> ActivityFeed.Handoff? in if case .handoff(let h) = r { return h } else { return nil } }
        t.eq(hand.count, 1)
        t.eq(hand.first?.label, "Asked kit (billing)")
        t.eq(hand.first?.state, .done)
        t.eq(hand.first?.thread, "ses_kit")
        t.eq(hand.first?.project, "northwind")
        t.eq(hand.first?.children.count, 2, "the teammate's two steps are inside the hand-off, not beside it")
        t.ok(hand.first?.result?.hasPrefix("Three reminders drafted") == true)
        let top = f.rows.filter { if case .step = $0 { return true } else { return false } }
        t.eq(top.count, 1, "only the asker's own step is at the top")
        // an ended hand-off never goes back to running
        var g = f
        g.apply(handoff(99, "running"))
        if case .handoff(let h) = g.rows.first(where: { if case .handoff = $0 { return true } else { return false } })! { t.eq(h.state, .done) }
    }

    t.test("a resume that replays the log from the start repeats nothing, and a reset starts over") {
        var f = feed(upTo: 3)
        let before = f.rows
        for n in 1...10 { f.apply(frame(n, "user-message", ["text": "again", "message": "u\(n)"])) }
        t.eq(f.rows, before)
        f.apply(frame(30, "reset", ["head": 29]))
        t.eq(f.rows.count, 0)
        t.eq(f.cursor, 29)
    }

    t.test("a teammate's frames that arrive before their hand-off keep together under a placeholder") {
        var f = ActivityFeed()
        f.apply(via(5, "tool-started", ["tool_id": "k1", "tool": "mail.draft", "summary": "Drafting"]))
        f.apply(handoff(6, "running", thread: "ses_kit"))
        let hand = f.rows.compactMap { r -> ActivityFeed.Handoff? in if case .handoff(let h) = r { return h } else { return nil } }
        t.eq(hand.count, 1)
        t.eq(hand.first?.children.count, 1)
        t.eq(hand.first?.name, "kit")
    }

    t.test("stills: the thinking line and a running step, the hand-off queued, the teammate working, the report-back and the reply (dark and light)") {
        let dir = ProcessInfo.processInfo.environment["VYRE_CAPSULE_SNAP"].flatMap { $0.isEmpty ? nil : $0 }
        MainActor.assumeIsolated {
            let names = [1: "thinking-and-a-step", 2: "handoff-queued", 3: "teammate-working", 4: "report-back"]
            for moment in 1...4 {
                for dark in [true, false] {
                    let view = ActivityView(feed: feed(upTo: moment), title: "juno", project: "northwind", mark: .assistant(fingerprint8: nil, name: "juno"), openInApp: {})
                    t.ok(activityStill(view, size: CGSize(width: 680, height: 420), dark: dark, "lumen-activity-\(moment)-\(names[moment]!)-\(dark ? "dark" : "light")", dir: dir), "\(moment)")
                }
            }
            // the thinking line opened
            let open = ActivityView(feed: feed(upTo: 1), title: "juno", project: "northwind", mark: .assistant(fingerprint8: nil, name: "juno"), thinkingOpen: true, openInApp: {})
            t.ok(activityStill(open, size: CGSize(width: 680, height: 420), dark: true, "lumen-activity-1-thinking-open-dark", dir: dir))
        }
    }
}
