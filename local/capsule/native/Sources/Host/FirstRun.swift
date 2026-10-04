// FirstRun: the Mac app's first run, as a decision. The Capsule is a menu-bar app whose one window needs a local vyred, so a Mac with no vyred and no
// server had nowhere to begin. Now the first thing it shows is "Where should Vyre run?": on this Mac (the bundled setup, then the app window) or on a
// server (the app window with no local vyred: its page pairs to the server by typed code over the relay, as a browser does).
//
// This file is the pure part, so the Swift tests can run it: what the person chose is kept in <home>/capsule/first-run.json, and `decide` says what
// a launch does given that and whether vyred answered. The window is FirstRunWindow.swift. A Mac that already runs vyred and never chose anything
// (an install from before this window) is left as it was: the menu-bar app, no window.

import Foundation

public enum FirstRunChoice: String, Equatable {
    /// vyred runs on this Mac.
    case here
    /// vyred runs on a server; this Mac's app window is a client of it.
    case server
}

public enum FirstRunStart: Equatable {
    /// Nothing to show: a Mac that already runs vyred, from before the first run existed.
    case nothing
    /// No choice yet and no vyred: ask where Vyre should run.
    case askWhere
    /// Chose this Mac, and vyred is not running (restarted, or setup was left half done): start it, then open the app.
    case startHere
    /// Open the app window; `boxless` is a server Mac, whose window carries the web export itself and talks to the server over the relay.
    case openApp(boxless: Bool)
}

public struct FirstRunStore {
    public let file: String

    public init(home: String) { file = (home as NSString).appendingPathComponent("capsule/first-run.json") }

    /// What the person chose, or nil when they have not (or the file is not ours).
    public func load() -> FirstRunChoice? {
        guard let d = try? Data(contentsOf: URL(fileURLWithPath: file)),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let c = o["choice"] as? String else { return nil }
        return FirstRunChoice(rawValue: c)
    }

    public func save(_ choice: FirstRunChoice) {
        try? FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        guard let d = try? JSONSerialization.data(withJSONObject: ["choice": choice.rawValue]) else { return }
        try? d.write(to: URL(fileURLWithPath: file), options: .atomic)
    }

    /// Ask again at the next launch.
    public func forget() { try? FileManager.default.removeItem(atPath: file) }
}

public enum FirstRun {
    /// What a launch does. `vyredUp` is what the first look at /v1/health said.
    public static func decide(vyredUp: Bool, remembered: FirstRunChoice?) -> FirstRunStart {
        switch remembered {
        case .server?: return .openApp(boxless: true)
        case .here?: return vyredUp ? .openApp(boxless: false) : .startHere
        case nil: return vyredUp ? .nothing : .askWhere
        }
    }
}
