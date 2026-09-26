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

    func testTabsAreThePWAsOrder() {
        XCTAssertEqual(Tab.allCases, [.now, .projects, .chat, .find, .agents])
        XCTAssertEqual(Theme.allCases.first, .dark)
    }
}
