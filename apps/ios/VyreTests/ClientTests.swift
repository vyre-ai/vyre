import XCTest
@testable import Vyre

final class ClientTests: XCTestCase {
    var client: VyreClient!

    override func setUp() {
        client = VyreClient(address: BoxAddress("https://alex.vyre.run")!, signer: nil, session: Stub.session())
    }

    func testSuccessReturnsData() async throws {
        Stub.reset([Stub.json(#"{"data":{"projects":[{"slug":"harlow-legal","name":"Harlow Legal"}]}}"#)])
        let out = try await client.call("projects.list")
        XCTAssertEqual(out["projects"][0]["name"].string, "Harlow Legal")
        let req = try XCTUnwrap(Stub.requests.first)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.absoluteString, "https://alex.vyre.run/v1/tools/projects.list")
        XCTAssertEqual(req.value(forHTTPHeaderField: "content-type"), "application/json")
        XCTAssertNil(req.value(forHTTPHeaderField: "origin"))
        XCTAssertNil(req.value(forHTTPHeaderField: "x-vyre-caller"))
        XCTAssertEqual(String(decoding: Stub.bodies[0], as: UTF8.self), "{}")
    }

    func testBodyIsTheCanonicalInput() async throws {
        Stub.reset([Stub.json(#"{"data":{"sent":true}}"#)])
        try await client.call("threads.send", ["thread": "t1", "text": "Run the tests", "surface": "ios"])
        XCTAssertEqual(String(decoding: Stub.bodies[0], as: UTF8.self), #"{"surface":"ios","text":"Run the tests","thread":"t1"}"#)
    }

    func testTypedErrors() async {
        let cases: [(String, Int, VyreError)] = [
            (#"{"error":{"code":"presence_required","message":"Approve needs you","methods":["passkey","device"]}}"#, 403,
             .presenceRequired(message: "Approve needs you", methods: ["passkey", "device"])),
            (#"{"error":{"code":"denied","message":"gate.get is not available"}}"#, 403, .denied("gate.get is not available")),
            (#"{"error":{"code":"not_owner","message":"This Vyre serves only its owner."}}"#, 403, .notOwner("This Vyre serves only its owner.")),
            (#"{"error":{"code":"misdirected","message":"wrong host"}}"#, 421, .misdirected("wrong host")),
            (#"{"error":{"code":"no_such_tool","message":"no push.subscribe"}}"#, 404, .noSuchTool("no push.subscribe")),
            (#"{"error":{"code":"bad_input","message":"transport"}}"#, 400, .badInput("transport")),
            (#"{"error":{"code":"locked","message":"The vault is locked"}}"#, 500, .failed(code: "locked", message: "The vault is locked")),
        ]
        for (body, status, want) in cases {
            Stub.reset([Stub.json(body, status: status)])
            do { try await client.call("gate.approve", ["id": "x"]); XCTFail("no error for \(want)") } catch {
                XCTAssertEqual(error as? VyreError, want)
            }
        }
    }

    func testOfflineWhenUnreachable() async {
        Stub.reset([])
        do { try await client.call("agents.list"); XCTFail() } catch {
            guard case .offline = error as? VyreError else { return XCTFail("\(error)") }
        }
    }

    func testCodeProofHeader() async throws {
        Stub.reset([Stub.json(#"{"data":{"id":"k1"}}"#)])
        try await client.call("presence.enroll", ["kind": "device"], proof: .code("ABCD2345"))
        XCTAssertEqual(Stub.requests[0].value(forHTTPHeaderField: "x-vyre-presence"), "code code=ABCD2345")
    }

    func testDeviceProofWithoutKeyRefuses() async {
        Stub.reset([])
        do { try await client.call("gate.approve", ["id": "x"], proof: .device(reason: "Send")); XCTFail() } catch {
            guard case .presenceRequired = error as? VyreError else { return XCTFail("\(error)") }
        }
        XCTAssertTrue(Stub.requests.isEmpty, "nothing is sent without a proof it needed")
    }

    func testAddresses() {
        XCTAssertEqual(BoxAddress("alex.vyre.run")?.url.absoluteString, "https://alex.vyre.run")
        XCTAssertEqual(BoxAddress(" https://vyre.harlow.ts.net/onboard?x=1 ")?.url.absoluteString, "https://vyre.harlow.ts.net")
        XCTAssertNil(BoxAddress("http://alex.vyre.run"), "plain HTTP only to 127.0.0.1 in debug")
        XCTAssertNil(BoxAddress("ftp://alex.vyre.run"))
        XCTAssertNil(BoxAddress(""))
        #if DEBUG
        XCTAssertEqual(BoxAddress("http://127.0.0.1:4800")?.display, "127.0.0.1:4800")
        #endif
    }
}
