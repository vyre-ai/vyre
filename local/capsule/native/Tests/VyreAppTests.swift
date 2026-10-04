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

    t.test("the page's bridge names every call the window answers") {
        for op in ["presence", "notify", "open", "_reply", "_command", "onCommand", "socket", "_ws", "ws.open", "ws.send", "ws.close"] { t.ok(VyreAppWindow.bridgeSource.contains(op), op) }
    }
}
