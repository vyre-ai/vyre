// capsule-suite: vyreAppSuite
// The Vyre app window's pure parts: the menu's shortcuts are unique and name real places, and the strings sent to the page are valid JSON.

import AppKit
import CryptoKit
import Foundation

let vyreAppSuite = Suite("vyre app window") { t in
    t.test("the menu bar has every place with its own shortcut, and no key is used twice") {
        MainActor.assumeIsolated {
            let menu = VyreMenu.make(VyreAppWindow.shared)
            var seen = Set<String>(), clash = [String]()
            func walk(_ m: NSMenu) {
                for i in m.items {
                    if let s = i.submenu { walk(s) }
                    guard !i.keyEquivalent.isEmpty else { continue }
                    let key = "\(i.keyEquivalentModifierMask.rawValue)-\(i.keyEquivalent.lowercased())"
                    if !seen.insert(key).inserted { clash.append(i.title) }
                }
            }
            walk(menu)
            t.eq(clash, [], "no shortcut is used twice")
            t.eq(menu.items.map { $0.title }, ["Vyre", "File", "Edit", "View", "Go", "Window", "Help"])
            t.eq(VyreMenu.places.map { $0.route }.filter { !$0.hasPrefix("/u/") }, [], "every place is a route of the app")
        }
    }

    t.test("a command and a reply are sent to the page as valid JSON") {
        t.eq(VyreAppWindow.js("/u/now"), "\"\\/u\\/now\"")
        t.eq(VyreAppWindow.js("a\"b"), "\"a\\\"b\"")
        t.eq(VyreAppWindow.json(["error": "No."]), "{\"error\":\"No.\"}")
        t.eq(VyreAppWindow.json(NSObject()), "null")
    }

    t.test("a request path is cleaned once: traversal, encoded dots and slashes, and empty segments are refused") {
        for bad in ["/app/../x", "/app/./x", "/v1/%2e%2e/x", "/v1/%2E%2e/x", "/app/a%2fb", "/app/a%5Cb", "/app//x", "/app/a\\b", "/v1/tools/x%00"] {
            t.eq(BoxSchemeHandler.cleanPath(bad), nil, bad)
        }
        t.eq(BoxSchemeHandler.cleanPath("/app/"), "/app/")
        t.eq(BoxSchemeHandler.cleanPath("/v1/tools/chats.list"), "/v1/tools/chats.list")
        t.ok(BoxSchemeHandler.allowed("/app/index.html") && BoxSchemeHandler.allowed("/v1/events/stream"))
        t.ok(!BoxSchemeHandler.allowed("/") && !BoxSchemeHandler.allowed("/theme.css") && !BoxSchemeHandler.allowed("/application"))
    }

    t.test("the handler forwards exactly the checked path, and a traversal never reaches the socket") {
        func f(_ s: String) -> String? { URL(string: s).flatMap { BoxSchemeHandler.forwardPath($0) } }
        t.eq(f("vyreapp://box/v1/tools/chats.list?x=1&y=2"), "/v1/tools/chats.list?x=1&y=2")
        t.eq(f("vyreapp://box/app/index.html"), "/app/index.html")
        for bad in ["vyreapp://box/app/../v1/x", "vyreapp://box/app/%2e%2e/v1/x", "vyreapp://box/v1/%2E%2E/v1/x", "vyreapp://box/v1/streams/%2e%2e/tools/x", "vyreapp://box/app/a%2Fb",
                    "vyreapp://box//v1/x", "vyreapp://box/", "vyreapp://box/theme.css", "vyreapp://other/app/x"] {
            t.eq(f(bad), nil, bad)
        }
    }

    t.test("the signed app list: a good one verifies, and a wrong key, a changed list, a changed file and an unlisted file are refused") {
        let priv = Curve25519.Signing.PrivateKey()
        let der = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]) + priv.publicKey.rawRepresentation
        let spki = der.base64EncodedString()
        let index = Data("<html>app</html>".utf8), js = Data("console.log(1)".utf8)
        let list = ["files": ["index.html": AppBuildGate.sha256Hex(index), "_expo/a.js": AppBuildGate.sha256Hex(js)], "tree": "t1"] as [String: Any]
        let ab = (try? JSONSerialization.data(withJSONObject: list)) ?? Data()
        let sums = "\(AppBuildGate.sha256Hex(ab))  appbuild.json\n0000  other\n"
        let sig = (try? priv.signature(for: Data(("vyre-release-sums\n" + sums).utf8))) ?? Data()
        guard case .verified(let build) = AppBuildGate.verify(appbuild: ab, sums: sums, sig: sig, key: spki) else { return t.ok(false, "a good list verifies") }
        t.ok(AppBuildGate.allows(build, path: "/app/", body: index) && AppBuildGate.allows(build, path: "/app/_expo/a.js", body: js))
        t.ok(AppBuildGate.allows(build, path: "/app/u/now", body: index), "a route of the app is the listed index.html")
        t.ok(!AppBuildGate.allows(build, path: "/app/_expo/a.js", body: Data("console.log(2)".utf8)), "a changed file is refused")
        t.ok(!AppBuildGate.allows(build, path: "/app/u/now", body: Data("<html>x</html>".utf8)), "an unlisted path that is not index.html is refused")
        t.ok(!AppBuildGate.allows(build, path: "/v1/tools/x", body: index), "nothing outside /app/")
        let other = Curve25519.Signing.PrivateKey()
        let otherDer = (Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]) + other.publicKey.rawRepresentation).base64EncodedString()
        t.ok(AppBuildGate.verify(appbuild: ab, sums: sums, sig: sig, key: otherDer) != .unchecked && !isVerified(AppBuildGate.verify(appbuild: ab, sums: sums, sig: sig, key: otherDer)), "another key refuses")
        t.ok(!isVerified(AppBuildGate.verify(appbuild: Data("{}".utf8), sums: sums, sig: sig, key: spki)), "a list that is not in the signed sums is refused")
        t.ok(!isVerified(AppBuildGate.verify(appbuild: ab, sums: sums + "x", sig: sig, key: spki)), "changed sums are refused")
        t.eq(AppBuildGate.verify(appbuild: ab, sums: sums, sig: sig, key: AppBuildGate.placeholderKey), .unchecked, "the placeholder key is a development build")
        t.eq(AppBuildGate.listedName("/app/"), "index.html")
        t.eq(AppBuildGate.listedName("/app/_expo/a.js"), "_expo/a.js")
        t.eq(AppBuildGate.listedName("/v1/x"), nil)
    }

    t.test("the page's bridge names every call the window answers") {
        for op in ["presence", "notify", "_reply", "_command", "onCommand", "socket", "_ws", "ws.open", "ws.send", "ws.close"] { t.ok(VyreAppWindow.bridgeSource.contains(op), op) }
    }
}

private func isVerified(_ o: AppBuildGate.Outcome) -> Bool { if case .verified = o { return true }; return false }
