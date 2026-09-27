import XCTest
@testable import Vyre

@MainActor
final class RouteTests: XCTestCase {
    func testPushPathsAndAppLinks() {
        XCTAssertEqual(Route(path: "/needs/abc123"), .needs("abc123"))
        XCTAssertEqual(Route(path: "/threads/t-1"), .thread("t-1"))
        XCTAssertEqual(Route(path: "/settings?section=lessons"), .settings)
        XCTAssertEqual(Route(path: "/vault"), .vault)
        XCTAssertEqual(Route(path: "/memory"), .memory)
        XCTAssertNil(Route(path: "/needs"))
        XCTAssertNil(Route(path: "/elsewhere"))
    }

    func testPagesAreThePhoneSpecsOrder() {
        XCTAssertEqual(Page.allCases, [.now, .chats, .agents])
        XCTAssertEqual(Page.allCases.map(\.label), ["Now", "Chats", "Agents"])
        XCTAssertEqual(Theme.allCases, [.dark, .paper, .system])
    }

    func testInitialsAndModelLabels() {
        XCTAssertEqual(initials(name: "alex", host: "vyre.example.ts.net"), "A")
        XCTAssertEqual(initials(name: "Alex Brandt", host: "x"), "AB")
        XCTAssertEqual(initials(name: nil, host: "northwind.ts.net"), "N")
        XCTAssertEqual(initials(name: "  ", host: "kit"), "K")
        XCTAssertEqual(modelLabel("claude-sonnet-4-5"), "sonnet-4-5")
        XCTAssertEqual(modelLabel("haiku"), "haiku")
        XCTAssertNil(modelLabel(nil))
    }
}
