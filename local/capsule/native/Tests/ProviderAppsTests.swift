// capsule-suite: providerAppsSuite
// Apps, settings panes, launch rules and file actions. App folders are fixtures under the scratch
// dir; copies go to a private named pasteboard, never the general one.

import AppKit
import Foundation

func makeFakeApp(_ path: String, bundle: String?) {
    try? FileManager.default.createDirectory(atPath: path + "/Contents", withIntermediateDirectories: true)
    if let bundle {
        (["CFBundleIdentifier": bundle] as NSDictionary).write(toFile: path + "/Contents/Info.plist", atomically: true)
    }
}

let providerAppsSuite = Suite("provider apps") { t in
    t.test("apps: one and two levels deep, deduped by path and bundle id, searched from the cache") {
        let root = providerFixture("apps")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let a = root + "/Applications", u = a + "/Utilities", other = root + "/Other"
        for d in [a, u, other] { try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
        makeFakeApp(a + "/Adobe Thing/Adobe Photo Editor.app", bundle: "com.example.photo")
        makeFakeApp(a + "/Visual Studio Code.app", bundle: "com.example.vscode")
        makeFakeApp(a + "/Safari.app", bundle: "com.example.safari")
        makeFakeApp(a + "/Safari.app/Contents/Inner.app", bundle: "com.example.inner")
        makeFakeApp(u + "/Terminal.app", bundle: "com.example.terminal")
        makeFakeApp(a + "/.Hidden.app", bundle: "com.example.hidden")
        makeFakeApp(other + "/Safari Copy.app", bundle: "com.example.safari")
        let apps = AppsProvider(dirs: [a, u, other, root + "/missing"], home: root, includeRunning: false, board: { NSPasteboard(name: testBoardName) })
        t.eq(apps.search("saf").count, 0, "nothing cached yet, and it does not wait")
        apps.refreshIfChanged(wait: true)
        // The empty-cache search above may have started a scan of its own; the list is the same.
        t.eq(apps.all.map(\.name).sorted(), ["Adobe Photo Editor", "Safari", "Terminal", "Visual Studio Code"])
        let saf = apps.search("saf").first
        t.eq(saf?.title, "Safari")
        t.eq(saf?.id, "app:\(a)/Safari.app")
        t.eq(saf?.subtitle, "~/Applications")
        t.eq(saf?.section, .apps)
        t.eq(saf?.icon, .file("\(a)/Safari.app"))
        t.eq(saf?.payload["bundle"], "com.example.safari")
        t.eq(saf?.actions.map(\.id), ["open", "reveal", "copy-path"], "not running: no quit or hide")
        t.eq(saf?.actions[1].shortcut, KeyShortcut("return", command: true))
        t.eq(saf?.actions[2].shortcut, KeyShortcut("c", command: true, shift: true))
        t.eq(apps.search("vsc").first?.title, "Visual Studio Code")
        t.eq(apps.search("photo").first?.title, "Adobe Photo Editor")
    }

    t.test("apps: warm() rescans only when a folder's mtime moved") {
        let root = providerFixture("apps-mtime")
        defer { try? FileManager.default.removeItem(atPath: root) }
        makeFakeApp(root + "/Notes.app", bundle: "com.example.notes")
        let apps = AppsProvider(dirs: [root], home: root, includeRunning: false)
        apps.refreshIfChanged(wait: true)
        t.eq(apps.scans, 1)
        apps.refreshIfChanged(wait: true)
        apps.refreshIfChanged(wait: true)
        t.eq(apps.scans, 1, "nothing changed, nothing scanned")
        makeFakeApp(root + "/Notion.app", bundle: "com.example.notion")
        // Folder mtimes have one-second resolution on some volumes; set it past the last scan.
        try? FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(5)], ofItemAtPath: root)
        apps.refreshIfChanged(wait: true)
        t.eq(apps.scans, 2)
        t.eq(apps.all.count, 2)
        t.eq(apps.search("no").first?.title, "Notes", "shorter name first on a tie")
    }

    t.test("apps: a running app gets Hide and Quit") {
        // Finder is always running and always in /System/Library/CoreServices.
        let apps = AppsProvider(dirs: ["/System/Library/CoreServices"], includeRunning: false)
        apps.refreshIfChanged(wait: true)
        let finder = apps.search("finder").first
        t.eq(finder?.title, "Finder")
        t.eq(finder?.actions.map(\.id), ["open", "reveal", "copy-path", "hide", "quit"])
    }

    t.test("settings: synonyms find panes, URLs are the table's") {
        let s = SettingsProvider(bundleDirs: [])
        t.eq(s.search("wifi").first?.title, "Wi-Fi")
        t.eq(s.search("volume").first?.title, "Sound")
        t.eq(s.search("dark mode").first?.title, "Appearance")
        t.eq(s.search("fda").first?.title, "Full Disk Access")
        let w = s.search("wi-fi").first
        t.eq(w?.payload["url"], "x-apple.systempreferences:com.apple.wifi-settings-extension")
        t.eq(w?.id, "setting:com.apple.wifi-settings-extension")
        t.eq(w?.section, .settings)
        t.eq(w?.icon, .symbol("wifi", .stone), "no bundles read: the table's symbol")
        t.eq(SettingsProvider.PANES.count, 44)
        t.eq(Set(SettingsProvider.PANES.map(\.pane)).count, 44, "every pane once")
        t.ok(SettingsProvider.PANES.allSatisfy { NSImage(systemSymbolName: $0.symbol, accessibilityDescription: nil) != nil }, "every symbol exists")
        t.eq(SettingsProvider.paneID("com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"), "com.apple.settings.PrivacySecurity.extension")
        t.ok(s.search("zzqx").isEmpty)
    }

    t.test("settings: real pane icons from the extension bundles") {
        let map = SettingsProvider.readBundles(["/System/Library/ExtensionKit/Extensions"])
        let s = SettingsProvider()
        s.warm()
        let until = Date().addingTimeInterval(5)
        while Date() < until, case .symbol = s.icon(SettingsProvider.PANES[0]) { usleep(20_000) }
        if map["com.apple.wifi-settings-extension"] != nil {
            if case .file(let p) = s.icon(SettingsProvider.PANES[0]) { t.ok(p.hasSuffix(".appex"), p) } else { t.ok(false, "Wi-Fi has a bundle icon") }
        }
        let found = SettingsProvider.PANES.filter { map[SettingsProvider.paneID($0.pane)] != nil }.count
        t.ok(found >= 30, "\(found) of 44 panes have a bundle on this Mac")
    }

    t.test("launch: only known schemes and absolute file URLs") {
        t.ok(Launch.allowed(URL(string: "x-apple.systempreferences:com.apple.wifi-settings-extension")!))
        t.ok(Launch.allowed(URL(string: "addressbook://A1")!))
        t.ok(Launch.allowed(URL(fileURLWithPath: "/Applications/Safari.app")))
        t.ok(!Launch.allowed(URL(string: "javascript:alert(1)")!))
        t.ok(!Launch.allowed(URL(string: "ssh://alex@harlow.example")!))
        t.eq(Launch.settingsURL("com.apple.Sound-Settings.extension")?.absoluteString, "x-apple.systempreferences:com.apple.Sound-Settings.extension")
        t.eq(Launch.tilde("/Users/alex/Documents/a", home: "/Users/alex"), "~/Documents/a")
        t.eq(Launch.tilde("/Users/alex", home: "/Users/alex"), "~")
        t.eq(Launch.tilde("/Users/alexandra/x", home: "/Users/alex"), "/Users/alexandra/x")
        t.eq(t.wait { await Launch.open(URL(string: "javascript:x")!) }, .failed("The Capsule does not open that."))
        t.eq(t.wait { await Launch.open(URL(fileURLWithPath: "/nonexistent/northwind.pdf")) }, .failed("That file is gone."))
    }

    t.test("file actions: copy path and file to a private board, trash asks first, Quick Look and drag") {
        let dir = providerFixture("actions")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/Northwind ledger.txt"
        FileManager.default.createFile(atPath: path, contents: Data("kit".utf8))
        let url = URL(fileURLWithPath: path)
        let board = NSPasteboard(name: testBoardName)
        defer { board.releaseGlobally() }
        let acts = FileActions.actions(for: url, isFolder: false, board: { NSPasteboard(name: testBoardName) })
        t.eq(acts.map(\.id), ["open", "reveal", "copy-path", "copy-file", "quicklook", "trash"])
        t.ok(acts.last?.confirm != nil, "trash never runs from one keypress")
        let item = ResultItem(id: "file:" + path, kind: "file", title: "Northwind ledger.txt", fileURL: url)
        let ctx = ActionContext(query: Query("northwind"))
        t.eq(t.wait { await acts[2].run(item, ctx) }, .said("Copied the path"))
        t.eq(board.string(forType: .string), path)
        t.eq(t.wait { await acts[3].run(item, ctx) }, .said("Copied. Paste it in Finder or a message."))
        let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
        t.eq(urls?.map(\.path), [path])
        t.eq(FileActions.quickLookURLs([item, ResultItem(id: "x", kind: "file", title: "gone", fileURL: URL(fileURLWithPath: dir + "/gone"))]), [url])
        t.eq((FileActions.pasteboardWriter(for: item) as? NSURL)?.path, path)
        t.ok(FileActions.pasteboardWriter(for: ResultItem(id: "y", kind: "app", title: "y")) == nil)
        let apps = FileActions.openWithApps(for: url)
        t.ok(!apps.isEmpty && apps.count <= 6, "\(apps.count) apps open a .txt")
        t.eq(Set(apps.map(\.path)).count, apps.count, "no duplicates")
        t.eq(FileActions.openWithActions(for: url).count, apps.count)
        t.ok(FileManager.default.fileExists(atPath: path), "nothing here moved the file")
    }
}
