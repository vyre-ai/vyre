// capsule-suite: boxSocketSuite
// The Mac app window's WebSockets (Host/BoxSocket.swift): the frame codec against RFC 6455's own examples, and the page-facing side (which paths the app opens,
// what the page's replacement WebSocket says). The unix socket itself is not opened here.

import Foundation

private func bytes(_ a: [UInt8]) -> Data { Data(a) }

let boxSocketSuite = Suite("box socket") { t in
    t.test("the accept key is the RFC's example") {
        t.eq(WS.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    }

    t.test("a masked client text frame is the RFC's bytes") {
        t.eq(WS.frame(opcode: 0x1, payload: Data("Hello".utf8), mask: [0x37, 0xfa, 0x21, 0x3d]), bytes([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]))
    }

    t.test("lengths of 126 and 65536 bytes use the long forms") {
        let mid = WS.frame(opcode: 0x2, payload: Data(count: 200), mask: [0, 0, 0, 0])
        t.eq(Array(mid.prefix(4)), [0x82, 0xFE, 0x00, 0xC8])
        let big = WS.frame(opcode: 0x2, payload: Data(count: 70_000), mask: [0, 0, 0, 0])
        t.eq(Array(big.prefix(10)), [0x82, 0xFF, 0, 0, 0, 0, 0, 0x01, 0x11, 0x70])
    }

    t.test("the decoder reads the RFC's unmasked text frame, a masked one, and a frame split across reads") {
        var d = WSDecoder()
        t.eq(d.feed(bytes([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f])), [.text("Hello")])
        t.eq(d.feed(bytes([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])), [.text("Hello")])
        t.eq(d.feed(bytes([0x81, 0x05, 0x48])), [])
        t.eq(d.feed(bytes([0x65, 0x6c, 0x6c, 0x6f])), [.text("Hello")])
        t.ok(!d.failed)
    }

    t.test("a message in fragments is one message, with a ping allowed between the pieces") {
        var d = WSDecoder()
        t.eq(d.feed(bytes([0x01, 0x03, 0x48, 0x65, 0x6c])), [])
        t.eq(d.feed(bytes([0x89, 0x00])), [.ping(Data())])
        t.eq(d.feed(bytes([0x80, 0x02, 0x6c, 0x6f])), [.text("Hello")])
    }

    t.test("binary, ping, pong and close frames, and the long length forms") {
        var d = WSDecoder()
        t.eq(d.feed(bytes([0x82, 0x03, 1, 2, 3])), [.binary(Data([1, 2, 3]))])
        t.eq(d.feed(bytes([0x8A, 0x01, 9])), [.pong(Data([9]))])
        t.eq(d.feed(bytes([0x88, 0x05, 0x03, 0xE8, 0x62, 0x79, 0x65])), [.close(code: 1000, reason: "bye")])
        var e = WSDecoder()
        var long: [UInt8] = [0x82, 0x7E, 0x00, 0xC8]; long.append(contentsOf: [UInt8](repeating: 7, count: 200))
        t.eq(e.feed(Data(long)), [.binary(Data([UInt8](repeating: 7, count: 200)))])
    }

    t.test("a broken stream fails and says nothing more: reserved bits, a fragmented control frame, a continuation with nothing before it") {
        var a = WSDecoder(); t.eq(a.feed(bytes([0xC1, 0x00])), []); t.ok(a.failed)
        var b = WSDecoder(); t.eq(b.feed(bytes([0x09, 0x00])), []); t.ok(b.failed)
        var c = WSDecoder(); t.eq(c.feed(bytes([0x80, 0x01, 0x41])), []); t.ok(c.failed)
        var d = WSDecoder(); _ = d.feed(bytes([0x03, 0x00])); t.eq(d.feed(bytes([0x81, 0x00])), []); t.ok(d.failed)
    }

    t.test("the app opens only vyred's stream routes for the page") {
        MainActor.assumeIsolated {
            t.ok(VyreAppWindow.isStreamPath("/v1/streams/terminal/pty"))
            t.ok(VyreAppWindow.isStreamPath("/v1/streams/glass/view?ticket=abc123-_.~"))
            t.ok(!VyreAppWindow.isStreamPath("/v1/tools/files.read"))
            t.ok(!VyreAppWindow.isStreamPath("/v1/streams/../tools/x"))
            t.ok(!VyreAppWindow.isStreamPath("/v1/streams/terminal/pty/extra"))
            t.ok(!VyreAppWindow.isStreamPath("/v1/streams/terminal/pty?x=\r\nHost: y"))
        }
    }

    t.test("the page's replacement WebSocket takes the app's own address and leaves every other one to the real WebSocket") {
        MainActor.assumeIsolated {
            let js = VyreAppWindow.wsShimSource
            for piece in ["vyreapp|ws", "ws.open", "ws.send", "ws.close", "new Native(url, protocols)", "window.WebSocket = VyreWS", "window.__vyreWS", "readyState"] { t.ok(js.contains(piece), piece) }
        }
    }
}
