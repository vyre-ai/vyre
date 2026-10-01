// capsule-suite: searchSliceSuite
// The keystroke path: a first slice of rows, the rest on the next turn; one letter asks only what is
// already here; a newer key cancels an older slow search.

import Foundation

private final class Quick: ResultProvider, ImmediateResults, @unchecked Sendable {
    let id = "quick"; let speed = Speed.quick
    let sections: [Section]
    init(_ s: [Section]) { sections = s }
    func results(for q: Query) async -> [ResultItem] { resultsNow(for: q) }
    func resultsNow(for q: Query) -> [ResultItem] {
        sections.flatMap { s in (0..<4).map { i in ResultItem(id: "\(s.rawValue)-\(i)", kind: "x", title: "Row \(s.rawValue) \(i)", section: s, score: 0.5) } }
    }
}

private final class Slow: ResultProvider, @unchecked Sendable {
    let id = "slow"; let speed = Speed.full
    private let lock = NSLock()
    private(set) var asked: [String] = []
    private(set) var cancelled = 0
    func results(for q: Query) async -> [ResultItem] {
        lock.withLock { asked.append(q.text) }
        try? await Task.sleep(nanoseconds: 400_000_000)
        if Task.isCancelled { lock.withLock { cancelled += 1 } }
        return [ResultItem(id: "slow-\(q.text)", kind: "file", title: "slow \(q.text)", section: .files, score: 0.5)]
    }
    var log: ([String], Int) { lock.withLock { (asked, cancelled) } }
}

let searchSliceSuite = Suite("search slice") { t in
    t.test("the first paint is a slice of 8 rows; the next turn brings the rest") {
        MainActor.assumeIsolated {
            let v = FakeVyred(name: "slice")
            let m = CapsuleModel(home: vyScratch("slice-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket),
                                 providers: [Quick([.apps, .files, .commands, .people])])
            m.text = "ro"
            t.ok(m.flat.filter { $0.kind == "x" }.count <= CapsuleModel.firstSlice, "\(m.flat.count) rows at the first paint")
            t.ok(spin2 { m.flat.filter { $0.kind == "x" }.count == 16 }, "all 16 after the next turn: \(m.flat.count)")
        }
    }

    t.test("one letter asks only the quick local providers, and shows at most 20 rows") {
        MainActor.assumeIsolated {
            let v = FakeVyred(name: "slice1")
            let slow = Slow()
            let m = CapsuleModel(home: vyScratch("slice1-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket),
                                 providers: [Quick([.apps, .files, .commands, .people, .calendar, .windows, .mail]), slow])
            m.text = "a"
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
            t.eq(slow.log.0, [], "the slow provider is not asked for one letter")
            t.ok(m.flat.filter { $0.kind == "x" }.count <= CapsuleModel.oneLetterRows, "\(m.flat.count) rows")
            t.ok(m.flat.filter { $0.kind == "x" }.count >= 12)
            m.text = "ab"
            t.ok(spin2 { slow.log.0 == ["ab"] }, "asked at two letters: \(slow.log.0)")
        }
    }

    t.test("a newer key cancels the slow search the older one started") {
        MainActor.assumeIsolated {
            let v = FakeVyred(name: "slice2")
            let slow = Slow()
            let m = CapsuleModel(home: vyScratch("slice2-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [slow])
            m.text = "ab"
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            m.text = "abc"
            t.ok(spin2 { slow.log.1 >= 1 && slow.log.0.count == 2 }, "\(slow.log)")
            t.ok(spin2 { m.flat.contains { $0.title == "slow abc" } })
            t.ok(!m.flat.contains { $0.title == "slow ab" }, "the older answer is never shown")
        }
    }
}

private func spin2(_ cond: () -> Bool) -> Bool { MainActor.assumeIsolated { until(3, cond) } }
