// capsule-suite: bundledAppSuite
// The app window's own files (Host/BundledApp.swift): a Mac with no local vyred serves the web build from inside the app and nothing outside it.

import Foundation

let bundledAppSuite = Suite("bundled app") { t in
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
            t.ok(VyreAppWindow.bridgeSource.contains("version: window.__vyreVersion"), "the bridge carries the app version")
            t.eq(VyreAppWindow.versionScript("0.3.0-rc.1"), "window.__vyreVersion = \"0.3.0-rc.1\";")
        }
    }

    t.test("a Mac built without the web export has no bundled app") {
        t.eq(BundledApp.locate(env: [:], resources: nil), nil)
        t.eq(BundledApp.locate(env: [:], resources: vyScratch("no-app-\(UUID().uuidString.prefix(6))")), nil)
    }
}
