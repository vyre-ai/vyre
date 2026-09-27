import XCTest
@testable import Vyre

final class NeedItemTests: XCTestCase {
    func testAskTitlesAreTheAction() {
        XCTAssertEqual(NeedItem.askTitle(tool: "Bash", summary: "git push origin q3-report", destination: nil), "Push q3-report")
        XCTAssertEqual(NeedItem.askTitle(tool: "Bash", summary: "npm test", destination: nil), "Test")
        XCTAssertEqual(NeedItem.askTitle(tool: "Bash", summary: "rm -rf build", destination: nil), "Run rm")
        XCTAssertEqual(NeedItem.askTitle(tool: "Write", summary: "Write /work/harlow/notes.txt", destination: "/work/harlow/notes.txt"), "Write notes.txt")
        XCTAssertEqual(NeedItem.askTitle(tool: "WebFetch", summary: "fetch https://northwind.example/menu", destination: nil), "Fetch northwind.example")
        XCTAssertEqual(NeedItem.askTitle(tool: "Glob", summary: "Glob pattern: *.md", destination: nil), "Use Glob")
    }

    func testDraftTitleNamesThePerson() {
        XCTAssertEqual(NeedItem.person("dana@harlowlegal.com"), "Dana")
        XCTAssertEqual(NeedItem.person("Dana <dana@harlowlegal.com>, alex@example.com"), "Dana")
        XCTAssertEqual(NeedItem.person("juno.kit@northwind.example"), "Juno")
        let g: JSON = ["id": "h1", "kind": "send", "via": "mail", "to": ["dana@harlowlegal.com"], "summary": "Intake form",
                       "agent": "kit", "project": "harlow-legal", "at": 1, "draft": ["subject": "Intake form, next steps", "body": "Hi Dana"]]
        let item = NeedItem.held(HeldDraft(get: g))
        XCTAssertEqual(item.title, "Send email to Dana")
        XCTAssertEqual(item.line2, "Intake form, next steps")
        XCTAssertEqual(item.line3, "kit · harlow-legal")
        XCTAssertEqual(item.approveVerb, "Send")
        XCTAssertEqual(item.denyVerb, "Discard")
    }

    func testSpokenLabel() {
        var a = AskItem(["id": "k1", "thread": "t1", "tool": "Bash", "summary": "git push origin q3-report", "at": 1])
        a.agent = "kit"
        a.project = "Harlow Legal"
        let s = NeedItem.ask(a).spoken(now: Date(timeIntervalSince1970: 240))
        XCTAssertEqual(s, "kit, Harlow Legal, wants to push q3-report, git push origin q3-report, 4 min ago.")
    }
}
