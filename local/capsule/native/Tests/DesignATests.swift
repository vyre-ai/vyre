// capsule-suite: designASuite
// Design A (docs/design/system/capsule.md): the panel's geometry, the footer's keys by state,
// sentence case, the group order and the copy. Drawn off screen; VYRE_CAPSULE_SNAP writes the
// pictures, as SnapshotTests does.

import AppKit
import SwiftUI

@MainActor private func hints(_ m: CapsuleModel) -> [String] { CapsuleLayout.footerHints(m).map(\.description) }

@MainActor private func answered(_ m: CapsuleModel, finished: Bool, model: String = "haiku") {
    m.asked = "what did alex say about the Northwind menu"
    var r = VyState.reply("t1"); r.model = model; r.finished = finished; r.ok = finished ? true : nil
    r.order = ["m"]; r.text = ["m": "alex asked for the spring menu to go up on the site by Friday."]
    m.reply = r
}

@MainActor private func askWaiting(_ m: CapsuleModel) {
    m.desk.heard(VyredEvent(id: 1, type: "ask.raised", source: "x", thread: "t9", project: nil, at: 1000,
                            payload: ["ask": "a1", "agent": "kit", "tool": "Bash", "summary": "run the Harlow Legal export"]))
    m.desk.mode = .list(0)
}

@MainActor private func picture(_ m: CapsuleModel, _ name: String) {
    guard let dir = ProcessInfo.processInfo.environment["VYRE_CAPSULE_SNAP"] else { return }
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    _ = snapshot(m, name, dir: dir)
}

let designASuite = Suite("design A") { t in
    t.test("the panel's geometry is the spec's") {
        t.eq(Theme.width, 680)
        t.eq(Theme.barHeight, 56)
        t.eq(Theme.rowHeight, 44)
        t.eq(Theme.rowHeight, Tokens.Control.touch)
        t.eq(Theme.headerHeight, 28)
        t.eq(Theme.footerHeight, 32)
        t.eq(Theme.radius, Tokens.Radius.sheet)
        t.eq(CapsuleLayout.area - CapsuleLayout.footerHeight, 472, "the body between the input and the footer")
        let (open, closed, withLine) = MainActor.assumeIsolated { () -> (CGFloat, CGFloat, CGFloat) in
            let m = snapModel(snapRows()); m.text = "sa"
            let body = CapsuleLayout.body(m)
            m.line = "Copied Safari"
            return (CapsuleLayout.panelHeight(m), CapsuleLayout.panelHeight(snapModel([])), body - CapsuleLayout.body(m))
        }
        t.eq(open, 560, "open, the panel is 560")
        t.eq(closed, 56, "closed, the bar alone")
        t.eq(withLine, CapsuleLayout.lineHeight, "a status line takes its height from the body")
    }

    t.test("the footer holds keys only, as the spec's table says") {
        let r = MainActor.assumeIsolated { () -> [String: [String]] in
            var out: [String: [String]] = [:]
            let empty = snapModel([])
            empty.groups = [CapsuleModel.Group(section: .apps, items: [snapRows()[0]])]
            out["nothing typed"] = hints(empty)

            let results = snapModel(snapRows()); results.text = "sa"
            out["results"] = hints(results)

            let question = snapModel([]); question.autoDelay = 60
            question.text = "what did alex say about the Northwind menu"
            out["question"] = hints(question)

            let streaming = snapModel([]); answered(streaming, finished: false)
            out["streaming"] = hints(streaming)

            let follow = snapModel([]); answered(follow, finished: true); follow.commitFollowUp()
            out["follow-up"] = hints(follow)

            let doing = snapModel([]); answered(doing, finished: false); doing.doing = true
            out["using your Mac"] = hints(doing)
            var done = doing.reply!; done.finished = true; done.ok = false; done.error = "stopped"; doing.reply = done
            out["computer use stopped"] = hints(doing)

            let ask = snapModel([]); askWaiting(ask)
            out["ask focused"] = hints(ask)

            let confirm = snapModel(snapRows()); confirm.text = "sa"
            let item = confirm.current!
            confirm.confirming = (item, ResultAction(id: "trash", title: "Move to Trash", confirm: "Move Safari to the Trash?") { _, _ in .close(nil) })
            out["confirming"] = hints(confirm)
            out["confirming status"] = [CapsuleLayout.status(confirm) ?? "none"]

            let said = snapModel(snapRows()); said.text = "sa"; said.line = "Copied Safari"
            out["said"] = hints(said)
            out["said status"] = [CapsuleLayout.status(said) ?? "none"]
            return out
        }
        t.eq(r["nothing typed"], ["↑↓ Move", "⏎ Open", "esc Hide"])
        t.eq(r["results"], ["↑↓ Move", "⏎ Open", "esc Clear"])
        t.eq(r["question"], ["⏎ Ask", "⌘⏎ Think deeper", "esc Clear"])
        t.eq(r["streaming"], ["esc Stop", "⌘⏎ Think deeper"])
        t.eq(r["follow-up"], ["⏎ Ask", "⌘⏎ Think deeper", "⌘O Open in Vyre", "esc Clear"])
        t.eq(r["using your Mac"], ["esc Stop", "⌘O Open in Vyre"])
        t.eq(r["computer use stopped"], ["⌘O Open in Vyre", "esc Clear"])
        t.eq(r["ask focused"], ["A Allow once", "D Deny", "⏎ Review", "esc Close"])
        t.eq(r["confirming"], ["⏎ Confirm", "esc Cancel"])
        t.eq(r["confirming status"], ["Move Safari to the Trash?"], "the question is a line above the footer")
        t.eq(r["said"], r["results"], "what was said is not in the footer")
        t.eq(r["said status"], ["Copied Safari"])
        for (state, h) in r where !state.hasSuffix("status") {
            t.ok(h.count <= 4, "\(state): four hints at most")
            t.ok(!h.contains { $0.contains("result") }, "\(state): no result count in the footer")
        }
    }

    t.test("⌘O shows only with a thread to open") {
        let (none, some) = MainActor.assumeIsolated { () -> ([String], [String]) in
            let m = snapModel([]); answered(m, finished: true); m.commitFollowUp()
            let with = hints(m)
            var r = m.reply!; r.thread = ""; m.reply = r
            return (hints(m), with)
        }
        t.ok(some.contains("⌘O Open in Vyre"))
        t.ok(!none.contains("⌘O Open in Vyre"))
    }

    t.test("headers are drawn as written, in sentence case") {
        let rows = MainActor.assumeIsolated { snapRows() }
        t.eq(CapsuleLayout.heading(CapsuleModel.Group(section: .top, items: [rows[0]])), "Top hit")
        t.eq(CapsuleLayout.heading(CapsuleModel.Group(section: .documents, items: [rows[4]])), "In documents")
        // No caps anywhere the Capsule draws: no .uppercased() on a label, no caps string.
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources")
        let files = ["UI/CapsuleView.swift", "UI/AgentDeskView.swift", "UI/AgentDirectView.swift", "UI/AgentReplyView.swift",
                     "UI/PresenceView.swift", "Extensions/sight/SightPanel.swift"]
        let caps = try! NSRegularExpression(pattern: "\"[A-Z]{2,}[A-Z ·]{2,}")
        for f in files {
            guard let src = try? String(contentsOf: root.appendingPathComponent(f), encoding: .utf8) else { t.ok(false, "read \(f)"); continue }
            for (n, line) in src.components(separatedBy: "\n").enumerated() {
                let code = line.components(separatedBy: "//").first ?? line
                if code.contains("uppercased()") && !code.contains("UTType") && !code.contains("prefix(1)") { t.ok(false, "\(f):\(n + 1) uppercases a label") }
                if caps.firstMatch(in: code, range: NSRange(code.startIndex..., in: code)) != nil { t.ok(false, "\(f):\(n + 1) has a caps label") }
                if code.contains(".tracking(") { t.ok(false, "\(f):\(n + 1) tracks a caps label") }
            }
        }
    }

    t.test("groups keep the spec's order: files, apps, commands, then the rest") {
        t.eq(Array(CapsuleModel.groupOrder.prefix(6)), [.answer, .vyre, .files, .documents, .apps, .commands])
        t.eq(Set(CapsuleModel.groupOrder), Set(Section.allCases.filter { $0 != .top }), "every section still draws")
        let order = MainActor.assumeIsolated { () -> [Section] in
            let run = ResultAction(id: "open", title: "Open", shortcut: KeyShortcut("return")) { _, _ in .close(nil) }
            let rows = [
                ResultItem(id: "p:juno", kind: "person", title: "juno north", subtitle: "", icon: .symbol("person"), section: .people, score: 0.5, actions: [run]),
                ResultItem(id: "c:north", kind: "command", title: "north command", subtitle: "", icon: .symbol("gear"), section: .commands, score: 0.5, actions: [run]),
                ResultItem(id: "a:north", kind: "app", title: "Northwind", subtitle: "", icon: .symbol("app"), section: .apps, score: 0.5, actions: [run]),
                ResultItem(id: "f:north", kind: "file", title: "north menu.pdf", subtitle: "", icon: .symbol("doc"), section: .files, score: 0.5, actions: [run]),
            ]
            let m = snapModel(rows); m.text = "north"
            return m.groups.map(\.section).filter { $0 != .vyre }
        }
        t.eq(order, [.files, .apps, .commands, .people])
    }

    t.test("the copy: the placeholder, and the answer card's header") {
        let r = MainActor.assumeIsolated { () -> [String] in
            let m = snapModel([])
            var out = [CapsuleLayout.placeholder(m)]
            answered(m, finished: true)
            out += [CapsuleLayout.answerTitle(m), CapsuleLayout.answerDepth(m) ?? "none"]
            answered(m, finished: true, model: CapsuleModel.deeperModel)
            out.append(CapsuleLayout.answerDepth(m) ?? "none")
            m.commitFollowUp()
            out.append(CapsuleLayout.placeholder(m))
            m.target = VyreCandidate(kind: .agent, id: "kit", label: "kit")
            out += [CapsuleLayout.placeholder(m), CapsuleLayout.answerTitle(m), CapsuleLayout.answerDepth(m) ?? "none"]
            return out
        }
        t.eq(r, ["Ask Vyre, find, or run", "Vyre IQ", "quick", "deeper", "Ask a follow-up", "Message", "kit", "none"])
    }

    t.test("each Design A state draws") {
        let ok = MainActor.assumeIsolated { () -> Bool in
            let results = snapModel(snapRows()); results.text = "sa"
            picture(results, "a1-results")
            let q = snapModel(snapRows()); q.autoDelay = 60; q.text = "sa"; answered(q, finished: false)
            picture(q, "a2-streaming")
            let f = snapModel([]); answered(f, finished: true, model: CapsuleModel.deeperModel); f.commitFollowUp()
            picture(f, "a3-follow-up-deeper")
            let said = snapModel(snapRows()); said.text = "sa"; said.line = "Copied Safari"
            picture(said, "a4-status-line")
            let ask = snapModel([]); askWaiting(ask)
            picture(ask, "a5-needs-you")
            let empty = snapModel([])
            picture(empty, "a6-empty")
            return snapshot(results, "a1-results", dir: nil)
        }
        t.ok(ok)
    }

    t.test("a passing status shows for its time, then goes; a newer line is kept") {
        let r: [String]? = t.wait {
            let m = await MainActor.run { () -> CapsuleModel in
                let m = CapsuleModel(home: vyScratch("flash"), vyred: VyredClient(socket: vyScratch("flash") + "/none.sock"), providers: [])
                m.flash("Copied", for: 0.1)
                return m
            }
            let first = await MainActor.run { m.line ?? "" }
            try? await Task.sleep(nanoseconds: 300_000_000)
            let gone = await MainActor.run { m.line ?? "gone" }
            await MainActor.run { m.flash("Copied", for: 0.1); m.line = "Could not take it back" }
            try? await Task.sleep(nanoseconds: 300_000_000)
            let kept = await MainActor.run { m.line ?? "gone" }
            return [first, gone, kept, "\(CapsuleLayout.openHeight)"]
        }
        t.eq(r, ["Copied", "gone", "Could not take it back", "560.0"])
    }
}
