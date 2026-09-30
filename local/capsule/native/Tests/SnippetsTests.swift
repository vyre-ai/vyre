// Snippets tests: the file model, validation, matching and placeholder expansion.

import Foundation

// capsule-suite: snippetsSuite
let snippetsSuite = Suite("snippets") { t in
    let good = #"""
    {
      "snippets": [
        { "keyword": ";sig", "title": "Signature", "text": "alex\nHarlow Legal\n{date}" },
        { "keyword": ";re", "text": "Re: {clipboard}{cursor}" }
      ],
      "commands": [
        { "title": "Open the Northwind board", "keywords": ["board", "bakery"], "run": { "open": "https://example.com/board" } },
        { "title": "Deploy kit", "keywords": ["ship"], "run": { "shell": "make deploy", "confirm": true } },
        { "title": "Tail juno logs", "run": { "shell": "tail -f juno.log" } }
      ]
    }
    """#

    t.test("parses a good file") {
        let s = UserSnippets.parse(Data(good.utf8))
        t.eq(s.problems, [])
        t.eq(s.snippets.count, 2)
        t.eq(s.snippets[0], Snippet(keyword: ";sig", title: "Signature", text: "alex\nHarlow Legal\n{date}"))
        t.ok(!s.snippets[0].usesClipboard && s.snippets[1].usesClipboard)
        t.eq(s.commands.count, 3)
        t.eq(s.commands[0].run, .open(URL(string: "https://example.com/board")!))
        t.eq(s.commands[1].run, .shell("make deploy"))
        t.eq(s.commands[2].confirm, "Run \u{201C}tail -f juno.log\u{201D}?", "confirm left out still confirms")
        t.ok(s.commands[0].confirm == nil)
    }

    t.test("keeps the good entries and names the bad ones") {
        let bad = #"""
        { "snippets": [ { "keyword": "", "text": "x" }, { "keyword": "a b", "text": "x" }, { "keyword": ";ok", "text": "fine" },
                        { "keyword": ";OK", "text": "again" }, { "keyword": ";none" }, 7 ],
          "commands": [ { "title": "", "run": { "open": "https://example.com" } }, { "title": "No run" },
                        { "title": "Both", "run": { "open": "https://example.com", "shell": "ls" } },
                        { "title": "Script", "run": { "open": "javascript:alert(1)" } },
                        { "title": "No host", "run": { "open": "https://" } },
                        { "title": "Unconfirmed", "run": { "shell": "rm -rf build", "confirm": false } },
                        { "title": "Empty", "run": { "shell": "  " } },
                        { "title": "Notes", "run": { "open": "notes://" } } ] }
        """#
        let s = UserSnippets.parse(Data(bad.utf8))
        t.eq(s.snippets.map(\.keyword), [";ok"])
        t.eq(s.commands.map(\.title), ["Notes"])
        t.eq(s.problems, [
            "snippet 1: keyword is empty", "snippet 2: keyword \u{201C}a b\u{201D} has a space",
            "snippet 4: keyword \u{201C};OK\u{201D} is used twice", "snippet 5: text is empty", "snippet 6: not an object",
            "command 1: title is empty", "command 2: run is missing", "command 3: run needs one of open or shell",
            "command 4: \u{201C}javascript:alert(1)\u{201D} is not a link to open", "command 5: \u{201C}https://\u{201D} is not a link to open",
            "command 6: shell commands always confirm; set confirm to true", "command 7: shell is empty",
        ])
        t.eq(UserSnippets.parse(Data("{nope".utf8)).problems.count, 1)
    }

    t.test("load from a path; a missing file is empty") {
        let dir = coreTestDir("snippets")
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("snippets.json")
        t.eq(UserSnippets.load(path: file.path).snippets.count, 0)
        t.eq(UserSnippets.load(path: file.path).problems, [])
        try? Data(good.utf8).write(to: file)
        t.eq(UserSnippets.load(path: file.path).snippets.count, 2)
    }

    t.test("quicklinks: parse, validate, match the keyword and its words, encode the hole") {
        let q = #"""
        { "snippets": [ { "keyword": "nw", "text": "x" } ],
          "quicklinks": [
            { "name": "Northwind wiki", "keyword": "wiki", "url": "https://wiki.example.com/search?q={query}" },
            { "name": "Board", "keyword": "board", "url": "https://example.com/board" },
            { "name": "Empty", "keyword": "", "url": "https://example.com" },
            { "name": "Dupe", "keyword": "NW", "url": "https://example.com" },
            { "name": "Script", "keyword": "js", "url": "javascript:alert(1)" },
            { "name": "File", "keyword": "f", "url": "file:///etc/passwd" },
            { "name": "Spaced", "keyword": "a b", "url": "https://example.com" } ] }
        """#
        let s = UserSnippets.parse(Data(q.utf8))
        t.eq(s.quicklinks.map(\.keyword), ["wiki", "board"])
        t.eq(s.problems, ["quicklink 3: keyword is empty", "quicklink 4: keyword \u{201C}NW\u{201D} is used twice",
                          "quicklink 5: the url is not a link to open", "quicklink 6: the url is not a link to open",
                          "quicklink 7: keyword \u{201C}a b\u{201D} has a space"])
        let m = s.matchQuicklink("WIKI pastry & bread/rye")
        t.eq(m?.link.name, "Northwind wiki"); t.eq(m?.arg, "pastry & bread/rye")
        t.eq(m?.link.link(m?.arg)?.absoluteString, "https://wiki.example.com/search?q=pastry%20%26%20bread%2Frye")
        t.eq(s.matchQuicklink("wiki")?.arg, nil)
        t.eq(s.matchQuicklink("board")?.link.link(nil)?.absoluteString, "https://example.com/board")
        t.ok(s.matchQuicklink("wikipedia x") == nil && s.matchQuicklink("") == nil)
    }

    t.test("matching") {
        let s = UserSnippets.parse(Data(good.utf8))
        t.eq(s.matchSnippets(";sig").first?.snippet.keyword, ";sig")
        t.eq(s.matchSnippets(";SIG").first?.score, 1)
        t.eq(s.matchSnippets("signature").first?.snippet.keyword, ";sig", "by title too")
        t.eq(s.matchSnippets(";r").first?.snippet.keyword, ";re")
        t.ok(s.matchSnippets("zzz").isEmpty && s.matchSnippets("").isEmpty)
        t.eq(s.matchCommands("deploy").first?.command.title, "Deploy kit")
        t.eq(s.matchCommands("ship").first?.command.title, "Deploy kit")
        t.eq(s.matchCommands("board").first?.command.title, "Open the Northwind board")
        t.ok(s.matchCommands("qqq").isEmpty)
    }

    t.test("expansion") {
        var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
        let now = utc.date(from: DateComponents(year: 2026, month: 9, day: 27, hour: 14, minute: 5))!
        let tz = TimeZone(identifier: "UTC")!
        t.eq(UserSnippets.expand("on {date} at {time}", now: now, timeZone: tz), SnippetExpansion(text: "on 2026-09-27 at 14:05", cursor: nil))
        t.eq(UserSnippets.expand("Re: {clipboard}{cursor}!", now: now, timeZone: tz, clipboard: "Northwind order"),
             SnippetExpansion(text: "Re: Northwind order!", cursor: 19))
        t.eq(UserSnippets.expand("Hi {cursor}, {cursor}bye", now: now, timeZone: tz), SnippetExpansion(text: "Hi , bye", cursor: 3), "first cursor wins")
        t.eq(UserSnippets.expand("{name} {unclosed", now: now, timeZone: tz).text, "{name} {unclosed", "unknown stays")
        t.eq(UserSnippets.expand("😀{cursor}", now: now, timeZone: tz).cursor, 2, "UTF-16 units")
        t.eq(UserSnippets.expand("{clipboard}", now: now, timeZone: tz).text, "", "no clipboard given")
        t.eq(UserSnippets.expand("{{date}}", now: now, timeZone: tz).text, "{2026-09-27}")
    }

    t.test("rows") {
        let s = UserSnippets.parse(Data(good.utf8))
        let r = snippetResult(s.snippets[0], score: 1)
        t.eq(r.id, "snippet:;sig")
        t.eq(r.title, "Signature")
        t.eq(r.subtitle, ";sig · alex")
        t.eq(r.section, .snippets)
        let c = userCommandResult(s.commands[1], score: 0.9)
        t.eq(c.kind, "user-command")
        t.eq(c.section, .commands)
        t.eq(c.icon, .symbol("terminal"))
        t.eq(c.payload["run"], "shell")
        t.eq(c.payload["confirm"], "Run \u{201C}make deploy\u{201D}?")
        t.ok(userCommandResult(s.commands[0], score: 1).payload["confirm"] == nil)
    }
}
