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

final class ChatTranscriptTests: XCTestCase {
    private func ev(_ id: Int, _ at: Double, _ type: String, _ payload: JSON) -> VyreEvent {
        VyreEvent(id: id, at: at, type: type, thread: "t1", payload: payload)
    }

    func testToolRowsReadAsActions() {
        func line(_ tool: String, _ summary: String) -> String {
            Transcript.ToolLine(id: "x", tool: tool, summary: summary, phase: "done", error: false).action
        }
        XCTAssertEqual(line("Bash", "npm test"), "Ran npm test")
        XCTAssertEqual(line("Edit", "Edit /work/harlow/reports/q3.tsx"), "Edited q3.tsx")
        XCTAssertEqual(line("Write", "Write /work/northwind/menu.md"), "Wrote menu.md")
        XCTAssertEqual(line("Read", "Read notes.md"), "Read notes.md")
        XCTAssertEqual(line("WebFetch", "fetch https://northwind.example/menu"), "Fetched northwind.example")
        XCTAssertEqual(line("Glob", "Glob *.md"), "Glob *.md")
    }

    func testAnsweredAsksShrinkToOneLine() {
        var t = Transcript()
        t.apply(ev(1, 1000, "ask.raised", ["ask": "k1", "tool": "Bash"]))
        t.apply(ev(2, 2000, "ask.answered", ["ask": "k1", "decision": "allow", "by": "ios"]))
        t.apply(ev(3, 3000, "ask.raised", ["ask": "k2", "tool": "Bash"]))
        t.apply(ev(4, 4000, "ask.answered", ["ask": "k2", "decision": "always", "by": "deck", "scope": "project"]))
        t.apply(ev(5, 5000, "ask.raised", ["ask": "q1", "kind": "question"]))
        t.apply(ev(6, 6000, "ask.answered", ["ask": "q1", "decision": "allow", "by": "ios"]))
        XCTAssertEqual(t.answers["k1"]?.line(project: "Harlow Legal", question: false, time: "12:07"), "Approved by you, 12:07")
        XCTAssertEqual(t.answers["k2"]?.line(project: "Harlow Legal", question: false, time: "12:07"), "Always allowed in Harlow Legal, 12:07")
        XCTAssertTrue(t.questions.contains("q1"))
        XCTAssertEqual(t.answers["q1"]?.line(project: nil, question: true, time: ""), "Answered by you")
        XCTAssertEqual(Transcript.Answer(decision: "deny", by: "agent:kit", scope: nil, at: 0).line(project: nil, question: false, time: "9:00"), "Denied by kit, 9:00")
        XCTAssertEqual(t.entries.count, 3, "an answer changes a card, not the list")
    }

    func testTimeStampsAtGapsOfMoreThanAnHour() {
        var t = Transcript()
        t.apply(ev(1, 0 + 1, "thread.sent", ["text": "Morning", "surface": "deck"]))
        t.apply(ev(2, 60_000, "thread.text", ["message": "m1", "text": "Morning, alex.", "done": true]))
        t.apply(ev(3, 60_000 + 3_700_000, "thread.sent", ["text": "Later on", "surface": "deck"]))
        t.apply(ev(4, 60_000 + 3_760_000, "thread.text", ["message": "m2", "text": "Here.", "done": true]))
        XCTAssertEqual(t.stamped(), [t.entries[0].id, t.entries[2].id])
        t.echo("One more", now: Date(timeIntervalSince1970: 10))
        XCTAssertNotNil(t.times[t.entries.last!.id])
    }
}
