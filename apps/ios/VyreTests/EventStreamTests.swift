import XCTest
@testable import Vyre

final class SSEParserTests: XCTestCase {
    func testFramesCommentsAndMultilineData() {
        var p = SSEParser()
        let raw = ": beat\n\nid: 7\nevent: thread.text\ndata: {\"a\":1,\ndata: \"b\":2}\n\nid: 8\ndata:plain\n\n"
        let frames = p.feed(Array(raw.utf8))
        XCTAssertEqual(frames, [
            .init(id: "7", event: "thread.text", data: "{\"a\":1,\n\"b\":2}"),
            .init(id: "8", event: "message", data: "plain"),
        ])
        XCTAssertEqual(p.lastEventId, "8")
    }

    func testCRLFAndSplitChunks() {
        var p = SSEParser()
        var got: [SSEParser.Frame] = []
        for piece in ["id: 1\r", "\nevent: x\r\nda", "ta: hello\r\n", "\r\n"] { got += p.feed(Array(piece.utf8)) }
        XCTAssertEqual(got, [.init(id: "1", event: "x", data: "hello")])
    }

    func testIdWithoutDataDispatchesNothingButIsKept() {
        var p = SSEParser()
        XCTAssertTrue(p.feed(Array("id: 42\n\n".utf8)).isEmpty)
        XCTAssertEqual(p.lastEventId, "42")
    }

    func testEventFlattening() throws {
        let j = try JSON.parse(Data(#"{"id":3,"at":1,"type":"thread.text","payload":{"message":"m1","delta":"Hi"},"thread":"t9"}"#.utf8))
        let e = try XCTUnwrap(VyreEvent(j))
        XCTAssertEqual(e["delta"].string, "Hi")
        XCTAssertEqual(e["thread"].string, "t9")
        XCTAssertEqual(e.id, 3)
    }
}

@MainActor
final class EventHubTests: XCTestCase {
    func testReconnectsWithLastEventID() async throws {
        let sse = { (s: String) in Stub.Reply(status: 200, body: Data(s.utf8), headers: ["content-type": "text/event-stream"]) }
        Stub.reset([
            sse("id: 5\nevent: gate.held\ndata: {\"id\":5,\"at\":1,\"type\":\"gate.held\",\"payload\":{\"id\":\"g1\"}}\n\n: beat\n\nid: 6\nevent: ask.raised\ndata: {\"id\":6,\"at\":2,\"type\":\"ask.raised\",\"payload\":{\"ask\":\"a1\"}}\n\n"),
            .init(status: 599, body: Data()),
            sse("id: 7\nevent: thread.text\ndata: {\"id\":7,\"at\":3,\"type\":\"thread.text\",\"payload\":{\"delta\":\"x\"}}\n\n"),
        ])
        let client = VyreClient(address: BoxAddress("https://alex.vyre.run")!, signer: nil, session: Stub.session())
        let hub = EventHub()
        var waits: [Int] = []
        let delays = Box<[Int]>([])
        hub.delay = { s in delays.value.append(s) }
        var seen: [Int] = []
        let done = expectation(description: "three events")
        hub.on { e in seen.append(e.id); if seen.count == 3 { done.fulfill() } }
        hub.start(client: client, since: nil)
        await fulfillment(of: [done], timeout: 5)
        hub.stop()
        waits = delays.value
        XCTAssertEqual(seen, [5, 6, 7])
        XCTAssertEqual(hub.lastEventId, 7)
        let reqs = Stub.requests
        XCTAssertGreaterThanOrEqual(reqs.count, 3)
        XCTAssertEqual(reqs[0].url?.query, "since=latest", "a fresh hub skips the backlog")
        XCTAssertNil(reqs[0].value(forHTTPHeaderField: "Last-Event-ID"))
        XCTAssertEqual(reqs[1].value(forHTTPHeaderField: "Last-Event-ID"), "6")
        XCTAssertEqual(reqs[2].value(forHTTPHeaderField: "Last-Event-ID"), "6")
        XCTAssertEqual(Array(waits.prefix(2)), [1, 1], "a stream that delivered resets the backoff; a failure doubles it next")
        XCTAssertEqual(hub.state, .stopped)
    }

    func testStartsFromHealthLastEvent() async throws {
        Stub.reset([])
        let client = VyreClient(address: BoxAddress("https://alex.vyre.run")!, signer: nil, session: Stub.session())
        let hub = EventHub()
        let tried = expectation(description: "tried")
        hub.delay = { _ in tried.fulfill(); try await Task.sleep(for: .seconds(60)) }
        hub.start(client: client, since: 41)
        await fulfillment(of: [tried], timeout: 5)
        hub.stop()
        XCTAssertEqual(Stub.requests.first?.value(forHTTPHeaderField: "Last-Event-ID"), "41")
    }
}

final class Box<T>: @unchecked Sendable { var value: T; init(_ v: T) { value = v } }
