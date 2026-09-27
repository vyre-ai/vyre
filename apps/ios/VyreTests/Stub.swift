import Foundation
@testable import Vyre

/// A URLProtocol that answers from a queue of canned responses and records every request, so the
/// client is tested without a network.
final class Stub: URLProtocol, @unchecked Sendable {
    struct Reply: Sendable { var status: Int; var body: Data; var headers: [String: String] = [:] }
    nonisolated(unsafe) static var replies: [Reply] = []
    nonisolated(unsafe) static var requests: [URLRequest] = []
    nonisolated(unsafe) static var bodies: [Data] = []
    static let lock = NSLock()

    static func reset(_ r: [Reply]) { lock.lock(); replies = r; requests = []; bodies = []; lock.unlock() }
    static func json(_ s: String, status: Int = 200) -> Reply { Reply(status: status, body: Data(s.utf8), headers: ["content-type": "application/json"]) }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Stub.lock.lock()
        Stub.requests.append(request)
        Stub.bodies.append(request.httpBody ?? request.httpBodyStream.map(Stub.read) ?? Data())
        let reply = Stub.replies.isEmpty ? Reply(status: 599, body: Data()) : Stub.replies.removeFirst()
        Stub.lock.unlock()
        if reply.status == 599 {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let resp = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func read(_ s: InputStream) -> Data {
        s.open(); defer { s.close() }
        var d = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
        return d
    }

    static func session() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [Stub.self]
        return URLSession(configuration: c)
    }
}
