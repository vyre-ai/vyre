import XCTest
@testable import Vyre

final class TranscriptTests: XCTestCase {
    private func ev(_ id: Int, _ type: String, _ payload: JSON) -> VyreEvent {
        VyreEvent(id: id, at: 0, type: type, thread: "t1", payload: payload)
    }

    func testDeltasThenDoneReplaceOneReply() {
        var t = Transcript()
        t.apply(ev(1, "thread.sent", ["text": "Draft the Northwind Bakery reminder", "surface": "deck"]))
        t.apply(ev(2, "thread.text", ["message": "m1", "delta": "Here "]))
        t.apply(ev(3, "thread.text", ["message": "m1", "delta": "it is"]))
        XCTAssertEqual(t.entries.last, .reply(message: "m1", text: "Here it is", done: false))
        t.apply(ev(4, "thread.text", ["message": "m1", "text": "Here it is.", "done": true]))
        XCTAssertEqual(t.entries.count, 2)
        XCTAssertEqual(t.entries.last, .reply(message: "m1", text: "Here it is.", done: true))
        // A replayed event (same id) changes nothing.
        t.apply(ev(3, "thread.text", ["message": "m1", "delta": "it is"]))
        XCTAssertEqual(t.entries.last, .reply(message: "m1", text: "Here it is.", done: true))
    }

    func testToolsGroupAndFinish() {
        var t = Transcript()
        t.apply(ev(1, "thread.tool", ["id": "a", "tool": "Read", "phase": "started", "summary": "Read notes.md"]))
        t.apply(ev(2, "thread.tool", ["id": "b", "tool": "Bash", "phase": "started", "summary": "ls"]))
        t.apply(ev(3, "thread.tool", ["id": "b", "phase": "done", "error": true]))
        guard case .tools(_, let lines) = t.entries.first else { return XCTFail("no tool block") }
        XCTAssertEqual(t.entries.count, 1)
        XCTAssertEqual(lines.map(\.phase), ["started", "done"])
        XCTAssertEqual(lines[1].error, true)
    }

    func testOwnEchoIsNotDrawnTwice() {
        var t = Transcript()
        t.echo("hello from alex")
        XCTAssertTrue(t.working)
        t.apply(ev(5, "thread.sent", ["text": "hello from alex", "surface": "ios"]))
        XCTAssertEqual(t.entries.count, 1)
        t.apply(ev(6, "thread.finished", ["ok": true, "duration_ms": 2000]))
        XCTAssertFalse(t.working)
    }

    func testAsksAndHeldItemsAppearOnce() {
        var t = Transcript()
        t.apply(ev(1, "ask.raised", ["ask": "k1", "tool": "Write"]))
        t.apply(ev(2, "gate.held", ["id": "g1"]))
        t.apply(ev(3, "gate.revised", ["id": "g1"]))
        XCTAssertEqual(t.entries, [.ask(id: "k1"), .gate(id: "g1")])
    }
}
