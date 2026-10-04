// capsule-suite: vyreAppSuite
// The Vyre app window's pure parts: the menu's shortcuts are unique and name real places, and the strings sent to the page are valid JSON.

import AppKit
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

    t.test("the page's bridge names every call the window answers") {
        for op in ["presence", "notify", "_reply", "_command", "onCommand", "socket", "_ws", "ws.open", "ws.send", "ws.close"] { t.ok(VyreAppWindow.bridgeSource.contains(op), op) }
    }
}
