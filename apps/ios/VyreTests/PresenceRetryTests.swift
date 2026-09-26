import XCTest
@testable import Vyre

/// A signer that counts how often it was asked to sign, and signs with a fixed header.
final class CountingSigner: PresenceSigner, @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return n }
    func deviceHeader(tool: String, input: JSON, reason: String) async throws -> String {
        lock.lock(); n += 1; lock.unlock()
        return "device key=k ts=1 nonce=nnnnnnnn sig=s"
    }
    func sessionHeader() async -> String? { nil }
}

final class PresenceRetryTests: XCTestCase {
    private let required = Stub.json(#"{"error":{"code":"presence_required","message":"agents.create needs you","methods":["device"]}}"#, status: 403)

    func testPresenceRequiredLeadsToExactlyOneSignedRetry() async throws {
        Stub.reset([required, Stub.json(#"{"data":{"name":"juno"}}"#)])
        let signer = CountingSigner()
        let client = VyreClient(address: BoxAddress("https://alex.vyre.run")!, signer: signer, session: Stub.session())
        let input: JSON = ["name": "juno", "kind": "agent", "projects": ["harlow-legal"]]
        let out = try await client.callProvingIfAsked("agents.create", input, reason: "Create agent juno")
        XCTAssertEqual(out["name"].string, "juno")
        XCTAssertEqual(signer.count, 1)
        XCTAssertEqual(Stub.requests.count, 2)
        XCTAssertNil(Stub.requests[0].value(forHTTPHeaderField: "x-vyre-presence"))
        XCTAssertEqual(Stub.requests[1].value(forHTTPHeaderField: "x-vyre-presence"), "device key=k ts=1 nonce=nnnnnnnn sig=s")
        XCTAssertEqual(Stub.bodies[0], Stub.bodies[1], "the retry sends the byte-identical input the proof was bound to")
    }

    func testASecondRefusalIsThrownNotRetriedAgain() async {
        Stub.reset([required, required, Stub.json(#"{"data":{}}"#)])
        let signer = CountingSigner()
        let client = VyreClient(address: BoxAddress("https://alex.vyre.run")!, signer: signer, session: Stub.session())
        do {
            _ = try await client.callProvingIfAsked("agents.create", ["name": "juno"], reason: "Create agent juno")
            XCTFail("a second presence_required must be thrown")
        } catch {
            XCTAssertEqual((error as? VyreError)?.code, "presence_required")
        }
        XCTAssertEqual(signer.count, 1)
        XCTAssertEqual(Stub.requests.count, 2)
    }

    func testNoRetryWhenNoProofIsAsked() async throws {
        Stub.reset([Stub.json(#"{"data":{"name":"kit"}}"#)])
        let signer = CountingSigner()
        let client = VyreClient(address: BoxAddress("https://alex.vyre.run")!, signer: signer, session: Stub.session())
        _ = try await client.callProvingIfAsked("agents.create", ["name": "kit"], reason: "Create agent kit")
        XCTAssertEqual(signer.count, 0)
        XCTAssertEqual(Stub.requests.count, 1)
    }
}

final class NewAgentInputTests: XCTestCase {
    func testTheDecksInputAndChecks() throws {
        let ok = NewAgentSheet.input(name: " juno ", projects: ["northwind", "harlow-legal"], job: "Answers the Northwind orders.\n",
                                     runsOn: .subscription, subItem: "claude-setup-token", keyItem: "anthropic-api-key",
                                     fallback: true, budget: "10", computer: false, haveProjects: true)
        let input = try ok.get()
        XCTAssertEqual(input.canonical, #"{"auth":{"budget_usd":10,"fallback":"anthropic-api-key","vault":"claude-setup-token"},"computer":false,"instructions":"Answers the Northwind orders.","kind":"agent","name":"juno","projects":["harlow-legal","northwind"]}"#)
        let key = try NewAgentSheet.input(name: "kit", projects: [], job: "", runsOn: .apiKey, subItem: "x", keyItem: "anthropic-api-key",
                                          fallback: true, budget: "25", computer: true, haveProjects: false).get()
        XCTAssertEqual(key["auth"].canonical, #"{"budget_usd":25,"vault":"anthropic-api-key"}"#)
        XCTAssertEqual(NewAgentSheet.input(name: "Rex", projects: ["a"], job: "", runsOn: .subscription, subItem: "s", keyItem: "k",
                                           fallback: false, budget: "", computer: false, haveProjects: true), .failure(.name))
        XCTAssertEqual(NewAgentSheet.input(name: "rex", projects: [], job: "", runsOn: .subscription, subItem: "s", keyItem: "k",
                                           fallback: false, budget: "", computer: false, haveProjects: true), .failure(.projects))
        XCTAssertEqual(NewAgentSheet.input(name: "rex", projects: ["a"], job: "", runsOn: .apiKey, subItem: "s", keyItem: "k",
                                           fallback: false, budget: "0", computer: false, haveProjects: true), .failure(.budget))
    }
}
