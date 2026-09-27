import XCTest
@testable import Vyre

final class FindTests: XCTestCase {
    private let g = FindGrammar(agents: ["juno", "kit"], assistant: "juno",
                                projects: [(slug: "harlow-legal", name: "Harlow Legal"), (slug: "northwind", name: "Northwind Bakery")],
                                sessions: [(id: "t1", name: "q3-report"), (id: "t2", name: "northwind-orders")])

    func testPlainWordsAskTheAssistant() {
        XCTAssertEqual(g.actions("what came in overnight?"), [.ask(agent: "juno", text: "what came in overnight?", assistant: true)])
        XCTAssertTrue(g.actions("what came in overnight?")[0].isAssistantAsk)
        XCTAssertEqual(FindGrammar(agents: [], assistant: nil, projects: [], sessions: []).actions("hello"), [])
    }

    func testTheDecksGrammar() {
        XCTAssertEqual(g.actions("@kit draft the intake reply"), [.ask(agent: "kit", text: "draft the intake reply", assistant: false)])
        XCTAssertEqual(g.actions("@kit"), [.openAgent("kit")])
        XCTAssertEqual(g.actions("@k"), [.fill("@kit ")])
        XCTAssertEqual(g.actions("@harlow-legal render the Q3 report"), [.start(project: "harlow-legal", name: "Harlow Legal", text: "render the Q3 report")])
        XCTAssertEqual(g.actions("tell q3-report to push it"), [.drive(thread: "t1", name: "q3-report", text: "push it")])
        XCTAssertEqual(g.actions("watch northwind"), [.watch(thread: "t2", name: "northwind-orders")])
        XCTAssertEqual(g.actions("@harlow-legal x").first?.label, "New session on Harlow Legal")
        XCTAssertEqual(g.actions("@harlow-legal x").first?.command, "@harlow-legal x")
        XCTAssertEqual(g.actions("tell q3-report to push it").first?.command, "tell q3-report to push it")
    }

    func testMatchSpans() {
        let text = "Northwind Bakery orders, the Friday order"
        let spans = matchSpans(text, "order north")
        XCTAssertEqual(spans.map { String(text[$0]) }, ["North", "order", "order"])
        XCTAssertTrue(matchSpans(text, "a").isEmpty, "one letter never highlights")
        XCTAssertTrue(matchSpans(text, "").isEmpty)
    }
}
