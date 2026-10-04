// capsule-suite: firstRunSuite
// The Mac's first run (Host/FirstRun.swift, BundledApp.swift): what a launch does for each choice and each state of vyred, that the choice is kept and
// read back, and that a server Mac's window serves the app's own files from inside the app and nothing outside it.

import Foundation

let firstRunSuite = Suite("first run") { t in
    t.test("no choice and no vyred asks where Vyre should run; no choice with vyred running leaves the menu-bar app as it was") {
        t.eq(FirstRun.decide(vyredUp: false, remembered: nil), .askWhere)
        t.eq(FirstRun.decide(vyredUp: true, remembered: nil), .nothing)
    }

    t.test("a kept choice opens straight into the app; a Mac that chose itself starts vyred when it is down") {
        t.eq(FirstRun.decide(vyredUp: true, remembered: .here), .openApp(boxless: false))
        t.eq(FirstRun.decide(vyredUp: false, remembered: .here), .startHere)
        t.eq(FirstRun.decide(vyredUp: false, remembered: .server), .openApp(boxless: true))
        t.eq(FirstRun.decide(vyredUp: true, remembered: .server), .openApp(boxless: true))
    }

    t.test("the choice is kept in the home, read back, and forgotten") {
        let home = vyScratch("first-run-\(UUID().uuidString.prefix(6))")
        let store = FirstRunStore(home: home)
        t.eq(store.load(), nil)
        store.save(.server)
        t.eq(FirstRunStore(home: home).load(), .server)
        store.save(.here)
        t.eq(store.load(), .here)
        store.forget()
        t.eq(store.load(), nil)
    }

    t.test("a file that is not ours is no choice") {
        let home = vyScratch("first-run-bad-\(UUID().uuidString.prefix(6))")
        let store = FirstRunStore(home: home)
        try? FileManager.default.createDirectory(atPath: (store.file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: store.file, contents: Data("{\"choice\":\"elsewhere\"}".utf8))
        t.eq(store.load(), nil)
        FileManager.default.createFile(atPath: store.file, contents: Data("not json".utf8))
        t.eq(store.load(), nil)
    }

    t.test("the bundled app answers its files and its routes, and nothing outside its folder") {
        let dir = vyScratch("bundled-\(UUID().uuidString.prefix(6))")
        let fm = FileManager.default
        try? fm.createDirectory(atPath: dir + "/_expo/static/js", withIntermediateDirectories: true)
        fm.createFile(atPath: dir + "/index.html", contents: Data("<html></html>".utf8))
        fm.createFile(atPath: dir + "/_expo/static/js/entry.js", contents: Data("1".utf8))
        let secret = vyScratch("bundled-secret-\(UUID().uuidString.prefix(6))") + "/secret.txt"
        fm.createFile(atPath: secret, contents: Data("no".utf8))

        t.eq(BundledApp.resolve(path: "/app/", in: dir), .file(path: URL(fileURLWithPath: dir).standardizedFileURL.path + "/index.html", mime: "text/html; charset=utf-8"))
        t.eq(BundledApp.resolve(path: "/app", in: dir), BundledApp.resolve(path: "/app/", in: dir))
        t.eq(BundledApp.resolve(path: "/app/u/now", in: dir), BundledApp.resolve(path: "/app/", in: dir), "a route of the app is the one page")
        if case .file(let p, let mime) = BundledApp.resolve(path: "/app/_expo/static/js/entry.js", in: dir) {
            t.ok(p.hasSuffix("/_expo/static/js/entry.js"), "the script itself")
            t.eq(mime, "text/javascript; charset=utf-8")
        } else { t.ok(false, "the script is served") }
        t.eq(BundledApp.resolve(path: "/app/_expo/missing.js", in: dir), .missing, "a missing asset is not the page")
        t.eq(BundledApp.resolve(path: "/v1/health", in: dir), .missing, "a call to a box has no vyred here")
        t.eq(BundledApp.resolve(path: "/app/../" + (secret as NSString).lastPathComponent, in: dir), .missing)
        t.eq(BundledApp.resolve(path: "/app/%2e%2e/%2e%2e/" + String(secret.dropFirst()), in: dir), .missing, "an encoded way out is no way out")
    }

    t.test("the app window says a server Mac has no box, and the page's bridge reports it") {
        MainActor.assumeIsolated {
            t.ok(VyreAppWindow.bridgeSource.contains("boxless: !!window.__vyreBoxless"))
            t.eq(VyreAppWindow.shared.boxless, false, "closed, it is not boxless")
        }
    }

    t.test("a Mac built without the web export has no bundled app") {
        t.eq(BundledApp.locate(env: [:], resources: nil), nil)
        t.eq(BundledApp.locate(env: [:], resources: vyScratch("no-app-\(UUID().uuidString.prefix(6))")), nil)
    }
}
