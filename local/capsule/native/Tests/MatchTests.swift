// capsule-suite: matchSuite
let matchSuite = Suite("match") { t in
    t.test("tiers") {
        t.eq(Match.score("safari", "Safari"), 1)
        t.eq(Match.score("saf", "Safari"), 0.9)
        t.eq(Match.score("code", "Visual Studio Code"), 0.8)
        t.eq(Match.score("vsc", "Visual Studio Code"), 0.8)
        t.eq(Match.score("studio c", "Visual Studio Code"), 0.5)
        t.eq(Match.score("vscd", "Visual Studio Code"), 0.3)
        t.eq(Match.score("zzz", "Safari"), 0)
    }
    t.test("camelCase and accents") {
        t.eq(Match.words("VisualStudio Code"), ["visual", "studio", "code"])
        t.eq(Match.score("cafe", "Café"), 1)
    }
    t.test("synonyms count a little less") { t.eq(Match.score("wifi", "Network", synonyms: ["wifi"]), 0.95) }
    t.test("short queries match like Spotlight: prefix, word start and initials only") {
        let names = ["Safari", "Notes", "Calendar", "Reminders", "Screen Sharing", "System Settings", "Visual Studio Code"]
        func hits(_ q: String) -> [String] { names.filter { Match.score(q, $0) > 0 }.sorted { Match.score(q, $0) > Match.score(q, $1) } }
        t.eq(hits("sa"), ["Safari"])
        t.eq(hits("ss"), ["Screen Sharing", "System Settings"], "initials")
        t.eq(hits("vsc"), ["Visual Studio Code"], "initials, three letters")
        t.eq(hits("s"), ["Safari", "Screen Sharing", "System Settings", "Visual Studio Code"].filter { Match.score("s", $0) > 0 })
        t.eq(Match.score("es", "Notes"), 0, "a substring under three letters is not a match")
        t.ok(Match.score("ote", "Notes") > 0, "three letters: substring counts")
        t.ok(Match.score("nts", "Notes") > 0, "three letters: in-order letters count, lowest")
    }
}
