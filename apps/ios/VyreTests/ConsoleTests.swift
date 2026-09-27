import XCTest
@testable import Vyre

final class ConsoleTests: XCTestCase {
    func testAtMostFourNewLinesASecond() {
        var c = Console()
        let t0 = Date(timeIntervalSince1970: 1000)
        XCTAssertFalse(c.offer("npm run render", command: true, now: t0), "the first line shows at once")
        XCTAssertTrue(c.offer("npm test", command: true, now: t0.addingTimeInterval(0.1)), "sooner than 250 ms: held")
        XCTAssertTrue(c.offer("git status", command: true, now: t0.addingTimeInterval(0.2)), "a newer one replaces the held one")
        XCTAssertEqual(c.lines.map(\.text), ["npm run render"])
        c.flush(now: t0.addingTimeInterval(0.25))
        XCTAssertEqual(c.lines.map(\.text), ["npm run render", "git status"])
        XCTAssertNil(c.held)
        // A burst of 40 lines over one second shows at most 4 of them.
        var d = Console()
        var shown = 0
        for i in 0..<40 {
            let now = t0.addingTimeInterval(Double(i) * 0.025)
            let before = d.lines.count
            d.offer("line \(i)", command: false, now: now)
            d.flush(now: now)
            shown += d.lines.count - before
        }
        XCTAssertLessThanOrEqual(shown, 4)
    }

    func testLinesFromEvents() {
        func ev(_ type: String, _ p: JSON) -> VyreEvent { VyreEvent(id: 1, at: 1, type: type, thread: "t1", payload: p) }
        XCTAssertEqual(Console.line(ev("thread.tool", ["tool": "Bash", "phase": "started", "summary": "npm test"]))?.text, "npm test")
        XCTAssertEqual(Console.line(ev("thread.tool", ["tool": "Bash", "phase": "started", "summary": "npm test"]))?.command, true)
        XCTAssertEqual(Console.line(ev("thread.tool", ["tool": "Edit", "phase": "started", "summary": "Edit /work/q3.tsx"]))?.text, "Edited q3.tsx")
        XCTAssertNil(Console.line(ev("thread.tool", ["tool": "Bash", "phase": "done"])))
        XCTAssertEqual(Console.line(ev("thread.text", ["message": "m", "text": "Rendered.\nAll 42 passed.\n", "done": true]))?.text, "All 42 passed.")
        XCTAssertNil(Console.line(ev("thread.text", ["message": "m", "delta": "Ren"])))
        XCTAssertEqual(Console.line(ev("thread.finished", ["ok": true]))?.text, "Done")
        var c = Console()
        c.append("backlog", command: false)
        XCTAssertEqual(c.lines.count, 1)
    }
}
