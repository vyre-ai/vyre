// SystemCommands tests: the table is complete, the dangerous ones confirm, and matching is tight.

import Foundation

// capsule-suite: systemCommandsSuite
let systemCommandsSuite = Suite("systemcommands") { t in
    t.test("the table") {
        let ids = SystemCommands.all.map(\.id)
        t.eq(Set(ids).count, ids.count, "ids are unique")
        for id in ["lock", "sleep", "restart", "shutdown", "logout", "empty-trash", "dark-mode", "show-desktop", "screen-saver", "mute",
                   "volume-up", "volume-down", "play-pause", "next-track", "previous-track", "eject-all", "quit-all", "hide-others",
                   "hidden-files"] {
            t.ok(SystemCommands.command(id) != nil, id)
        }
        let dangerous = Set(SystemCommands.all.filter { $0.dangerous != nil }.map(\.id))
        t.eq(dangerous, ["restart", "shutdown", "logout", "empty-trash", "quit-all"])
        for c in SystemCommands.all {
            t.ok(!c.symbol.isEmpty && !c.keywords.isEmpty, c.id)
            if let d = c.dangerous { t.ok(d.hasSuffix(".") && d.contains("?") && !d.contains("!"), d) }
        }
    }

    t.test("matching") {
        func top(_ q: String) -> String? { SystemCommands.match(q).first?.command.id }
        t.eq(top("lock"), "lock")
        t.eq(top("restart"), "restart")
        t.eq(top("reboot"), "restart")
        t.eq(top("shut"), "shutdown")
        t.eq(top("empty trash"), "empty-trash")
        t.eq(top("dark mode"), "dark-mode")
        t.eq(top("mute"), "mute")
        t.eq(top("vol"), "volume-up")
        t.eq(top("eject"), "eject-all")
        t.eq(top("hidden"), "hidden-files")
        t.eq(top("sign out"), "logout")
        t.ok(SystemCommands.match("s").isEmpty, "one letter is not enough")
        t.ok(SystemCommands.match("qzx").isEmpty)
        t.ok(!SystemCommands.match("sl").contains { $0.command.id == "shutdown" }, "scattered letters do not count")
    }

    t.test("rows") {
        let rows = systemCommandResults(Query("empty trash"))
        t.eq(rows.first?.id, "system:empty-trash")
        t.eq(rows.first?.section, .commands)
        t.eq(rows.first?.icon, .symbol("trash"))
        t.eq(rows.first?.payload["command"], "empty-trash")
        t.eq(rows.first?.payload["confirm"], "Empty the Trash? This cannot be undone.")
        t.ok(systemCommandResults(Query("lock")).first?.payload["confirm"] == nil)
    }
}
