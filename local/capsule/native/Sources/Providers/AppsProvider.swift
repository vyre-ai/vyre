// AppsProvider: the installed apps, from the app folders plus whatever is running, by the name
// Finder shows ("System Settings", in the user's language), matched from memory on every keystroke.
//
// local.js listed APP_DIRS and read no Info.plist, to keep a scan to a few milliseconds per
// keystroke-driven refresh. Here the scan runs once, off the main thread, and again only on warm()
// when one of the scanned directories' mtime moved (an app installed, removed or renamed changes
// its folder's mtime), so reading each bundle's id and localized name is paid rarely. Folders are
// read one level down too, for vendor folders like "/Applications/Adobe X/"; Utilities folders are
// listed in APP_DIRS themselves. Running apps that live elsewhere (a download run from
// ~/Downloads, an app inside another app) are added from NSWorkspace, and the list is deduped by
// path and by bundle id, the first folder in APP_DIRS winning.
//
// Quick: results come only from the cache. An empty cache (the very first show) starts a scan and
// answers [] that once, as local.js did, so a keystroke never waits on the disk.

import AppKit
import Foundation

public struct AppRecord: Sendable, Equatable {
    public var path: String
    /// What Finder shows, localized: "System Settings", not "System Settings.app".
    public var name: String
    /// The bundle's file name without ".app", kept as a synonym when it differs from `name`.
    public var fileName: String
    public var bundleID: String?
}

public final class AppsProvider: ResultProvider, @unchecked Sendable {
    public let id = "apps"
    public let speed = Speed.quick
    public static let APP_DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications",
                                  "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]

    let dirs: [String]
    let home: String
    let includeRunning: Bool
    let board: @Sendable () -> NSPasteboard
    private let lock = NSLock()
    private var apps: [AppRecord] = []
    private var mtimes: [String: Date] = [:]
    private var scanning = false
    private let scanQueue = DispatchQueue(label: "vyre.capsule.apps.scan", qos: .userInitiated)
    /// How many scans ran, for tests of "only when a directory changed".
    public private(set) var scans = 0
    public var limit = 6

    public init(dirs: [String] = AppsProvider.APP_DIRS, home: String = NSHomeDirectory(), includeRunning: Bool = true,
                board: @escaping @Sendable () -> NSPasteboard = { .general }) {
        self.dirs = dirs; self.home = home; self.includeRunning = includeRunning; self.board = board
    }

    public var all: [AppRecord] { lock.withLock { apps } }

    /// Rescan off the main thread if a directory changed since the last scan (or there was none).
    public func warm() { refreshIfChanged(wait: false) }

    /// Keeps the list: it is small (a few hundred records) and warm() needs it on the next show.
    public func cool() {}

    /// Rescan if needed. `wait` blocks until done (waiting out a scan already running), for tests
    /// and for the first launch. Scans run one at a time on their own queue.
    public func refreshIfChanged(wait: Bool) {
        // Checking the mtimes lists the folders too, so all of it runs off the main thread.
        let work = { [self] in
            let have: (Bool, [String: Date]) = lock.withLock { (!apps.isEmpty, mtimes) }
            if have.0 && Self.dirMtimes(dirs) == have.1 { return }
            let (list, m) = Self.scan(dirs, running: includeRunning ? Self.runningApps() : [])
            lock.withLock { apps = list; mtimes = m; scans += 1 }
        }
        if wait { scanQueue.sync(execute: work); return }
        let go: Bool = lock.withLock { if scanning { return false }; scanning = true; return true }
        guard go else { return }
        scanQueue.async { [self] in work(); lock.withLock { scanning = false } }
    }

    /// Every scanned directory and each folder one level down, with its mtime.
    static func dirMtimes(_ dirs: [String]) -> [String: Date] {
        let fm = FileManager.default
        var out: [String: Date] = [:]
        for d in dirs {
            guard let a = try? fm.attributesOfItem(atPath: d), let m = a[.modificationDate] as? Date else { continue }
            out[d] = m
            for e in (try? fm.contentsOfDirectory(atPath: d)) ?? [] where !e.hasPrefix(".") && !e.lowercased().hasSuffix(".app") {
                let p = d + "/" + e
                var isDir: ObjCBool = false
                if fm.fileExists(atPath: p, isDirectory: &isDir), isDir.boolValue,
                   let m2 = (try? fm.attributesOfItem(atPath: p))?[.modificationDate] as? Date { out[p] = m2 }
            }
        }
        return out
    }

    static func runningApps() -> [String] {
        NSWorkspace.shared.runningApplications.compactMap { a in
            a.activationPolicy == .regular ? a.bundleURL?.path : nil
        }
    }

    static func record(_ path: String) -> AppRecord {
        let file = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        var name = FileManager.default.displayName(atPath: path)
        if name.lowercased().hasSuffix(".app") { name = String(name.dropLast(4)) }
        if name.isEmpty { name = file }
        let info = NSDictionary(contentsOfFile: path + "/Contents/Info.plist")
        return AppRecord(path: path, name: name, fileName: file, bundleID: info?["CFBundleIdentifier"] as? String)
    }

    static func scan(_ dirs: [String], running: [String]) -> ([AppRecord], [String: Date]) {
        let fm = FileManager.default
        let mt = dirMtimes(dirs)
        var paths: [String] = []
        for d in dirs {
            for e in ((try? fm.contentsOfDirectory(atPath: d)) ?? []).sorted() where !e.hasPrefix(".") {
                let p = d + "/" + e
                if e.lowercased().hasSuffix(".app") { paths.append(p); continue }
                guard mt[p] != nil else { continue }
                for e2 in ((try? fm.contentsOfDirectory(atPath: p)) ?? []).sorted() where !e2.hasPrefix(".") && e2.lowercased().hasSuffix(".app") {
                    paths.append(p + "/" + e2)
                }
            }
        }
        paths += running
        var seenPath = Set<String>(), seenID = Set<String>(), out: [AppRecord] = []
        for p in paths {
            let key = (p as NSString).standardizingPath
            guard seenPath.insert(key).inserted else { continue }
            let r = record(key)
            if let b = r.bundleID { guard seenID.insert(b.lowercased()).inserted else { continue } }
            out.append(r)
        }
        return (out, mt)
    }

    public func results(for query: Query) async -> [ResultItem] { search(query.text) }

    /// From the cache only. An empty cache starts a scan and answers [] this once.
    public func search(_ text: String) -> [ResultItem] {
        let list = all
        if list.isEmpty { refreshIfChanged(wait: false); return [] }
        var hits: [(AppRecord, Double)] = []
        for a in list {
            let s = Match.score(text, a.name, synonyms: a.fileName == a.name ? [] : [a.fileName])
            if s > 0 { hits.append((a, s)) }
        }
        hits.sort { x, y in x.1 != y.1 ? x.1 > y.1 : x.0.name.count != y.0.name.count ? x.0.name.count < y.0.name.count : x.0.name < y.0.name }
        return hits.prefix(limit).map { item($0.0, score: $0.1) }
    }

    func item(_ a: AppRecord, score: Double) -> ResultItem {
        let url = URL(fileURLWithPath: a.path, isDirectory: true)
        let board = self.board
        var actions: [ResultAction] = [
            ResultAction(id: "open", title: "Open", symbol: "arrow.up.forward.app", shortcut: KeyShortcut("return")) { _, _ in await Launch.openApp(url) },
            ResultAction(id: "reveal", title: "Show in Finder", symbol: "folder", shortcut: KeyShortcut("return", command: true)) { _, _ in
                FileActions.reveal(url)
            },
            ResultAction(id: "copy-path", title: "Copy path", symbol: "doc.on.clipboard", shortcut: KeyShortcut("c", command: true, shift: true)) { _, _ in
                FileActions.copyPath(url, to: board()) ? .said("Copied the path") : .failed("Could not copy the path.")
            },
        ]
        if let b = a.bundleID, !NSRunningApplication.runningApplications(withBundleIdentifier: b).isEmpty {
            let name = a.name
            actions.append(ResultAction(id: "hide", title: "Hide \(name)", symbol: "eye.slash") { _, _ in
                await MainActor.run {
                    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: b)
                    if apps.isEmpty { return .failed("\(name) is not running.") }
                    apps.forEach { $0.hide() }
                    return .said("Hid \(name)")
                }
            })
            actions.append(ResultAction(id: "quit", title: "Quit \(name)", symbol: "xmark.circle") { _, _ in
                await MainActor.run {
                    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: b)
                    if apps.isEmpty { return .failed("\(name) is not running.") }
                    // terminate() lets the app ask about unsaved work itself; it is never forced.
                    return apps.map { $0.terminate() }.contains(true) ? .said("Asked \(name) to quit") : .failed("\(name) did not quit.")
                }
            })
        }
        return ResultItem(id: "app:" + a.path, kind: "app", title: a.name, subtitle: Launch.tilde((a.path as NSString).deletingLastPathComponent, home: home),
                          icon: .file(a.path), section: .apps, score: score, actions: actions, fileURL: url, copyText: a.path,
                          payload: a.bundleID.map { ["bundle": $0] } ?? [:])
    }
}

extension AppsProvider: ImmediateResults {
    public func resultsNow(for query: Query) -> [ResultItem] { search(query.text) }
}
