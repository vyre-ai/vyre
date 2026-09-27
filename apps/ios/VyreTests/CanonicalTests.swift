import XCTest
@testable import Vyre

/// The Swift canonical JSON against vectors node wrote with core/presence's own canonical()
/// (scripts/canonical-vectors.mjs). A proof is bound to this hash, so it must match byte for byte.
final class CanonicalTests: XCTestCase {
    func testVectorsFromNode() throws {
        let url = try XCTUnwrap(Bundle(for: CanonicalTests.self).url(forResource: "canonical-vectors", withExtension: "json"))
        let vectors = try JSON.parse(Data(contentsOf: url)).list
        XCTAssertGreaterThanOrEqual(vectors.count, 18)
        for v in vectors {
            let input = v["input"]
            XCTAssertEqual(input.canonical, v["canonical"].string, "canonical of \(input)")
            XCTAssertEqual(Canonical.inputHash(input), v["hash"].string, "hash of \(input)")
        }
    }

    func testNumbersAsJavaScriptWritesThem() {
        let cases: [(Double, String)] = [(1, "1"), (-1, "-1"), (1.5, "1.5"), (0.1, "0.1"), (1e-6, "0.000001"), (1e-7, "1e-7"),
                                         (1e21, "1e+21"), (1e20, "100000000000000000000"), (-2.5e-8, "-2.5e-8"), (123.456, "123.456"),
                                         (.nan, "null"), (.infinity, "null"), (-0.0, "0"), (9007199254740992, "9007199254740992")]
        for (d, s) in cases { XCTAssertEqual(Canonical.number(d), s, "\(d)") }
    }

    func testKeysSortByUTF16AtEveryDepth() {
        let v: JSON = ["b": ["d": 1, "c": 2], "a": [["y": true, "x": nil]]]
        XCTAssertEqual(v.canonical, #"{"a":[{"x":null,"y":true}],"b":{"c":2,"d":1}}"#)
    }

    func testControlCharactersEscapeLikeJSONStringify() {
        XCTAssertEqual(JSON.string("a\u{1}b\n\"/").canonical, #""a\u0001b\n\"/""#)
    }
}
