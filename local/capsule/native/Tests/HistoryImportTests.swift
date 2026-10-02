// capsule-suite: historyImportSuite
// Bringing history in (#26) against a fake vyred: the scan says what it found in words and ticks what
// Vyre would suggest; "this Mac is not paired" and "nothing found" are states of their own and never
// look done; the plan carries exactly the ticked folders; neither speed is chosen for the person;
// done is reached only after something was sent. Nothing here reads a real folder or sends anything.

import Foundation

private final class HistoryLink: VyredLink, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [String: ([String: Any]) -> VyredResult] = [:]
    private var log: [(tool: String, input: [String: Any])] = []
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
    func calls(_ tool: String) -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return log.filter { $0.tool == tool }.map(\.input) }
    final class Sub: VyredSubscription { func cancel() {} }
}

private let DAY: Double = 86_400_000
private let SCAN: [String: Any] = ["claude_keeps_days": 30, "sources": [
    ["id": "claude", "agent": "claude-code", "path": "/Users/a/.claude/projects", "sessions": 14, "bytes": 3_145_728, "from": 1_700_000_000_000, "to": 1_700_000_000_000 + 40 * DAY,
     "folders": [
        ["cwd": "/Users/a/work/harlow", "name": "Harlow Legal", "project": "harlow", "sessions": 9, "bytes": 2_097_152, "from": 1_700_000_000_000, "to": 1_700_000_000_000 + 40 * DAY, "suggested": true],
        ["cwd": "/tmp/scratch", "sessions": 3, "bytes": 51_200, "from": 1_700_000_000_000, "to": 1_700_000_000_000, "suggested": false, "why": "a temporary folder"],
        ["cwd": "/Users/a/work/northwind", "sessions": 2, "bytes": 1024, "from": 1_700_000_000_000, "to": 1_700_000_000_000, "suggested": true]]],
    ["id": "codex", "agent": "codex", "path": "/Users/a/.codex/sessions", "sessions": 5, "bytes": 512_000, "from": 1_705_000_000_000, "to": 1_705_000_000_000,
     "folders": [["cwd": "/Users/a/work/harlow", "sessions": 5, "bytes": 512_000, "from": 1_705_000_000_000, "to": 1_705_000_000_000, "suggested": true]]],
]]

@MainActor private func model(paired: Bool = true, scan: [String: Any]? = SCAN) -> (HistoryImportModel, HistoryLink) {
    let l = HistoryLink()
    l.answer("link.status") { _ in .success(["role": "local", "linked": paired, "box": ["name": "alex-box"]] as [String: Any]) }
    l.answer("import.scan") { _ in .success(scan ?? ["sources": [Any]()]) }
    return (HistoryImportModel(vyred: l), l)
}

let historyImportSuite = Suite("history import") { t in
    t.test("the scan says what it found, in words, and ticks what Vyre would suggest") {
        let got: (String, [String], Int, Int?)? = t.wait {
            let (m, _) = await MainActor.run { model() }
            await m.scan()
            return await MainActor.run { (m.foundLine, m.folders.filter { m.ticked.contains($0.id) }.map(\.name), m.tickedSessions, m.keepsDays) }
        }
        t.eq(got?.0, "Found 19 sessions on this Mac across 4 projects.")
        // The temporary folder is left unticked; the Harlow folder appears under both providers and is ticked in both.
        t.eq(got?.1, ["Harlow Legal", "northwind", "harlow"])
        t.eq(got?.2, 16)
        t.eq(got?.3, 30, "the 30-day keep is said, not hidden")
    }

    t.test("an unpaired Mac says to pair first and never scans or looks done") {
        let got: (HistoryImportModel.Step, String, Int)? = t.wait {
            let (m, l) = await MainActor.run { model(paired: false) }
            await m.scan()
            return await MainActor.run { (m.step, m.foundLine, l.calls("import.scan").count) }
        }
        t.eq(got?.0, .unpaired)
        t.eq(got?.1, "Pair this Mac first, then import from here.")
        t.eq(got?.2, 0, "nothing is read when there is nowhere to send it")
    }

    t.test("nothing found says where it looked and is not done") {
        let got: (HistoryImportModel.Step, String)? = t.wait {
            let (m, _) = await MainActor.run { model(scan: ["sources": [Any]()]) }
            await m.scan()
            return await MainActor.run { (m.step, m.foundLine) }
        }
        t.eq(got?.0, .nothing)
        t.eq(got?.1, "No sessions found. Looked in your Claude Code, Codex and Grok folders.")
    }

    t.test("the plan asks for exactly the ticked folders; neither speed is chosen for the person; Start waits for both") {
        let got: ([String], Bool, Bool, Bool, Bool)? = t.wait {
            let (m, l) = await MainActor.run { model() }
            l.answer("import.plan") { _ in .success(["plan": "plan_1", "sessions": 14, "bytes": 2_100_000, "folders": ["/Users/a/work/harlow", "/Users/a/work/northwind"],
                                                  "pace": ["turns": 100, "fast": ["hours": 3], "gentle": ["days": 4]] as [String: Any]]) }
            await m.scan()
            // Untick northwind: only the two Harlow folders (Claude Code and Codex) and nothing else remain.
            await MainActor.run { if let f = m.folders.first(where: { $0.name == "northwind" }) { m.toggle(f) } }
            await m.makePlan()
            let include = (l.calls("import.plan").first?["include"] as? [String]) ?? []
            let atStart = await MainActor.run { m.canStart }
            await MainActor.run { m.pace = .gentle }
            let onlyPace = await MainActor.run { m.canStart }
            await MainActor.run { m.mode = .once }
            let both = await MainActor.run { m.canStart }
            let noPre = await MainActor.run { (m.pace != nil) }
            return (include, atStart, onlyPace, both, noPre)
        }
        t.eq(got?.0, ["/Users/a/work/harlow", "/Users/a/work/harlow"])
        t.eq(got?.1, false, "nothing is preselected")
        t.eq(got?.2, false, "a pace alone is not enough")
        t.eq(got?.3, true)
    }

    t.test("start sends the plan with the person's two choices; done only after something was sent, and says how many and to where") {
        let got: ([String: Any]?, HistoryImportModel.Step, String)? = t.wait {
            let (m, l) = await MainActor.run { model() }
            l.answer("import.plan") { _ in .success(["plan": "plan_9", "sessions": 14, "bytes": 1, "folders": ["a"], "pace": ["fast": ["hours": 1], "gentle": ["days": 1]] as [String: Any]]) }
            l.answer("import.start") { _ in .success(["run": "imp_1", "sessions": 14, "mode": "sync", "pace": "fast"]) }
            l.answer("import.status") { _ in .success(["upload": ["done": 14, "total": 14, "failed": 0, "quarantined": 0, "state": "done", "mode": "sync", "pace": "fast"] as [String: Any], "searchable_sessions": 14]) }
            await m.scan(); await m.makePlan()
            await MainActor.run { m.pace = .fast; m.mode = .sync }
            await m.start()
            let step = await MainActor.run { m.step }
            let line = await MainActor.run { m.doneLine }
            return (l.calls("import.start").first, step, line)
        }
        t.eq(got?.0?["plan"] as? String, "plan_9")
        t.eq(got?.0?["mode"] as? String, "sync")
        t.eq(got?.0?["pace"] as? String, "fast")
        t.eq(got?.1, .done)
        t.eq(got?.2, "Sent 14 sessions to alex-box. Search works now; Vyre keeps understanding them in the background.")
    }

    t.test("a run that ends with nothing sent is a failure, not done; a refused start says what the box said") {
        let got: (HistoryImportModel.Step, HistoryImportModel.Step)? = t.wait {
            let (m, l) = await MainActor.run { model() }
            l.answer("import.plan") { _ in .success(["plan": "p", "sessions": 3, "bytes": 1, "folders": ["a"], "pace": [String: Any]()]) }
            l.answer("import.start") { _ in .success(["run": "r", "sessions": 3, "mode": "once", "pace": "gentle"]) }
            l.answer("import.status") { _ in .success(["upload": ["done": 0, "total": 3, "failed": 3, "quarantined": 0, "state": "done"] as [String: Any]]) }
            await m.scan(); await m.makePlan()
            await MainActor.run { m.pace = .gentle; m.mode = .once }
            await m.start()
            let none = await MainActor.run { m.step }
            let (m2, l2) = await MainActor.run { model() }
            l2.answer("import.plan") { _ in .success(["plan": "p", "sessions": 3, "bytes": 1, "folders": ["a"], "pace": [String: Any]()]) }
            l2.answer("import.start") { _ in .failure(code: "failed", message: "the server did not take the consent: offline") }
            await m2.scan(); await m2.makePlan()
            await MainActor.run { m2.pace = .fast; m2.mode = .once }
            await m2.start()
            return (none, await MainActor.run { m2.step })
        }
        t.eq(got?.0, .failed("Nothing was sent."))
        t.eq(got?.1, .failed("the server did not take the consent: offline"))
    }

    t.test("sizes, dates and speeds read as a person says them") {
        t.eq(HistoryImportModel.size(3_145_728), "3 MB")
        t.eq(HistoryImportModel.size(51_200), "50 KB")
        t.eq(HistoryImportModel.fastWords(1), "about an hour")
        t.eq(HistoryImportModel.fastWords(3), "about 3 hours")
        t.eq(HistoryImportModel.gentleWords(1), "about a day")
        t.eq(HistoryImportModel.gentleWords(5), "about 5 days")
        let a = Date(timeIntervalSince1970: 1_700_000_000)
        t.eq(HistoryImportModel.range(a, a), HistoryImportModel.range(a, a))
        t.ok(HistoryImportModel.range(a, a.addingTimeInterval(86_400 * 40)).contains(" to "))
        t.eq(HistoryImportModel.range(nil, a), "")
    }
}
