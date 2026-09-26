import Network
import XCTest
@testable import Vyre

/// A real HTTP server on 127.0.0.1 that answers every request with SSE headers and one short
/// comment, then holds the connection open, as vyred does while a stream is quiet. URLProtocol
/// stubs cannot show how URLSession delivers a slow stream; this can.
final class TinySSEServer: @unchecked Sendable {
    private let listener: NWListener
    private let lock = NSLock()
    private var conns: [NWConnection] = []

    init(headers: [String], body: String = ": open\n\n") throws {
        listener = try NWListener(using: .tcp, on: .any)
        let head = (["HTTP/1.1 200 OK", "content-type: text/event-stream", "cache-control: no-store", "connection: keep-alive"] + headers)
            .joined(separator: "\r\n") + "\r\n\r\n" + body
        listener.newConnectionHandler = { [weak self] c in
            self?.keep(c)
            c.start(queue: .global())
            c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in
                c.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
            }
        }
    }

    private func keep(_ c: NWConnection) { lock.lock(); conns.append(c); lock.unlock() }

    func start() async throws -> UInt16 {
        listener.start(queue: .global())
        for _ in 0..<100 {
            if let p = listener.port?.rawValue, p != 0 { return p }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw URLError(.cannotConnectToHost)
    }

    func stop() {
        listener.cancel()
        lock.lock(); conns.forEach { $0.cancel() }; conns = []; lock.unlock()
    }
}

@MainActor
final class StreamLiveTests: XCTestCase {
    /// How long until the hub says live, against a server that sent headers and a few bytes.
    private func timeToLive(headers: [String], body: String = ": open\n\n") async throws -> Bool {
        let server = try TinySSEServer(headers: headers, body: body)
        let port = try await server.start()
        defer { server.stop() }
        let client = VyreClient(address: BoxAddress("http://127.0.0.1:\(port)")!, signer: nil)
        let hub = EventHub()
        hub.delay = { _ in try await Task.sleep(for: .seconds(60)) }
        hub.start(client: client, since: nil)
        defer { hub.stop() }
        for _ in 0..<40 {
            if hub.state == .live { return true }
            try await Task.sleep(for: .milliseconds(100))
        }
        return hub.state == .live
    }

    func testLiveOnceHeadersArriveWithNosniff() async throws {
        let live = try await timeToLive(headers: ["x-content-type-options: nosniff"])
        XCTAssertTrue(live, "with nosniff the hub is live within 4 s of the headers")
    }

    func testLiveOnceHeadersArriveWithoutNosniff() async throws {
        let live = try await timeToLive(headers: [])
        XCTAssertTrue(live, "without nosniff the hub is live within 4 s of the headers")
    }

    /// vyred flushes its headers and then writes nothing until an event or the 15 s heartbeat.
    /// This records whether URLSession hands the response over before the first body byte.
    func testHeadersOnlyThenQuiet() async throws {
        let live = try await timeToLive(headers: ["transfer-encoding: chunked"], body: "")
        print("STREAMPROBE headers-only live=\(live)")
        XCTExpectFailure("URLSession may hold a response with no body byte yet", strict: false)
        XCTAssertTrue(live)
    }
}
