// SystemCommands: the table of Mac commands the Capsule lists ("Lock screen", "Empty Trash",
// "Toggle dark mode"), as data, and how a query finds them.
//
// Execution is not here: the app runs each one by id (it owns AppleScript, IOKit and the
// permission prompts, and some need Automation or Accessibility). Keeping the table pure means
// the list, its words and its safety lines are tested without touching the Mac.
//
// Anything that loses work or cannot be undone (restart, shut down, log out, empty trash, quit
// all apps) carries a `dangerous` confirm line, and the app must ask it inline before running:
// destructive work never runs from one keypress. The lines say what will happen, plainly.
//
// Matching uses Match.score on the title with the keywords as synonyms, and keeps only word-level
// hits or better (0.5 and up): "sl" should not offer "Shut down" from scattered letters.

import Foundation

public struct SystemCommand: Sendable, Equatable {
    public var id: String
    public var title: String
    public var keywords: [String]
    public var symbol: String
    /// The confirm line for commands that lose work or cannot be undone; nil for the rest.
    public var dangerous: String?
}

public enum SystemCommands {
    public static let all: [SystemCommand] = [
        .init(id: "lock", title: "Lock Screen", keywords: ["lock", "lock mac", "away"], symbol: "lock", dangerous: nil),
        .init(id: "sleep", title: "Sleep", keywords: ["sleep mac", "suspend", "nap"], symbol: "moon.zzz", dangerous: nil),
        .init(id: "restart", title: "Restart", keywords: ["reboot", "restart mac"], symbol: "arrow.clockwise.circle",
              dangerous: "Restart this Mac? Open apps will be asked to quit."),
        .init(id: "shutdown", title: "Shut Down", keywords: ["shutdown", "power off", "turn off"], symbol: "power",
              dangerous: "Shut down this Mac? Open apps will be asked to quit."),
        .init(id: "logout", title: "Log Out", keywords: ["logout", "sign out", "log off"], symbol: "rectangle.portrait.and.arrow.right",
              dangerous: "Log out? Open apps will be asked to quit."),
        .init(id: "empty-trash", title: "Empty Trash", keywords: ["trash", "bin", "delete trash", "empty bin"], symbol: "trash",
              dangerous: "Empty the Trash? This cannot be undone."),
        .init(id: "dark-mode", title: "Toggle Dark Mode", keywords: ["dark mode", "light mode", "appearance", "theme", "night"],
              symbol: "circle.lefthalf.filled", dangerous: nil),
        .init(id: "show-desktop", title: "Show Desktop", keywords: ["desktop", "hide windows"], symbol: "menubar.dock.rectangle", dangerous: nil),
        .init(id: "screen-saver", title: "Start Screen Saver", keywords: ["screensaver", "screen saver"], symbol: "sparkles.tv", dangerous: nil),
        .init(id: "mute", title: "Toggle Mute", keywords: ["mute", "unmute", "silence", "sound off"], symbol: "speaker.slash", dangerous: nil),
        .init(id: "volume-up", title: "Volume Up", keywords: ["louder", "sound up"], symbol: "speaker.wave.3", dangerous: nil),
        .init(id: "volume-down", title: "Volume Down", keywords: ["quieter", "softer", "sound down"], symbol: "speaker.wave.1", dangerous: nil),
        .init(id: "play-pause", title: "Play or Pause", keywords: ["play", "pause", "music", "resume"], symbol: "playpause", dangerous: nil),
        .init(id: "next-track", title: "Next Track", keywords: ["next", "skip", "next song"], symbol: "forward", dangerous: nil),
        .init(id: "previous-track", title: "Previous Track", keywords: ["previous", "back", "last song", "prev"], symbol: "backward", dangerous: nil),
        .init(id: "eject-all", title: "Eject All Disks", keywords: ["eject", "unmount", "eject disks"], symbol: "eject", dangerous: nil),
        .init(id: "quit-all", title: "Quit All Apps", keywords: ["quit all", "close all apps", "quit everything"], symbol: "xmark.circle",
              dangerous: "Quit all apps? Apps with unsaved work will ask first."),
        .init(id: "hide-others", title: "Hide Other Apps", keywords: ["hide others", "hide all", "focus"], symbol: "eye.slash", dangerous: nil),
        .init(id: "hidden-files", title: "Toggle Hidden Files", keywords: ["hidden files", "show hidden", "dotfiles", "invisible files"],
              symbol: "eye", dangerous: nil),
    ]

    public static func command(_ id: String) -> SystemCommand? { all.first { $0.id == id } }

    /// Commands for this query, best first; ties keep table order.
    public static func match(_ query: String) -> [(command: SystemCommand, score: Double)] {
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.count < 2 { return [] }
        var out: [(SystemCommand, Double, Int)] = []
        for (i, c) in all.enumerated() {
            let s = Match.score(q, c.title, synonyms: c.keywords)
            if s >= 0.5 { out.append((c, s, i)) }
        }
        return out.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.2 < $1.2 }.map { ($0.0, $0.1) }
    }
}

/// A system command row. The app runs `payload["command"]`, asking `payload["confirm"]` first when set.
public func systemCommandResult(_ c: SystemCommand, score: Double) -> ResultItem {
    var payload = ["command": c.id]
    if let d = c.dangerous { payload["confirm"] = d }
    return ResultItem(id: "system:\(c.id)", kind: "system", title: c.title, subtitle: "Mac",
                      icon: .symbol(c.symbol), section: .commands, score: score, payload: payload)
}

public func systemCommandResults(_ q: Query, limit: Int = 4) -> [ResultItem] {
    SystemCommands.match(q.text).prefix(limit).map { systemCommandResult($0.command, score: $0.score) }
}
